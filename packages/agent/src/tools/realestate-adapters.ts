/**
 * LangChain adapters para tools del dominio inmobiliario:
 *   - telegram_send_message_to_contact (real)
 *   - easybroker_search_listings, easybroker_search_closed_deals (real, read-only)
 *   - easybroker_create_listing, easybroker_upload_images (stub HTTP, write)
 *   - bigquery_lookup_local_comparables (real, sobre bigquery_run_query)
 *   - generate_document_from_template (real: DOCX desde account_assets)
 *   - image_watermark (stub: necesita asset por tenant)
 *   - ungga_publish_listing (API interna o fallback CLI/Playwright a borrador HITL)
 *
 * Las tools marcadas como stub siguen el patrón
 * `{ status: "not_configured", hint: ... }` en vez de fallar, para que el
 * agente pueda informar al humano y pedir el dato faltante en lenguaje
 * natural sin romper el turno.
 *
 * El handler de Telegram outbound vive aquí pero requiere una callback
 * `sendTelegram` inyectada vía deps (no podemos importar `apps/web` desde
 * `packages/agent/`). El layer caller (graph.ts wiring) provee la callback.
 */
import { tool } from "@langchain/core/tools";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import Docxtemplater from "docxtemplater";
import PizZip from "pizzip";
import { z } from "zod";
import {
  createToolCall,
  listAccountAssets,
  updateToolCallStatus,
  getOperationalCase,
  insertOperationalCaseEvent,
  updateOperationalCase,
} from "@agents/db";
import type { ToolContext } from "./tool-context";
import {
  ACCOUNT_TOOL_PROVIDERS_REALESTATE,
  markAccountSecretFailure,
  markAccountSecretSuccess,
  resolveEasyBrokerCredentials,
  resolveEasyBrokerWebCredentials,
  resolveUnggaCliCredentials,
  resolveUnggaCredentials,
} from "./realestate-credentials";
import type {
  EasyBrokerCredentials,
  EasyBrokerWebCredentials,
  UnggaCliCredentials,
} from "./realestate-credentials";
import type { NotifyUserFn } from "./operational-cases-adapters";

const execFileAsync = promisify(execFile);

export interface RealEstateToolDeps {
  /**
   * Envía un mensaje de Telegram a un chat_id arbitrario. La implementación
   * vive en `apps/web/src/lib/telegram/send-message.ts`. Si lanza, el wrapper
   * registra el fallo y devuelve `{ ok: false, error }` al modelo.
   */
  sendTelegramMessage?: (chatId: number, text: string) => Promise<void>;
  /** Notifica al inmobiliario (web/Telegram según preferencias). */
  notifyUser?: NotifyUserFn;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function addRealEstateTools(
  ctx: ToolContext,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: any[],
  deps: RealEstateToolDeps = {}
): void {
  if (toolEnabled("telegram_send_message_to_contact", ctx)) {
    tools.push(
      tool(
        async (input: {
          chat_id: number;
          text: string;
          case_id?: string;
          purpose?: string;
        }) => {
          const record = await createToolCall(
            ctx.db,
            ctx.sessionId,
            "telegram_send_message_to_contact",
            input as unknown as Record<string, unknown>,
            true,
            ctx.turnId
          );
          if (!deps.sendTelegramMessage) {
            const out = {
              ok: false,
              status: "not_configured",
              hint: "Telegram send is not wired in this runtime (deps.sendTelegramMessage missing). Configure runAgent caller to pass it.",
            };
            await updateToolCallStatus(ctx.db, record.id, "failed", out);
            return JSON.stringify(out);
          }
          try {
            await deps.sendTelegramMessage(input.chat_id, input.text);
          } catch (e) {
            const out = { ok: false, error: (e as Error).message ?? String(e) };
            await updateToolCallStatus(ctx.db, record.id, "failed", out);
            return JSON.stringify(out);
          }

          // Si hay case_id, asociamos el chat al caso (idempotente) y
          // registramos un evento `reminder_sent` (o el purpose dado).
          if (input.case_id) {
            try {
              const opCase = await getOperationalCase(ctx.db, input.case_id);
              if (opCase && opCase.user_id === ctx.userId) {
                const currentChatId =
                  (opCase.external_contact_jsonb as Record<string, unknown>)
                    ?.chat_id;
                const chatIdMatches =
                  currentChatId !== undefined &&
                  String(currentChatId) === String(input.chat_id);
                if (!chatIdMatches) {
                  await updateOperationalCase(
                    ctx.db,
                    opCase.id,
                    opCase.version,
                    {
                      externalContact: {
                        ...(opCase.external_contact_jsonb as import("@agents/types").OperationalCaseExternalContact),
                        channel: "telegram",
                        chat_id: input.chat_id,
                      },
                    }
                  );
                }
                await insertOperationalCaseEvent(ctx.db, {
                  caseId: opCase.id,
                  eventType: "reminder_sent",
                  actor: "agent",
                  payload: {
                    channel: "telegram",
                    chat_id: input.chat_id,
                    purpose: input.purpose ?? "outbound",
                    text_preview: input.text.slice(0, 200),
                  },
                });
              }
            } catch (e) {
              console.warn(
                "[realestate] telegram_send: case wiring failed:",
                e
              );
            }
          }

          const out = { ok: true, chat_id: input.chat_id };
          await updateToolCallStatus(ctx.db, record.id, "executed", out);
          return JSON.stringify(out);
        },
        {
          name: "telegram_send_message_to_contact",
          description:
            "Sends a Telegram message to an external contact's chat_id (NOT the inmobiliario).",
          schema: z.object({
            chat_id: z.number().int(),
            text: z.string().min(1).max(4096),
            case_id: z.string().min(1).optional(),
            purpose: z.string().min(1).optional(),
          }),
        }
      )
    );
  }

  // ── EasyBroker (read) — búsqueda real read-only ────────────────────
  if (toolEnabled("easybroker_search_listings", ctx)) {
    tools.push(makeEasyBrokerSearchTool(ctx, "easybroker_search_listings"));
  }
  if (toolEnabled("easybroker_search_closed_deals", ctx)) {
    tools.push(makeEasyBrokerSearchTool(ctx, "easybroker_search_closed_deals"));
  }

  // ── EasyBroker (write) — stubs que requieren HITL ───────────────────
  if (toolEnabled("easybroker_create_listing", ctx)) {
    tools.push(makeEasyBrokerWriteStub(ctx, "easybroker_create_listing"));
  }
  if (toolEnabled("easybroker_upload_images", ctx)) {
    tools.push(makeEasyBrokerWriteStub(ctx, "easybroker_upload_images"));
  }

  // ── BigQuery comparables ────────────────────────────────────────────
  if (toolEnabled("bigquery_lookup_local_comparables", ctx)) {
    tools.push(
      tool(
        async (input: {
          zona?: string;
          operation?: "sale" | "rent";
          property_type?: string;
          min_area_m2?: number;
          max_area_m2?: number;
          months_back?: number;
          limit?: number;
        }) => {
          const record = await createToolCall(
            ctx.db,
            ctx.sessionId,
            "bigquery_lookup_local_comparables",
            input as unknown as Record<string, unknown>,
            false,
            ctx.turnId
          );
          // Esta tool es un convenience wrapper sobre bigquery_run_query.
          // En vez de duplicar la implementación, devolvemos el SQL
          // sugerido + parámetros para que el agente (o una pasada
          // posterior) lo ejecute via la tool BigQuery existente. Cuando
          // exista la tabla canónica de deals cerrados confirmaremos el
          // shape y haremos que esta tool ejecute la query directamente.
          const out = {
            status: "not_configured",
            hint:
              "Esta tool requiere confirmar qué tablas en BigQuery contienen propiedades cerradas con (zona, precio, m², fecha_cierre). Hasta que tengas eso, usa bigquery_run_query con un SELECT manual, o llama a easybroker_search_closed_deals.",
            suggested_filters: {
              zona: input.zona,
              operation: input.operation,
              property_type: input.property_type,
              min_area_m2: input.min_area_m2,
              max_area_m2: input.max_area_m2,
              months_back: input.months_back ?? 12,
              limit: input.limit ?? 25,
            },
          };
          await updateToolCallStatus(
            ctx.db,
            record.id,
            "executed",
            out as unknown as Record<string, unknown>
          );
          return JSON.stringify(out);
        },
        {
          name: "bigquery_lookup_local_comparables",
          description:
            "Looks up closed real estate deals in the Ungga warehouse (BigQuery) for comparables.",
          schema: z.object({
            zona: z.string().min(1).optional(),
            operation: z.enum(["sale", "rent"]).optional(),
            property_type: z.string().min(1).optional(),
            min_area_m2: z.number().positive().optional(),
            max_area_m2: z.number().positive().optional(),
            months_back: z.number().int().positive().max(36).optional(),
            limit: z.number().int().positive().max(100).optional(),
          }),
        }
      )
    );
  }

  // ── Generate document — render DOCX desde plantilla por cuenta ─────
  if (toolEnabled("generate_document_from_template", ctx)) {
    tools.push(
      tool(
        async (input: {
          template_slug: string;
          asset_key?: string;
          format: "docx" | "pdf";
          data: Record<string, unknown>;
          case_id?: string;
        }) => {
          const record = await createToolCall(
            ctx.db,
            ctx.sessionId,
            "generate_document_from_template",
            input as unknown as Record<string, unknown>,
            true,
            ctx.turnId
          );
          try {
            const out = await renderDocumentFromTemplate(ctx, input);
            await updateToolCallStatus(ctx.db, record.id, "executed", out);
            if (input.case_id && out.ok) {
              await insertOperationalCaseEvent(ctx.db, {
                caseId: input.case_id,
                eventType: "state_changed",
                actor: "agent",
                payload: {
                  tool: "generate_document_from_template",
                  output_bucket: out.output_bucket,
                  output_path: out.output_path,
                  template_asset_key: out.template_asset_key,
                  format: out.format,
                },
              });
            }
            return JSON.stringify(out);
          } catch (e) {
            const out = {
              ok: false,
              status: "failed",
              error: e instanceof Error ? e.message : String(e),
            };
            await updateToolCallStatus(ctx.db, record.id, "failed", out);
            return JSON.stringify(out);
          }
        },
        {
          name: "generate_document_from_template",
          description:
            "Renders a DOCX document from a tenant-scoped template stored in account_assets.",
          schema: z.object({
            template_slug: z.string().min(1),
            asset_key: z.string().min(1).optional(),
            format: z.enum(["docx", "pdf"]),
            data: z.record(z.string(), z.any()),
            case_id: z.string().min(1).optional(),
          }),
        }
      )
    );
  }

  // ── Image watermark — stub que indica asset faltante ───────────────
  if (toolEnabled("image_watermark", ctx)) {
    tools.push(
      tool(
        async (input: {
          input_paths: string[];
          position?: string;
          opacity?: number;
          scale?: number;
        }) => {
          const record = await createToolCall(
            ctx.db,
            ctx.sessionId,
            "image_watermark",
            input as unknown as Record<string, unknown>,
            false,
            ctx.turnId
          );
          const out = {
            status: "not_configured",
            hint:
              "El asset PNG del watermark del tenant no está cargado. Necesito el PNG con transparencia, opacidad y posición preferida. Una vez cargado, este handler usa Sharp para componer y devuelve los paths salida.",
            received_inputs: input.input_paths.length,
            position: input.position ?? "bottom-right",
            opacity: input.opacity ?? 0.6,
            scale: input.scale ?? 0.18,
          };
          await updateToolCallStatus(
            ctx.db,
            record.id,
            "executed",
            out as unknown as Record<string, unknown>
          );
          return JSON.stringify(out);
        },
        {
          name: "image_watermark",
          description: "Applies the tenant watermark to property photos.",
          schema: z.object({
            input_paths: z.array(z.string().min(1)).min(1),
            position: z
              .enum(["bottom-right", "bottom-left", "top-right", "top-left", "center"])
              .optional(),
            opacity: z.number().min(0).max(1).optional(),
            scale: z.number().min(0.05).max(0.5).optional(),
          }),
        }
      )
    );
  }

  // ── Ungga publish — prepare_draft (HITL) + publish_draft (post-aprobación) ─
  if (toolEnabled("ungga_publish_listing", ctx)) {
    const unggaPublishSchema = z
      .object({
        action: z
          .enum(["prepare_draft", "publish_draft"])
          .default("prepare_draft")
          .describe(
            "prepare_draft: llena wizard y guarda borrador (requiere revisión HITL). publish_draft: publica un borrador ya aprobado usando ungga_property_id o draft_url."
          ),
        ungga_property_id: z.string().min(1).optional(),
        draft_url: z.string().url().optional(),
        title: z.string().min(1).optional(),
        description: z.string().optional(),
        operation: z.string().min(1).optional(),
        property_type: z.string().min(1).optional(),
        price: z.number().positive().optional(),
        currency: z.string().optional(),
        construction_m2: z.number().positive().optional(),
        land_m2: z.number().positive().optional(),
        land_unit: z.string().optional(),
        condition: z.string().optional(),
        age_range: z.string().optional(),
        country: z.string().optional(),
        address: z.string().optional(),
        location: z.record(z.string(), z.any()).optional(),
        bedrooms: z.number().nonnegative().optional(),
        bathrooms_full: z.number().nonnegative().optional(),
        bathrooms_half: z.number().nonnegative().optional(),
        parking_spaces: z.number().nonnegative().optional(),
        covered_parking: z.boolean().optional(),
        floor: z.string().optional(),
        location_type: z.string().optional(),
        current_status: z.string().optional(),
        amenities: z.array(z.string()).optional(),
        video_url: z.string().optional(),
        tour_url: z.string().optional(),
        operations: z
          .array(
            z.object({
              type: z.enum(["sale", "rent", "rent_temporary", "presale"]),
              price: z.number().positive(),
              currency: z.string().optional(),
            })
          )
          .optional(),
        image_urls: z.array(z.string().url()).optional(),
        case_id: z.string().min(1).optional(),
      })
      .superRefine((data, ctx) => {
        if (data.action === "publish_draft") {
          if (!resolveUnggaPropertyId(data)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message:
                "publish_draft requires ungga_property_id or draft_url pointing to /app/propiedades/{GU-ID}",
              path: ["ungga_property_id"],
            });
          }
          return;
        }
        if (!data.title?.trim()) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "prepare_draft requires title",
            path: ["title"],
          });
        }
        if (!data.operation?.trim()) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "prepare_draft requires operation",
            path: ["operation"],
          });
        }
        if (!data.property_type?.trim()) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "prepare_draft requires property_type",
            path: ["property_type"],
          });
        }
        if (data.price == null || !(data.price > 0)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "prepare_draft requires a positive price",
            path: ["price"],
          });
        }
      });

    tools.push(
      tool(
        async (input: Record<string, unknown>) => {
          const record = await createToolCall(
            ctx.db,
            ctx.sessionId,
            "ungga_publish_listing",
            input,
            true,
            ctx.turnId
          );
          const out = await executeUnggaPublishListing(ctx, input, deps);
          await updateToolCallStatus(
            ctx.db,
            record.id,
            out.ok ? "executed" : "failed",
            out as unknown as Record<string, unknown>
          );
          return JSON.stringify(out);
        },
        {
          name: "ungga_publish_listing",
          description:
            "Ungga listing in two phases on the same tool: action=prepare_draft creates a draft for human review (HITL); after approval, action=publish_draft publishes that draft using ungga_property_id or draft_url. CLI fallback uses Playwright; internal API when configured.",
          schema: unggaPublishSchema,
        }
      )
    );
  }
}

// ============================================================
// Helpers
// ============================================================

async function executeUnggaPublishListing(
  ctx: ToolContext,
  input: Record<string, unknown>,
  deps: RealEstateToolDeps
): Promise<Record<string, unknown>> {
  const action =
    typeof input.action === "string" && input.action.trim()
      ? input.action.trim()
      : "prepare_draft";

  const forceCliDryRun = envFlagEnabled("UNGGA_TOOL_TEST_DRY_RUN") === true;
  const apiCreds = forceCliDryRun ? null : await resolveUnggaCredentials(ctx);
  if (apiCreds) {
    try {
      const apiBase = apiCreds.apiBase.replace(/\/$/, "");
      const propertyId = resolveUnggaPropertyId(input);
      const endpoint =
        action === "publish_draft" && propertyId
          ? `${apiBase}/v1/internal/listings/${encodeURIComponent(propertyId)}/publish`
          : `${apiBase}/v1/internal/listings`;
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiCreds.apiToken}`,
        },
        body: JSON.stringify(input),
      });
      const text = await res.text();
      const data = (() => {
        try {
          return JSON.parse(text);
        } catch {
          return { raw: text };
        }
      })();
      const out: Record<string, unknown> = {
        ok: res.ok,
        action,
        phase: action,
        mode: "api",
        status: res.ok
          ? action === "publish_draft"
            ? "published"
            : "draft_created"
          : "failed",
        status_code: res.status,
        data,
        credential_source: apiCreds.source,
      };
      if (action === "publish_draft" && propertyId) {
        out.ungga_property_id = propertyId;
        out.published_url = buildUnggaPropertyUrl(propertyId);
      }
      if (action === "prepare_draft" && res.ok) {
        out.requires_human_review = true;
        const draftId =
          typeof data === "object" &&
          data &&
          "ungga_property_id" in data &&
          typeof (data as { ungga_property_id?: string }).ungga_property_id ===
            "string"
            ? (data as { ungga_property_id: string }).ungga_property_id
            : null;
        if (draftId) {
          out.ungga_property_id = draftId;
          out.draft_url = buildUnggaPropertyUrl(draftId);
        }
        out.next_action = {
          action: "publish_draft",
          ungga_property_id: out.ungga_property_id ?? null,
          draft_url: out.draft_url ?? null,
          hint: "Tras aprobación HITL, invocar ungga_publish_listing con action publish_draft.",
        };
      }
      if (apiCreds.source === "account") {
        if (res.ok) {
          await markAccountSecretSuccess(
            ctx,
            ACCOUNT_TOOL_PROVIDERS_REALESTATE.ungga_api
          );
        } else {
          await markAccountSecretFailure(
            ctx,
            ACCOUNT_TOOL_PROVIDERS_REALESTATE.ungga_api,
            `HTTP ${res.status}`
          );
        }
      }
      await attachUnggaNotification(ctx, deps, input, out);
      return out;
    } catch (e) {
      const errMsg = (e as Error).message ?? String(e);
      if (apiCreds.source === "account") {
        await markAccountSecretFailure(
          ctx,
          ACCOUNT_TOOL_PROVIDERS_REALESTATE.ungga_api,
          errMsg
        );
      }
      return { ok: false, action, mode: "api", error: errMsg };
    }
  }

  const cliCreds = await resolveUnggaCliCredentials(ctx);
  const cliResult = await runUnggaCliFallback(input, cliCreds);
  if (cliResult) {
    if (cliResult.ok && cliCreds?.source === "account") {
      await markAccountSecretSuccess(
        ctx,
        ACCOUNT_TOOL_PROVIDERS_REALESTATE.ungga_cli
      );
    } else if (!cliResult.ok && cliCreds?.source === "account") {
      const err =
        typeof cliResult.error === "string"
          ? cliResult.error
          : "CLI fallback failed";
      await markAccountSecretFailure(
        ctx,
        ACCOUNT_TOOL_PROVIDERS_REALESTATE.ungga_cli,
        err
      );
    }
    await attachUnggaNotification(ctx, deps, input, cliResult);
    return cliResult;
  }

  return {
    ok: false,
    status: "not_configured",
    action,
    hint:
      "Conecta Ungga en Ajustes → Cuentas externas (automatización web con correo/contraseña) o configura la API interna. En desarrollo también sirve pocs/ungga-cli/.env.",
  };
}

function buildUnggaPropertyUrl(propertyId: string) {
  return `https://ungga.com/app/propiedades/${propertyId}`;
}

async function attachUnggaNotification(
  ctx: ToolContext,
  deps: RealEstateToolDeps,
  input: Record<string, unknown>,
  out: Record<string, unknown>
) {
  if (!deps.notifyUser || out.ok !== true) return;
  const action =
    typeof input.action === "string" && input.action.trim()
      ? input.action.trim()
      : "prepare_draft";
  const caseId =
    typeof input.case_id === "string" && input.case_id.trim()
      ? input.case_id.trim()
      : undefined;

  let text: string | null = null;
  if (action === "prepare_draft") {
    const draftUrl =
      typeof out.draft_url === "string" ? out.draft_url.trim() : "";
    if (draftUrl) {
      text = `Gu preparó el borrador en Ungga. Revisa la ficha y aprueba la publicación cuando esté listo:\n${draftUrl}`;
    }
  } else if (action === "publish_draft") {
    const publishedUrl =
      typeof out.published_url === "string" ? out.published_url.trim() : "";
    if (publishedUrl) {
      text = `La ficha ya está publicada en Ungga:\n${publishedUrl}`;
    }
  }
  if (!text) return;

  try {
    const result = await deps.notifyUser(
      ctx.db,
      ctx.userId,
      {
        text,
        kind: action === "publish_draft" ? "ungga_published" : "ungga_draft_ready",
        data: {
          ...(caseId ? { case_id: caseId } : {}),
          action,
          draft_url: out.draft_url,
          published_url: out.published_url,
          ungga_property_id: out.ungga_property_id,
        },
      },
      action === "publish_draft" ? "normal" : "high"
    );
    out.notification = {
      sent: result.delivered.length > 0,
      attempted: result.attempted,
      delivered: result.delivered,
    };
  } catch (e) {
    out.notification = {
      sent: false,
      error: (e as Error).message ?? String(e),
    };
  }
}

function resolveUnggaPropertyId(input: {
  ungga_property_id?: string;
  draft_url?: string;
}): string | null {
  const id =
    typeof input.ungga_property_id === "string"
      ? input.ungga_property_id.trim()
      : "";
  if (id) return id;
  const url = typeof input.draft_url === "string" ? input.draft_url.trim() : "";
  if (!url) return null;
  const m = url.match(/\/propiedades\/([^/?#]+)/i);
  if (!m?.[1]) return null;
  const segment = m[1];
  if (segment === "nueva" || segment === "new") return null;
  return segment;
}

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

type GenerateDocumentInput = {
  template_slug: string;
  asset_key?: string;
  format: "docx" | "pdf";
  data: Record<string, unknown>;
  case_id?: string;
};

async function renderDocumentFromTemplate(
  ctx: ToolContext,
  input: GenerateDocumentInput
): Promise<Record<string, unknown>> {
  if (input.format !== "docx") {
    return {
      ok: false,
      status: "unsupported_format",
      requested_format: input.format,
      supported_formats: ["docx"],
      hint:
        "La primera versión del renderer genera DOCX desde la plantilla cargada. La conversión PDF queda para una fase posterior con LibreOffice/API de conversión.",
    };
  }

  const templateAsset = await resolveDocumentTemplateAsset(ctx, input);
  if (!templateAsset) {
    return {
      ok: false,
      status: "not_configured",
      requested_template: input.template_slug,
      requested_asset_key: input.asset_key ?? null,
      hint:
        "No encontré una plantilla DOCX en account_assets para esta cuenta. Sube la plantilla desde Preparación operativa o pasa asset_key explícito.",
    };
  }

  const { data: templateBlob, error: downloadError } = await ctx.db.storage
    .from(templateAsset.storage_bucket)
    .download(templateAsset.storage_path);
  if (downloadError) {
    throw new Error(`No se pudo descargar la plantilla: ${downloadError.message}`);
  }
  if (!templateBlob) {
    throw new Error("No se pudo descargar la plantilla: respuesta vacía.");
  }

  const templateBuffer = Buffer.from(await templateBlob.arrayBuffer());
  const zip = new PizZip(templateBuffer);
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    delimiters: { start: "{{", end: "}}" },
  });
  doc.render(normalizeTemplateData(input.data));
  const rendered = doc.getZip().generate({
    type: "nodebuffer",
    compression: "DEFLATE",
  }) as Buffer;

  const outputPath = `${ctx.userId}/generated-documents/${safeSegment(
    input.template_slug
  )}/${Date.now()}-${safeSegment(input.case_id ?? "document")}.docx`;
  const { error: uploadError } = await ctx.db.storage
    .from(templateAsset.storage_bucket)
    .upload(outputPath, rendered, {
      contentType: DOCX_MIME,
      upsert: true,
    });
  if (uploadError) {
    throw new Error(`No se pudo guardar el documento generado: ${uploadError.message}`);
  }

  return {
    ok: true,
    status: "rendered",
    format: "docx",
    template_slug: input.template_slug,
    template_asset_key: templateAsset.asset_key,
    template_bucket: templateAsset.storage_bucket,
    template_path: templateAsset.storage_path,
    output_bucket: templateAsset.storage_bucket,
    output_path: outputPath,
    output_content_type: DOCX_MIME,
    received_fields: Object.keys(input.data),
  };
}

async function resolveDocumentTemplateAsset(
  ctx: ToolContext,
  input: GenerateDocumentInput
) {
  const candidateKeys = Array.from(
    new Set(
      [
        input.asset_key,
        input.template_slug,
        `${input.template_slug}_template`,
        "commission_contract_template",
      ]
        .map((item) => item?.trim())
        .filter((item): item is string => Boolean(item))
    )
  );
  const directMatches = await listAccountAssets(ctx.db, {
    userId: ctx.userId,
    assetKeys: candidateKeys,
  });
  for (const key of candidateKeys) {
    const match = directMatches.find((asset) => asset.asset_key === key);
    if (match) return match;
  }

  const accountAssets = await listAccountAssets(ctx.db, { userId: ctx.userId });
  return (
    accountAssets.find(
      (asset) =>
        asset.source_tool_id === "generate_document_from_template" &&
        asset.content_type === DOCX_MIME
    ) ??
    accountAssets.find(
      (asset) =>
        asset.asset_key.includes("template") && asset.content_type === DOCX_MIME
    ) ??
    null
  );
}

function normalizeTemplateData(data: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [key, templateValue(value)])
  );
}

function templateValue(value: unknown): unknown {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(templateValue).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}

function safeSegment(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "document";
}

function toolEnabled(toolId: string, ctx: ToolContext): boolean {
  if (
    ctx.activeSkillAllowedTools &&
    ctx.activeSkillAllowedTools.length > 0 &&
    !ctx.activeSkillAllowedTools.includes(toolId)
  ) {
    return false;
  }
  const setting = ctx.enabledTools.find((t) => t.tool_id === toolId);
  if (setting && setting.enabled === false) return false;
  return true;
}

type EasyBrokerSearchInput = {
  zona?: string;
  operation?: "sale" | "rent";
  operations?: Array<"sale" | "rent">;
  property_type?: string;
  property_types?: string[];
  min_price?: number;
  max_price?: number;
  min_area_m2?: number;
  max_area_m2?: number;
  bedrooms?: number;
  bathrooms?: number;
  parking_spaces?: number;
  date_from?: string;
  date_to?: string;
  page?: number;
  limit?: number;
};

type EasyBrokerRawProperty = {
  public_id?: string;
  title?: string;
  url?: string;
  location?: string | Record<string, unknown>;
  property_type?: string;
  bedrooms?: number;
  bathrooms?: number;
  parking_spaces?: number;
  lot_size?: number;
  construction_size?: number;
  updated_at?: string;
  operations?: Array<{
    type?: string;
    amount?: number;
    formatted_amount?: string;
    currency?: string;
    unit?: string;
  }>;
  title_image_full?: string;
  title_image_thumb?: string;
  show_prices?: boolean;
};

async function searchEasyBrokerProperties(
  ctx: ToolContext,
  toolId: "easybroker_search_listings" | "easybroker_search_closed_deals",
  input: EasyBrokerSearchInput,
  creds: EasyBrokerWebCredentials
): Promise<Record<string, unknown>> {
  const cliResult = await runEasyBrokerMlsCliFallback(input, toolId, creds);
  if (cliResult) return cliResult;
  return {
    ok: false,
    status: "not_configured",
    source: "easybroker_mls",
    tool: toolId,
    hint:
      "EasyBroker MLS requiere credenciales web (easybroker_web) y el POC Playwright disponible en pocs/easybroker-mls-cli.",
  };
}

async function searchEasyBrokerPropertiesApi(
  ctx: ToolContext,
  toolId: "easybroker_search_listings" | "easybroker_search_closed_deals",
  input: EasyBrokerSearchInput,
  creds: EasyBrokerCredentials
): Promise<Record<string, unknown>> {
  const isHistoricalReference = toolId === "easybroker_search_closed_deals";
  const statuses = isHistoricalReference ? ["sold", "rented"] : ["published"];
  const url = easyBrokerPropertiesUrl(input, statuses);
  const res = await fetch(url, {
    method: "GET",
    headers: {
      accept: "application/json",
      "X-Authorization": creds.apiKey,
    },
  });
  const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(
      `EasyBroker respondió ${res.status}: ${errorMessageFromPayload(payload)}`
    );
  }

  const rawContent = Array.isArray(payload.content) ? payload.content : [];
  const normalized = rawContent
    .map((item) => normalizeEasyBrokerProperty(item as EasyBrokerRawProperty))
    .filter((item) => easyBrokerPropertyMatchesInput(item, input));

  return {
    ok: true,
    status: "success",
    source: "easybroker",
    tool: toolId,
    credential_source: creds.source,
    query: {
      ...input,
      statuses,
      server_filters:
        "EasyBroker aplica page/limit, property_type y statuses. Zona/precio/m2/operación se normalizan y filtran en Gu OS cuando el endpoint no expone esos filtros directamente.",
    },
    pagination: payload.pagination ?? null,
    count: normalized.length,
    results: normalized,
    caveat: isHistoricalReference
      ? "Estas propiedades están marcadas como sold/rented en EasyBroker. El precio puede ser el publicado o capturado en la propiedad; no se garantiza que sea el precio final real de cierre."
      : "Estas son propiedades activas/publicadas similares para referencia de mercado actual.",
  };
}

async function runEasyBrokerMlsCliFallback(
  input: EasyBrokerSearchInput,
  toolId: "easybroker_search_listings" | "easybroker_search_closed_deals",
  creds: EasyBrokerWebCredentials
): Promise<Record<string, unknown> | null> {
  const pocDir = await resolveEasyBrokerMlsCliDir();
  if (!(await fileExists(path.join(pocDir, "src", "search-mls.mjs")))) {
    return null;
  }

  const tempDir = await mkdtemp(path.join(tmpdir(), "easybroker-mls-"));
  const inputPath = path.join(tempDir, "query.json");
  const cliInput = {
    ...input,
    tool_id: toolId,
    mode:
      toolId === "easybroker_search_closed_deals"
        ? "closed_deals"
        : "listings",
    mls_url: creds.loginUrl,
  };
  await writeFile(inputPath, JSON.stringify(cliInput), "utf8");

  try {
    const timeout = Number(process.env.EASYBROKER_MLS_TIMEOUT_MS ?? "120000");
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["src/search-mls.mjs", inputPath],
      {
        cwd: pocDir,
        timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : 120_000,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          ...process.env,
          EASYBROKER_WEB_URL: creds.loginUrl,
          EASYBROKER_WEB_EMAIL: creds.email,
          EASYBROKER_WEB_PASSWORD: creds.password,
          EASYBROKER_MLS_HEADLESS: process.env.EASYBROKER_MLS_HEADLESS ?? "false",
        },
      }
    );
    const parsed = parseCliJson(stdout);
    return buildEasyBrokerMlsToolResponse(toolId, input, parsed, stderr, creds.source);
  } catch (err) {
    const error = err as {
      message?: string;
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    const parsed = error.stdout ? parseCliJson(error.stdout) : null;
    return {
      ok: false,
      status: "failed",
      source: "easybroker_mls",
      mode: "web_mls",
      tool: toolId,
      exit_code: error.code,
      error: error.message ?? String(err),
      ...(parsed ? { cli_result: parsed } : {}),
      ...(error.stderr?.trim()
        ? { stderr: error.stderr.trim().slice(0, 2000) }
        : {}),
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function resolveEasyBrokerMlsCliDir() {
  const configured = process.env.EASYBROKER_MLS_CLI_DIR?.trim();
  if (configured) return configured;
  const cwd = process.cwd();
  const candidates = [
    path.resolve(cwd, "pocs", "easybroker-mls-cli"),
    path.resolve(cwd, "..", "pocs", "easybroker-mls-cli"),
    path.resolve(cwd, "..", "..", "pocs", "easybroker-mls-cli"),
  ];
  for (const candidate of candidates) {
    if (await fileExists(path.join(candidate, "src", "search-mls.mjs"))) {
      return candidate;
    }
  }
  return candidates[0];
}

function buildEasyBrokerMlsToolResponse(
  toolId: "easybroker_search_listings" | "easybroker_search_closed_deals",
  input: EasyBrokerSearchInput,
  parsed: Record<string, unknown>,
  stderr: string,
  credentialSource: "account" | "env"
): Record<string, unknown> {
  const isHistoricalReference = toolId === "easybroker_search_closed_deals";
  const cliResult =
    parsed.result && typeof parsed.result === "object"
      ? (parsed.result as Record<string, unknown>)
      : {};
  const rawResults = Array.isArray(cliResult.results) ? cliResult.results : [];
  const normalized = rawResults.filter((item) =>
    easyBrokerPropertyMatchesInput(item as ReturnType<typeof normalizeEasyBrokerProperty>, input)
  );
  const filteredCliResult = {
    ...parsed,
    result: {
      ...cliResult,
      raw_count: rawResults.length,
      count: normalized.length,
      results: normalized,
    },
  };
  return {
    ok: parsed.ok === true,
    status: parsed.ok === true ? "success" : "failed",
    source: "easybroker_mls",
    mode: "web_mls",
    tool: toolId,
    credential_source: credentialSource,
    query: {
      ...input,
      backend:
        "EasyBroker MLS web (/agent/mls_properties). Se aplican filtros en UI cuando existen y se normaliza/filtra de nuevo en Gu OS.",
      historical_status_filter:
        isHistoricalReference
          ? "Intento de buscar cerradas/rentadas históricas en MLS; depende de que la UI exponga esos estados."
          : null,
    },
    count: normalized.length,
    results: normalized,
    caveat: isHistoricalReference
      ? "La búsqueda intenta usar propiedades vendidas/rentadas/cerradas en EasyBroker MLS cuando la UI lo permite. El precio visible puede ser precio publicado o capturado, no necesariamente precio final real de cierre."
      : "Resultados provenientes de EasyBroker MLS/bolsa inmobiliaria, filtrados por características del caso.",
    cli_result: filteredCliResult,
    ...(stderr.trim() ? { stderr: stderr.trim().slice(0, 2000) } : {}),
  };
}

function easyBrokerPropertiesUrl(input: EasyBrokerSearchInput, statuses: string[]) {
  const base = process.env.EASYBROKER_API_BASE?.trim() || "https://api.easybroker.com";
  const url = new URL("/v1/properties", base.replace(/\/$/, ""));
  url.searchParams.set("page", String(input.page ?? 1));
  url.searchParams.set("limit", String(Math.min(input.limit ?? 20, 50)));
  for (const status of statuses) {
    url.searchParams.append("search[statuses][]", status);
  }
  const propertyTypes = [
    ...(input.property_type?.trim() ? [input.property_type.trim()] : []),
    ...(Array.isArray(input.property_types) ? input.property_types : []),
  ]
    .map((value) => value.trim())
    .filter(Boolean);
  for (const propertyType of Array.from(new Set(propertyTypes))) {
    url.searchParams.append("search[property_types][]", propertyType);
  }
  return url;
}

function normalizeEasyBrokerProperty(item: EasyBrokerRawProperty) {
  const operation = selectEasyBrokerOperation(item.operations);
  const areaM2 = numericOrNull(item.construction_size) ?? numericOrNull(item.lot_size);
  const price = numericOrNull(operation?.amount);
  return {
    source: "easybroker",
    id: item.public_id ?? null,
    title: item.title ?? null,
    url: item.url ?? null,
    location: normalizeEasyBrokerLocation(item.location),
    property_type: item.property_type ?? null,
    operation: operation?.type === "rental" ? "rent" : operation?.type ?? null,
    price,
    formatted_price: operation?.formatted_amount ?? null,
    currency: operation?.currency ?? null,
    area_m2: areaM2,
    price_per_m2: price && areaM2 ? Math.round(price / areaM2) : null,
    bedrooms: numericOrNull(item.bedrooms),
    bathrooms: numericOrNull(item.bathrooms),
    parking_spaces: numericOrNull(item.parking_spaces),
    updated_at: item.updated_at ?? null,
    image_url: item.title_image_full ?? item.title_image_thumb ?? null,
    show_prices: item.show_prices ?? null,
  };
}

function selectEasyBrokerOperation(operations: EasyBrokerRawProperty["operations"]) {
  if (!Array.isArray(operations) || operations.length === 0) return null;
  return operations.find((operation) => operation.amount) ?? operations[0] ?? null;
}

function normalizeEasyBrokerLocation(location: EasyBrokerRawProperty["location"]) {
  if (!location) return null;
  if (typeof location === "string") return location;
  return [
    location.city_area,
    location.city,
    location.region,
    location.street,
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(", ");
}

function easyBrokerPropertyMatchesInput(
  property: ReturnType<typeof normalizeEasyBrokerProperty>,
  input: EasyBrokerSearchInput
) {
  if (input.zona?.trim()) {
    const haystack = `${property.location ?? ""} ${property.title ?? ""}`.toLowerCase();
    const tokens = input.zona
      .toLowerCase()
      .split(/[,\s]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3);
    if (tokens.length > 0 && !tokens.some((token) => haystack.includes(token))) {
      return false;
    }
  }
  const operations = [
    ...(input.operation ? [input.operation] : []),
    ...(Array.isArray(input.operations) ? input.operations : []),
  ];
  if (operations.length > 0 && property.operation) {
    const allowed = new Set(operations);
    if (!allowed.has(property.operation as "sale" | "rent")) return false;
  }
  if (input.min_price != null && property.price != null && property.price < input.min_price) {
    return false;
  }
  if (input.max_price != null && property.price != null && property.price > input.max_price) {
    return false;
  }
  if (
    input.min_area_m2 != null &&
    property.area_m2 != null &&
    property.area_m2 < input.min_area_m2
  ) {
    return false;
  }
  if (
    input.max_area_m2 != null &&
    property.area_m2 != null &&
    property.area_m2 > input.max_area_m2
  ) {
    return false;
  }
  if (input.date_from && property.updated_at && property.updated_at < input.date_from) {
    return false;
  }
  if (input.date_to && property.updated_at && property.updated_at > input.date_to) {
    return false;
  }
  return true;
}

function numericOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function errorMessageFromPayload(payload: Record<string, unknown>) {
  const error = payload.error ?? payload.message ?? payload.errors;
  if (typeof error === "string") return error;
  if (error) return JSON.stringify(error);
  return "error sin detalle";
}

function makeEasyBrokerSearchTool(
  ctx: ToolContext,
  toolId: "easybroker_search_listings" | "easybroker_search_closed_deals"
) {
  return tool(
    async (input: EasyBrokerSearchInput) => {
      const record = await createToolCall(
        ctx.db,
        ctx.sessionId,
        toolId,
        input as unknown as Record<string, unknown>,
        false,
        ctx.turnId
      );
      const creds = await resolveEasyBrokerWebCredentials(ctx);
      if (!creds) {
        const out = {
          status: "not_configured",
          hint:
            "EasyBroker MLS no está conectado para esta cuenta. Conecta EasyBroker MLS (automatización web) con email/password para buscar en la bolsa inmobiliaria.",
        };
        await updateToolCallStatus(
          ctx.db,
          record.id,
          "executed",
          out as unknown as Record<string, unknown>
        );
        return JSON.stringify(out);
      }
      try {
        const out = await searchEasyBrokerProperties(ctx, toolId, input, creds);
        await markAccountSecretSuccess(
          ctx,
          ACCOUNT_TOOL_PROVIDERS_REALESTATE.easybroker_web
        );
        await updateToolCallStatus(ctx.db, record.id, "executed", out);
        return JSON.stringify(out);
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        if (creds.source === "account") {
          await markAccountSecretFailure(
            ctx,
            ACCOUNT_TOOL_PROVIDERS_REALESTATE.easybroker_web,
            errorMessage
          );
        }
        const out = {
          ok: false,
          status: "failed",
          error: errorMessage,
        };
        await updateToolCallStatus(ctx.db, record.id, "failed", out);
        return JSON.stringify(out);
      }
    },
    {
      name: toolId,
      description:
        toolId === "easybroker_search_listings"
          ? "Searches active/published EasyBroker listings for market comparables (read-only)."
          : "Searches EasyBroker properties marked sold/rented for historical reference (read-only; not guaranteed final closing prices).",
      schema: z.object({
        zona: z.string().optional(),
        operation: z.enum(["sale", "rent"]).optional(),
        operations: z.array(z.enum(["sale", "rent"])).optional(),
        property_type: z.string().optional(),
        property_types: z.array(z.string()).optional(),
        min_price: z.number().nonnegative().optional(),
        max_price: z.number().nonnegative().optional(),
        min_area_m2: z.number().nonnegative().optional(),
        max_area_m2: z.number().nonnegative().optional(),
        bedrooms: z.number().nonnegative().optional(),
        bathrooms: z.number().nonnegative().optional(),
        parking_spaces: z.number().nonnegative().optional(),
        date_from: z.string().optional(),
        date_to: z.string().optional(),
        page: z.number().int().positive().optional(),
        limit: z.number().int().positive().max(50).optional(),
      }),
    }
  );
}

function makeEasyBrokerWriteStub(
  ctx: ToolContext,
  toolId: "easybroker_create_listing" | "easybroker_upload_images"
) {
  return tool(
    async (input: Record<string, unknown>) => {
      const record = await createToolCall(
        ctx.db,
        ctx.sessionId,
        toolId,
        input,
        true,
        ctx.turnId
      );
      const creds = await resolveEasyBrokerCredentials(ctx);
      if (!creds) {
        const out = {
          status: "not_configured",
          hint:
            "EasyBroker no está conectado para esta cuenta. Conéctalo desde Ajustes → Cuentas externas antes de publicar.",
        };
        await updateToolCallStatus(
          ctx.db,
          record.id,
          "failed",
          out as unknown as Record<string, unknown>
        );
        return JSON.stringify(out);
      }
      const out = {
        status: "stub",
        credential_source: creds.source,
        hint:
          "Stub: cuando esté la docs de EasyBroker mapeada (POST /properties, POST /properties/:id/images), este handler hace la llamada real. HITL ya está aplicado por risk='high'.",
        received: Object.keys(input),
      };
      await updateToolCallStatus(
        ctx.db,
        record.id,
        "executed",
        out as unknown as Record<string, unknown>
      );
      return JSON.stringify(out);
    },
    {
      name: toolId,
      description:
        toolId === "easybroker_create_listing"
          ? "Creates an EasyBroker listing (write, HITL)."
          : "Uploads images to an EasyBroker listing (write, HITL).",
      schema:
        toolId === "easybroker_create_listing"
          ? z.object({
              title: z.string().min(1),
              description: z.string().optional(),
              operation: z.enum(["sale", "rent"]),
              property_type: z.string().min(1),
              price: z.number().nonnegative(),
              currency: z.string().optional(),
              location: z
                .object({
                  street: z.string().optional(),
                  exterior_number: z.string().optional(),
                  neighborhood: z.string().optional(),
                  city: z.string().optional(),
                  state: z.string().optional(),
                  country: z.string().optional(),
                  postal_code: z.string().optional(),
                  latitude: z.number().optional(),
                  longitude: z.number().optional(),
                })
                .optional(),
              area_m2: z.number().nonnegative().optional(),
              bedrooms: z.number().nonnegative().optional(),
              bathrooms: z.number().nonnegative().optional(),
              parking: z.number().nonnegative().optional(),
              case_id: z.string().optional(),
              custom_fields_json: z
                .string()
                .optional()
                .describe(
                  "Optional JSON string with tenant-specific EasyBroker fields."
                ),
            })
          : z.object({
              listing_id: z.string().min(1),
              image_paths: z.array(z.string().min(1)).min(1),
              case_id: z.string().optional(),
            }),
    }
  );
}

function envFlagEnabled(name: string) {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return null;
  return raw === "1" || raw === "true" || raw === "yes";
}

async function fileExists(pathname: string) {
  try {
    await access(pathname);
    return true;
  } catch {
    return false;
  }
}

async function cliEnabled(pocDir: string) {
  const explicit = envFlagEnabled("UNGGA_CLI_ENABLED");
  if (explicit != null) return explicit;
  // Local POC convenience: when running dev without wiring the web process env,
  // allow the child CLI to load pocs/ungga-cli/.env via dotenv/config.
  if (process.env.NODE_ENV === "production") return false;
  return fileExists(path.join(pocDir, ".env"));
}

async function resolveUnggaCliDir() {
  const configured = process.env.UNGGA_CLI_DIR?.trim();
  if (configured) return configured;
  const cwd = process.cwd();
  const candidates = [
    path.resolve(cwd, "pocs", "ungga-cli"),
    path.resolve(cwd, "..", "pocs", "ungga-cli"),
    path.resolve(cwd, "..", "..", "pocs", "ungga-cli"),
  ];
  for (const candidate of candidates) {
    if (await fileExists(path.join(candidate, "src", "publish-listing.mjs"))) {
      return candidate;
    }
  }
  return candidates[0];
}

async function runUnggaCliFallback(
  input: Record<string, unknown>,
  cliCreds: UnggaCliCredentials | null
): Promise<Record<string, unknown> | null> {
  const pocDir = await resolveUnggaCliDir();
  const pocEnvAvailable = await fileExists(path.join(pocDir, ".env"));
  const hasAccountCli = Boolean(cliCreds?.email && cliCreds.password);
  const cliAllowed =
    hasAccountCli ||
    (await cliEnabled(pocDir)) ||
    (process.env.NODE_ENV !== "production" && pocEnvAvailable);
  if (!cliAllowed) return null;

  if (!hasAccountCli) {
    const required = [
      "UNGGA_STAGING_URL",
      "UNGGA_STAGING_EMAIL",
      "UNGGA_STAGING_PASSWORD",
    ];
    const missing = required.filter((name) => !process.env[name]?.trim());
    if (missing.length > 0 && !pocEnvAvailable) {
      return {
        ok: false,
        status: "not_configured",
        mode: "cli",
        error: `Missing env for Ungga CLI fallback: ${missing.join(", ")}. Connect Ungga (automatización web) per-account or provide ${path.join(pocDir, ".env")}.`,
      };
    }
  }

  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  if (cliCreds) {
    childEnv.UNGGA_STAGING_URL = cliCreds.loginUrl;
    childEnv.UNGGA_STAGING_EMAIL = cliCreds.email;
    childEnv.UNGGA_STAGING_PASSWORD = cliCreds.password;
    childEnv.UNGGA_CLI_ENABLED = "true";
  }
  if (envFlagEnabled("UNGGA_TOOL_TEST_DRY_RUN")) {
    childEnv.UNGGA_CLI_DRY_RUN = "true";
  }

  const tempDir = await mkdtemp(path.join(tmpdir(), "ungga-cli-"));
  const inputPath = path.join(tempDir, "listing.json");
  await writeFile(inputPath, JSON.stringify(input), "utf8");

  try {
    const timeout = Number(process.env.UNGGA_CLI_TIMEOUT_MS ?? "120000");
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["src/publish-listing.mjs", inputPath],
      {
        cwd: pocDir,
        timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : 120_000,
        maxBuffer: 4 * 1024 * 1024,
        env: childEnv,
      }
    );
    const parsed = parseCliJson(stdout);
    return buildUnggaCliToolResponse(input, parsed, stderr, cliCreds?.source);
  } catch (err) {
    const error = err as {
      message?: string;
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    const parsed = error.stdout ? parseCliJson(error.stdout) : null;
    return {
      ok: false,
      status: "failed",
      mode: "cli",
      exit_code: error.code,
      error: error.message ?? String(err),
      ...(parsed ? { cli_result: parsed } : {}),
      ...(error.stderr?.trim()
        ? { stderr: error.stderr.trim().slice(0, 2000) }
        : {}),
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function buildUnggaCliToolResponse(
  input: Record<string, unknown>,
  parsed: Record<string, unknown>,
  stderr: string,
  credentialSource?: "account" | "env"
): Record<string, unknown> {
  const action =
    typeof input.action === "string" && input.action.trim()
      ? input.action.trim()
      : "prepare_draft";
  const cliMode = typeof parsed.mode === "string" ? parsed.mode : "unknown";
  const ok = parsed.ok === true;
  const links = extractDraftLinks(parsed);
  const propertyId =
    (typeof links.ungga_property_id === "string" ? links.ungga_property_id : null) ??
    resolveUnggaPropertyId({
      ungga_property_id:
        typeof input.ungga_property_id === "string"
          ? input.ungga_property_id
          : undefined,
      draft_url:
        (typeof links.draft_url === "string" ? links.draft_url : undefined) ??
        (typeof input.draft_url === "string" ? input.draft_url : undefined),
    });

  if (action === "publish_draft") {
    const publishedUrl =
      typeof links.published_url === "string"
        ? links.published_url
        : propertyId
          ? buildUnggaPropertyUrl(propertyId)
          : null;
    return {
      ok,
      action,
      phase: "publish_draft",
      status: ok
        ? cliMode === "publish_dry_run"
          ? "publish_preview"
          : "published"
        : "failed",
      mode: "cli",
      cli_mode: cliMode,
      credential_source: credentialSource ?? null,
      requires_human_review: false,
      publish_policy:
        "publish_draft runs after human approval; it presses Publicar on the existing Ungga draft.",
      ...(publishedUrl ? { published_url: publishedUrl } : {}),
      ...(propertyId ? { ungga_property_id: propertyId } : {}),
      ...links,
      cli_result: parsed,
      ...(stderr.trim() ? { stderr: stderr.trim().slice(0, 2000) } : {}),
    };
  }

  const draftReady = ok && cliMode === "save_draft" && Boolean(propertyId);
  return {
    ok,
    action,
    phase: "prepare_draft",
    status: ok
      ? cliMode === "dry_run"
        ? "dry_run_ready"
        : "draft_created"
      : "failed",
    mode: "cli",
    cli_mode: cliMode,
    cli_dry_run: cliMode === "dry_run",
    credential_source: credentialSource ?? null,
    requires_human_review: draftReady,
    publish_policy:
      cliMode === "dry_run"
        ? "Dry-run fills the wizard only; no draft is saved."
        : "prepare_draft saves a Ungga draft for human review; final publish uses action publish_draft after HITL approval.",
    ...links,
    ...(draftReady
      ? {
          next_action: {
            action: "publish_draft",
            ungga_property_id: propertyId,
            draft_url: links.draft_url,
            hint: "Gu preparó el borrador en Ungga. Tras aprobación HITL, invocar ungga_publish_listing con action publish_draft.",
          },
        }
      : {}),
    cli_result: parsed,
    ...(stderr.trim() ? { stderr: stderr.trim().slice(0, 2000) } : {}),
  };
}

function extractDraftLinks(parsed: Record<string, unknown>): Record<string, unknown> {
  const result =
    parsed && typeof parsed === "object" && parsed.result && typeof parsed.result === "object"
      ? (parsed.result as Record<string, unknown>)
      : null;
  if (!result) return {};
  const out: Record<string, unknown> = {};
  if (typeof result.draft_url === "string" && result.draft_url.trim()) {
    out.draft_url = result.draft_url.trim();
  }
  if (typeof result.published_url === "string" && result.published_url.trim()) {
    out.published_url = result.published_url.trim();
  }
  if (typeof result.properties_url === "string" && result.properties_url.trim()) {
    out.properties_url = result.properties_url.trim();
  }
  const propId =
    (typeof result.ungga_property_id === "string" && result.ungga_property_id.trim()) ||
    (typeof result.ungga_listing_id === "string" && result.ungga_listing_id.trim()) ||
    (typeof result.property_id === "string" && result.property_id.trim()) ||
    null;
  if (propId) {
    out.ungga_property_id = propId;
  }
  if (result.draft_lookup && typeof result.draft_lookup === "object") {
    out.draft_lookup = result.draft_lookup;
  }
  return out;
}

function parseCliJson(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
    }
    return { raw: trimmed.slice(0, 4000) };
  }
}
