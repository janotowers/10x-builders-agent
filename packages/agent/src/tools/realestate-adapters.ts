/**
 * LangChain adapters para tools del dominio inmobiliario:
 *   - telegram_send_message_to_contact (real)
 *   - easybroker_search_listings, easybroker_search_closed_deals (real, read-only)
 *   - easybroker_create_listing, easybroker_upload_images (real HTTP write, HITL)
 *   - bigquery_lookup_local_comparables (real, sobre bigquery_run_query)
 *   - generate_document_from_template (real: DOCX desde account_assets)
 *   - image_watermark (real: Sharp + account_assets)
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
import sharp from "sharp";
import { z } from "zod";
import {
  executeBigQueryQuery,
  type BigQueryParamValue,
} from "./bigquery-adapter";
import {
  createToolCall,
  getAccountAssetByStoragePath,
  listAccountAssets,
  updateToolCallStatus,
  getOperationalCase,
  insertOperationalCaseEvent,
  updateOperationalCase,
  createExternalContactNotification,
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
import type { AccountAsset } from "@agents/types";
import type { NotifyUserFn } from "./operational-cases-adapters";

const execFileAsync = promisify(execFile);

const LOCAL_COMPARABLES_BIGQUERY_PROJECT_ID = "ungga-full";
const LOCAL_COMPARABLES_BIGQUERY_LOCATION = "US";

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
                await createExternalContactNotification(ctx.db, {
                  userId: ctx.userId,
                  caseId: opCase.id,
                  contact: {
                    ...(opCase.external_contact_jsonb as Record<string, unknown>),
                    channel: "telegram",
                    chat_id: input.chat_id,
                  },
                  channel: "telegram",
                  recipientIdentifier: String(input.chat_id),
                  messageBody: input.text,
                  status: "sent",
                  nextReminderAt: new Date(
                    Date.now() + 24 * 60 * 60_000
                  ).toISOString(),
                  metadata: {
                    purpose: input.purpose ?? "outbound",
                    source: "telegram_send_message_to_contact",
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

  // ── EasyBroker (write) — API real, siempre risk=high/HITL ───────────
  if (toolEnabled("easybroker_create_listing", ctx)) {
    tools.push(makeEasyBrokerCreateListingTool(ctx));
  }
  if (toolEnabled("easybroker_upload_images", ctx)) {
    tools.push(makeEasyBrokerUploadImagesTool(ctx));
  }

  // ── BigQuery comparables ────────────────────────────────────────────
  if (toolEnabled("bigquery_lookup_local_comparables", ctx)) {
    tools.push(
      tool(
        async (input: {
          zona?: string;
          operation?: "sale" | "rent";
          property_type?: string;
          target_price?: number;
          price?: number;
          min_price?: number;
          max_price?: number;
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
          const out = await lookupLocalComparablesFromBigQuery(ctx, input);
          await updateToolCallStatus(
            ctx.db,
            record.id,
            out.status === "ok" ? "executed" : "failed",
            out as unknown as Record<string, unknown>
          );
          return JSON.stringify(out);
        },
        {
          name: "bigquery_lookup_local_comparables",
          description:
            "Looks up published internal inventory in the Ungga warehouse (BigQuery) for comparable asking prices.",
          schema: z.object({
            zona: z.string().min(1).optional(),
            operation: z.enum(["sale", "rent"]).optional(),
            property_type: z.string().min(1).optional(),
            target_price: z.number().positive().optional(),
            price: z.number().positive().optional(),
            min_price: z.number().positive().optional(),
            max_price: z.number().positive().optional(),
            min_area_m2: z.number().positive().optional(),
            max_area_m2: z.number().positive().optional(),
            months_back: z.number().int().positive().max(60).optional(),
            limit: z.number().int().positive().max(250).optional(),
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

  // ── Image watermark ────────────────────────────────────────────────
  if (toolEnabled("image_watermark", ctx)) {
    tools.push(
      tool(
        async (input: {
          input_paths: string[];
          asset_key?: string;
          position?: "bottom-right" | "bottom-left" | "top-right" | "top-left" | "center";
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
          try {
            const out = await applyImageWatermark(ctx, input);
            await updateToolCallStatus(ctx.db, record.id, "executed", out);
            return JSON.stringify(out);
          } catch (err) {
            const out = {
              ok: false,
              status: "failed",
              error: err instanceof Error ? err.message : String(err),
            };
            await updateToolCallStatus(ctx.db, record.id, "failed", out);
            return JSON.stringify(out);
          }
        },
        {
          name: "image_watermark",
          description: "Applies the tenant watermark to property photos.",
          schema: z.object({
            input_paths: z.array(z.string().min(1)).min(1),
            asset_key: z.string().min(1).optional(),
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

type ImageWatermarkInput = {
  input_paths: string[];
  asset_key?: string;
  position?: "bottom-right" | "bottom-left" | "top-right" | "top-left" | "center";
  opacity?: number;
  scale?: number;
};

const IMAGE_WATERMARK_OUTPUT_BUCKET = "account-assets";
const WATERMARK_IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/svg+xml",
]);

async function applyImageWatermark(
  ctx: ToolContext,
  input: ImageWatermarkInput
): Promise<Record<string, unknown>> {
  const watermarkAsset = await resolveWatermarkAsset(ctx, input.asset_key);
  if (!watermarkAsset) {
    return {
      ok: false,
      status: "not_configured",
      requested_asset_key: input.asset_key ?? null,
      hint:
        "No encontré un watermark de imagen en account_assets para esta cuenta. Sube un PNG/SVG/WebP/JPG como watermark, watermark_png o brand_watermark.",
    };
  }

  const opacity = clampNumber(input.opacity ?? 0.6, 0, 1);
  const scale = clampNumber(input.scale ?? 0.18, 0.05, 0.5);
  const position = input.position ?? "bottom-right";
  const watermarkBuffer = await downloadStorageObject(
    ctx,
    watermarkAsset.storage_bucket,
    watermarkAsset.storage_path,
    "watermark"
  );
  const batchId = Date.now();
  const outputs = [];

  for (let index = 0; index < input.input_paths.length; index += 1) {
    const inputPath = input.input_paths[index];
    try {
      const source = await loadImageInput(ctx, inputPath);
      const base = sharp(source.buffer, { failOn: "none" });
      const metadata = await base.metadata();
      const width = metadata.width ?? 0;
      if (width <= 0) {
        throw new Error("No se pudo leer el ancho de la imagen fuente.");
      }
      const watermarkWidth = Math.max(1, Math.round(width * scale));
      const preparedWatermark = await prepareWatermark(
        watermarkBuffer,
        watermarkWidth,
        opacity
      );
      const outputFormat = outputFormatFor(metadata.format);
      const outputBuffer = await base
        .rotate()
        .composite([
          {
            input: preparedWatermark,
            gravity: gravityForPosition(position),
          },
        ])
        .toFormat(outputFormat.format, outputFormat.options)
        .toBuffer();
      const outputPath = `${ctx.userId}/watermarked-images/${batchId}/${index + 1}-${safeSegment(
        path.basename(source.name).replace(/\.[^.]+$/, "") || "image"
      )}.${outputFormat.extension}`;
      const { error: uploadError } = await ctx.db.storage
        .from(IMAGE_WATERMARK_OUTPUT_BUCKET)
        .upload(outputPath, outputBuffer, {
          contentType: outputFormat.contentType,
          upsert: true,
        });
      if (uploadError) {
        throw new Error(`No se pudo guardar imagen con watermark: ${uploadError.message}`);
      }
      const { data: signedUrlData } = await ctx.db.storage
        .from(IMAGE_WATERMARK_OUTPUT_BUCKET)
        .createSignedUrl(outputPath, 60 * 60);
      outputs.push({
        ok: true,
        input_path: inputPath,
        output_bucket: IMAGE_WATERMARK_OUTPUT_BUCKET,
        output_path: outputPath,
        signed_url: signedUrlData?.signedUrl,
        signed_url_expires_in_seconds: 60 * 60,
        output_content_type: outputFormat.contentType,
        bytes: outputBuffer.length,
      });
    } catch (err) {
      outputs.push({
        ok: false,
        input_path: inputPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const successCount = outputs.filter((item) => item.ok).length;
  return {
    ok: successCount === input.input_paths.length,
    status: successCount === input.input_paths.length ? "watermarked" : "partial_failure",
    watermark_asset_key: watermarkAsset.asset_key,
    watermark_bucket: watermarkAsset.storage_bucket,
    watermark_path: watermarkAsset.storage_path,
    position,
    opacity,
    scale,
    count: successCount,
    total: input.input_paths.length,
    outputs,
  };
}

async function resolveWatermarkAsset(ctx: ToolContext, assetKey?: string) {
  const candidateKeys = Array.from(
    new Set(
      [
        assetKey,
        "listing_photo_watermark",
        "watermark",
        "watermark_png",
        "brand_watermark",
        "alebrixe_watermark",
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
    if (match && isWatermarkImageAsset(match)) return match;
  }

  const accountAssets = await listAccountAssets(ctx.db, { userId: ctx.userId });
  return (
    accountAssets.find(
      (asset) =>
        asset.source_tool_id === "image_watermark" && isWatermarkImageAsset(asset)
    ) ??
    accountAssets.find(
      (asset) =>
        /watermark|marca.*agua|brand/i.test(
          `${asset.asset_key} ${asset.display_name}`
        ) && isWatermarkImageAsset(asset)
    ) ??
    null
  );
}

function isWatermarkImageAsset(asset: AccountAsset) {
  return Boolean(asset.content_type && WATERMARK_IMAGE_MIMES.has(asset.content_type));
}

async function loadImageInput(ctx: ToolContext, inputPath: string) {
  if (/^https?:\/\//i.test(inputPath)) {
    const response = await fetch(inputPath);
    if (!response.ok) {
      throw new Error(`No se pudo descargar imagen (${response.status})`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType && !contentType.startsWith("image/")) {
      throw new Error(`URL no parece imagen: ${contentType}`);
    }
    return {
      buffer: Buffer.from(await response.arrayBuffer()),
      name: new URL(inputPath).pathname,
    };
  }

  const parsed = parseStoragePath(inputPath);
  return {
    buffer: await downloadStorageObject(ctx, parsed.bucket, parsed.path, "imagen fuente"),
    name: parsed.path,
  };
}

function parseStoragePath(inputPath: string) {
  const trimmed = inputPath.trim();
  const bucketMatch = trimmed.match(/^([a-z0-9._-]+):(.*)$/i);
  if (bucketMatch?.[1] && bucketMatch?.[2]) {
    return {
      bucket: bucketMatch[1],
      path: bucketMatch[2].replace(/^\/+/, ""),
    };
  }
  return {
    bucket: IMAGE_WATERMARK_OUTPUT_BUCKET,
    path: trimmed.replace(/^\/+/, ""),
  };
}

async function downloadStorageObject(
  ctx: ToolContext,
  bucket: string,
  storagePath: string,
  label: string
) {
  const { data, error } = await ctx.db.storage.from(bucket).download(storagePath);
  if (error) {
    throw new Error(`No se pudo descargar ${label}: ${error.message}`);
  }
  if (!data) {
    throw new Error(`No se pudo descargar ${label}: respuesta vacía.`);
  }
  return Buffer.from(await data.arrayBuffer());
}

async function prepareWatermark(
  watermarkBuffer: Buffer,
  watermarkWidth: number,
  opacity: number
) {
  const resized = await sharp(watermarkBuffer, { failOn: "none" })
    .resize({ width: watermarkWidth, withoutEnlargement: true })
    .png()
    .toBuffer();
  const metadata = await sharp(resized).metadata();
  const width = metadata.width ?? watermarkWidth;
  const height = metadata.height ?? watermarkWidth;
  return sharp(resized)
    .ensureAlpha()
    .composite([
      {
        input: {
          create: {
            width,
            height,
            channels: 4,
            background: { r: 255, g: 255, b: 255, alpha: opacity },
          },
        },
        blend: "dest-in",
      },
    ])
    .png()
    .toBuffer();
}

function gravityForPosition(position: NonNullable<ImageWatermarkInput["position"]>) {
  switch (position) {
    case "bottom-left":
      return "southwest" as const;
    case "top-right":
      return "northeast" as const;
    case "top-left":
      return "northwest" as const;
    case "center":
      return "center" as const;
    case "bottom-right":
    default:
      return "southeast" as const;
  }
}

function outputFormatFor(format?: string) {
  if (format === "png") {
    return {
      format: "png" as const,
      extension: "png",
      contentType: "image/png",
      options: {},
    };
  }
  if (format === "webp") {
    return {
      format: "webp" as const,
      extension: "webp",
      contentType: "image/webp",
      options: { quality: 88 },
    };
  }
  return {
    format: "jpeg" as const,
    extension: "jpg",
    contentType: "image/jpeg",
    options: { quality: 90 },
  };
}

function clampNumber(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
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
  min_bedrooms?: number;
  bathrooms?: number;
  min_bathrooms?: number;
  parking_spaces?: number;
  min_parking_spaces?: number;
  shared_commission_only?: boolean;
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
    const parsedError =
      parsed && typeof parsed.error === "string" ? parsed.error : "";
    const errorText = `${error.message ?? ""} ${parsedError} ${error.stderr ?? ""}`;
    const needsManualLogin = isEasyBrokerManualLoginRequired(errorText);
    return {
      ok: false,
      status: needsManualLogin ? "needs_manual_login" : "failed",
      source: "easybroker_mls",
      mode: "web_mls",
      tool: toolId,
      exit_code: error.code,
      error: error.message ?? String(err),
      ...(needsManualLogin
        ? {
            hint:
              "EasyBroker requiere login manual, CAPTCHA/MFA o refrescar la sesión persistente. Ejecuta el login asistido del POC y vuelve a probar.",
          }
        : {}),
      ...(parsed ? { cli_result: parsed } : {}),
      ...(error.stderr?.trim()
        ? { stderr: error.stderr.trim().slice(0, 2000) }
        : {}),
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function isEasyBrokerManualLoginRequired(value: string) {
  return /captcha|recaptcha|403|forbidden|access denied|login manual|sesión persistente|storage-state|mfa/i.test(
    value
  );
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
  if (!roomCountMatches(property.bedrooms, input.bedrooms, 4)) return false;
  if (input.bedrooms == null && !minRoomCountMatches(property.bedrooms, input.min_bedrooms)) {
    return false;
  }
  if (!roomCountMatches(property.bathrooms, input.bathrooms, 5)) return false;
  if (input.bathrooms == null && !minRoomCountMatches(property.bathrooms, input.min_bathrooms)) {
    return false;
  }
  if (!roomCountMatches(property.parking_spaces, input.parking_spaces, 5)) return false;
  if (
    input.parking_spaces == null &&
    !minRoomCountMatches(property.parking_spaces, input.min_parking_spaces)
  ) {
    return false;
  }
  return true;
}

function roomCountMatches(actual: number | null, requested: number | undefined, plusAt: number) {
  if (requested == null) return true;
  if (actual == null) return true;
  const target = Math.floor(Number(requested));
  if (!Number.isFinite(target) || target < 0) return true;
  if (target >= plusAt) return actual >= target;
  return actual === target;
}

function minRoomCountMatches(actual: number | null, requested: number | undefined) {
  if (requested == null) return true;
  if (actual == null) return true;
  const target = Math.floor(Number(requested));
  if (!Number.isFinite(target) || target < 0) return true;
  return actual >= target;
}

function numericOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function errorMessageFromPayload(payload: Record<string, unknown>) {
  const error = payload.error ?? payload.message ?? payload.errors;
  const serialized = JSON.stringify(payload);
  if (typeof error === "string") {
    return serialized && serialized !== "{}" ? `${error} — ${serialized}` : error;
  }
  if (error) return JSON.stringify(error);
  if (serialized && serialized !== "{}") return serialized;
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
        if (out.ok !== false) {
          await markAccountSecretSuccess(
            ctx,
            ACCOUNT_TOOL_PROVIDERS_REALESTATE.easybroker_web
          );
        }
        await updateToolCallStatus(ctx.db, record.id, "executed", out);
        return JSON.stringify(out);
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
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
        min_bedrooms: z.number().nonnegative().optional(),
        bathrooms: z.number().nonnegative().optional(),
        min_bathrooms: z.number().nonnegative().optional(),
        parking_spaces: z.number().nonnegative().optional(),
        min_parking_spaces: z.number().nonnegative().optional(),
        shared_commission_only: z.boolean().optional(),
        date_from: z.string().optional(),
        date_to: z.string().optional(),
        page: z.number().int().positive().optional(),
        limit: z.number().int().positive().max(50).optional(),
      }),
    }
  );
}

type EasyBrokerListingLocationInput = {
  street?: string;
  exterior_number?: string;
  neighborhood?: string;
  city?: string;
  state?: string;
  country?: string;
  postal_code?: string;
  latitude?: number;
  longitude?: number;
  [key: string]: unknown;
};

type EasyBrokerCreateListingInput = {
  title: string;
  description: string;
  operation: "sale" | "rent";
  property_type: string;
  price: number;
  currency?: string;
  status?: "published" | "sold" | "rented" | "reserved" | "suspended" | "not_published";
  street?: string;
  location?: EasyBrokerListingLocationInput;
  private_description?: string;
  agent?: string;
  show_prices?: boolean;
  bedrooms?: number;
  bathrooms?: number;
  half_bathrooms?: number;
  parking?: number;
  parking_spaces?: number;
  age?: string;
  floor?: string;
  floors?: number;
  expenses?: string;
  internal_id?: string;
  tags?: string[];
  features?: string[];
  share_commission?: boolean;
  collaboration_notes?: string;
  shared_commission_percentage?: number | null;
  construction_size?: number;
  lot_size?: number;
  area_m2?: number;
  lot_length?: number;
  lot_width?: number;
  covered_space?: number;
  exclusive?: boolean | null;
  videos?: string[];
  virtual_tour?: string;
  show_exact_location?: boolean;
  custom_fields?: Record<string, unknown>;
  custom_fields_json?: string;
  case_id?: string;
  dry_run?: boolean;
};

type EasyBrokerUploadImagesInput = {
  listing_id: string;
  image_paths: string[];
  image_titles?: string[];
  case_id?: string;
  dry_run?: boolean;
};

type EasyBrokerImagePayload = {
  url: string;
  title?: string | null;
  source_path?: string;
  expires_in_seconds?: number;
};

class EasyBrokerApiError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly payload: Record<string, unknown>
  ) {
    super(message);
    this.name = "EasyBrokerApiError";
  }
}

const EASYBROKER_SIGNED_URL_TTL_SECONDS = 60 * 60 * 72;
const EASYBROKER_MAX_IMAGE_URL_LENGTH = 255;

function makeEasyBrokerCreateListingTool(ctx: ToolContext) {
  return tool(
    async (input: EasyBrokerCreateListingInput) => {
      const record = await createToolCall(
        ctx.db,
        ctx.sessionId,
        "easybroker_create_listing",
        input as unknown as Record<string, unknown>,
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
      let attemptedPayload: Record<string, unknown> | undefined;
      try {
        const inputForExecution = await applyDefaultEasyBrokerAgent(ctx, input);
        attemptedPayload = buildEasyBrokerCreatePayload(inputForExecution);
        const out = await createEasyBrokerListing(ctx, inputForExecution, creds, attemptedPayload);
        await markEasyBrokerCredentialResult(ctx, creds, out.ok !== false, out.status);
        await updateToolCallStatus(ctx.db, record.id, out.ok === false ? "failed" : "executed", out);
        if (input.case_id && out.ok !== false) {
          await insertOperationalCaseEvent(ctx.db, {
            caseId: input.case_id,
            eventType: "state_changed",
            actor: "agent",
            payload: {
              tool: "easybroker_create_listing",
              listing_id: out.listing_id,
              public_id: out.public_id,
              url: out.url,
              public_url: out.public_url,
              agent_url: out.agent_url,
              status: out.status,
            },
          });
        }
        return JSON.stringify(out);
      } catch (err) {
        const credentialFailure = isEasyBrokerCredentialFailure(err);
        const apiPayload =
          err instanceof EasyBrokerApiError ? err.payload : undefined;
        const out = {
          ok: false,
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
          credential_failure: credentialFailure,
          ...(apiPayload ? { easybroker_response: apiPayload } : {}),
          ...(attemptedPayload ? { attempted_payload: attemptedPayload } : {}),
        };
        if (credentialFailure) {
          await markEasyBrokerCredentialResult(ctx, creds, false, out.error);
        }
        await updateToolCallStatus(ctx.db, record.id, "failed", out);
        return JSON.stringify(out);
      }
    },
    {
      name: "easybroker_create_listing",
      description:
        "Creates an EasyBroker property as not_published by default (write, HITL).",
      schema: z.object({
        title: z.string().min(1),
        description: z.string().min(1).max(4000),
        operation: z.enum(["sale", "rent"]),
        property_type: z.string().min(1),
        price: z.number().nonnegative(),
        currency: z.string().optional(),
        status: z
          .enum(["published", "sold", "rented", "reserved", "suspended", "not_published"])
          .optional(),
        street: z.string().optional(),
        location: z.record(z.string(), z.any()).optional(),
        private_description: z.string().optional(),
        agent: z.string().optional(),
        show_prices: z.boolean().optional(),
        bedrooms: z.number().nonnegative().optional(),
        bathrooms: z.number().nonnegative().optional(),
        half_bathrooms: z.number().nonnegative().optional(),
        parking: z.number().nonnegative().optional(),
        parking_spaces: z.number().nonnegative().optional(),
        age: z.string().optional(),
        floor: z.string().optional(),
        floors: z.number().int().nonnegative().optional(),
        expenses: z.string().optional(),
        internal_id: z.string().optional(),
        tags: z.array(z.string()).optional(),
        features: z.array(z.string()).optional(),
        share_commission: z.boolean().optional(),
        collaboration_notes: z.string().optional(),
        shared_commission_percentage: z.number().nullable().optional(),
        construction_size: z.number().nonnegative().optional(),
        lot_size: z.number().nonnegative().optional(),
        area_m2: z.number().nonnegative().optional(),
        lot_length: z.number().nonnegative().optional(),
        lot_width: z.number().nonnegative().optional(),
        covered_space: z.number().nonnegative().optional(),
        exclusive: z.boolean().nullable().optional(),
        videos: z.array(z.string()).optional(),
        virtual_tour: z.string().optional(),
        show_exact_location: z.boolean().optional(),
        custom_fields: z.record(z.string(), z.any()).optional(),
        custom_fields_json: z
          .string()
          .optional()
          .describe("Optional JSON string with tenant-specific EasyBroker fields."),
        case_id: z.string().optional(),
        dry_run: z.boolean().optional(),
      }),
    }
  );
}

function makeEasyBrokerUploadImagesTool(ctx: ToolContext) {
  return tool(
    async (input: EasyBrokerUploadImagesInput) => {
      const record = await createToolCall(
        ctx.db,
        ctx.sessionId,
        "easybroker_upload_images",
        input as unknown as Record<string, unknown>,
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
        await updateToolCallStatus(ctx.db, record.id, "failed", out);
        return JSON.stringify(out);
      }
      try {
        const out = await uploadEasyBrokerImages(ctx, input, creds);
        await markEasyBrokerCredentialResult(ctx, creds, out.ok !== false, out.status);
        await updateToolCallStatus(ctx.db, record.id, out.ok === false ? "failed" : "executed", out);
        if (input.case_id && out.ok !== false) {
          await insertOperationalCaseEvent(ctx.db, {
            caseId: input.case_id,
            eventType: "state_changed",
            actor: "agent",
            payload: {
              tool: "easybroker_upload_images",
              listing_id: input.listing_id,
              image_count: out.count,
              status: out.status,
            },
          });
        }
        return JSON.stringify(out);
      } catch (err) {
        const credentialFailure = isEasyBrokerCredentialFailure(err);
        const out = {
          ok: false,
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
          credential_failure: credentialFailure,
        };
        if (credentialFailure) {
          await markEasyBrokerCredentialResult(ctx, creds, false, out.error);
        }
        await updateToolCallStatus(ctx.db, record.id, "failed", out);
        return JSON.stringify(out);
      }
    },
    {
      name: "easybroker_upload_images",
      description:
        "Replaces an EasyBroker property's image array using HTTP(S) image URLs (write, HITL).",
      schema: z.object({
        listing_id: z.string().min(1),
        image_paths: z.array(z.string().min(1)).min(1).max(50),
        image_titles: z.array(z.string()).optional(),
        case_id: z.string().optional(),
        dry_run: z.boolean().optional(),
      }),
    }
  );
}

type BigQueryComparableLookupInput = {
  zona?: string;
  operation?: "sale" | "rent";
  property_type?: string;
  target_price?: number;
  price?: number;
  min_price?: number;
  max_price?: number;
  min_area_m2?: number;
  max_area_m2?: number;
  months_back?: number;
  limit?: number;
};

type LocalComparableRow = {
  source: "bigquery_internal_inventory";
  id: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  property_type: string | null;
  operation: string | null;
  price: number | null;
  price_display: string | null;
  currency: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  ad_status: string | null;
  created_at: string | null;
  created_at_raw: string | null;
  url: string | null;
  price_basis: "asking_price";
  is_closed_price: false;
  price_parse_status: "parsed" | "missing" | "failed";
  quality: "complete" | "incomplete";
  quality_reasons: string[];
  usable_as_comparable: boolean;
};

async function lookupLocalComparablesFromBigQuery(
  ctx: ToolContext,
  input: BigQueryComparableLookupInput
) {
  const organizationId = ctx.tenantOrganizationId?.trim();
  if (!organizationId) {
    return {
      ok: false,
      status: "not_configured",
      source: "bigquery_internal_inventory",
      price_basis: "asking_price",
      is_closed_price: false,
      hint:
        "No hay tenantOrganizationId en el contexto; no se puede consultar inventario interno sin filtro por organización.",
      rows: [],
      stats: emptyLocalComparableStats(),
    };
  }

  const limit = Math.min(Math.max(input.limit ?? 100, 1), 250);
  const monthsBack = Math.min(Math.max(input.months_back ?? 24, 1), 60);
  const params: Record<string, BigQueryParamValue> = {
    organization_id: organizationId,
    months_back: monthsBack,
    limit,
  };
  const filters = [
    "p.ad_status = 'Publicado'",
    "DATE(p.created_time, 'America/Mexico_City') >= DATE_SUB(CURRENT_DATE('America/Mexico_City'), INTERVAL @months_back MONTH)",
  ];
  const priceFilters: string[] = [];

  const zona = cleanString(input.zona);
  if (zona) {
    params.zona = zona.toLowerCase();
    filters.push(`(
      LOWER(COALESCE(p.address, '')) LIKE CONCAT('%', @zona, '%')
      OR LOWER(COALESCE(p.city, '')) LIKE CONCAT('%', @zona, '%')
      OR LOWER(COALESCE(p.state, '')) LIKE CONCAT('%', @zona, '%')
    )`);
  }

  const propertyType = cleanString(input.property_type);
  if (propertyType) {
    params.property_type = propertyType;
    filters.push("p.house_type = @property_type");
  }

  if (input.operation === "rent") {
    filters.push("p.monetization_type_display = 'Renta'");
  } else if (input.operation === "sale") {
    filters.push("p.monetization_type_display IN ('Venta', 'Preventa')");
  }

  const explicitMinPrice = positiveNumberOrNull(input.min_price);
  const explicitMaxPrice = positiveNumberOrNull(input.max_price);
  const targetPrice = positiveNumberOrNull(input.target_price) ?? positiveNumberOrNull(input.price);
  const minPrice = explicitMinPrice ?? (targetPrice != null ? Math.round(targetPrice * 0.7) : null);
  const maxPrice = explicitMaxPrice ?? (targetPrice != null ? Math.round(targetPrice * 1.3) : null);
  if (minPrice != null) {
    params.min_price = minPrice;
    priceFilters.push("price >= @min_price");
  }
  if (maxPrice != null) {
    params.max_price = maxPrice;
    priceFilters.push("price <= @max_price");
  }

  const sql = `
WITH user_ids AS (
  SELECT u.document_id AS user_id
  FROM \`ungga-full.firestore_users.users_light\` u
  WHERE (u.is_test IS NULL OR u.is_test = FALSE)
    AND u.organization_id = @organization_id
),
inventory_raw AS (
  SELECT
    p.document_id,
    p.address,
    p.city,
    p.state,
    p.house_type,
    p.monetization_type_display,
    p.price_display,
    SAFE_CAST(NULLIF(REGEXP_REPLACE(COALESCE(p.price_display, ''), r'[^0-9.]', ''), '') AS FLOAT64) AS price,
    p.currency_display,
    p.bedroom,
    p.bathroom,
    p.ad_status,
    p.created_time,
    p.public_url
  FROM \`ungga-full.firestore_properties.properties_light\` p
  JOIN user_ids u ON REPLACE(p.user_owner, 'users/', '') = u.user_id
  WHERE ${filters.join("\n    AND ")}
  QUALIFY ROW_NUMBER() OVER (PARTITION BY p.document_id ORDER BY p.created_time DESC) = 1
),
inventory AS (
  SELECT *
  FROM inventory_raw
  WHERE ${priceFilters.length > 0 ? priceFilters.join("\n    AND ") : "TRUE"}
)
SELECT *
FROM inventory
ORDER BY price IS NULL, created_time DESC
LIMIT @limit`;

  const result = await executeBigQueryQuery({
    sql,
    params,
    projectId: ctx.bigQueryProjectId ?? LOCAL_COMPARABLES_BIGQUERY_PROJECT_ID,
    // These hard-coded Ungga warehouse tables are in the multi-region `US`.
    // Do not inherit regional app defaults such as `us-central1`, which make
    // BigQuery report the dataset as missing even when the table name is valid.
    location: LOCAL_COMPARABLES_BIGQUERY_LOCATION,
    maxResults: limit,
  });

  if (result.status !== "ok") {
    return {
      ok: false,
      status: result.status,
      source: "bigquery_internal_inventory",
      price_basis: "asking_price",
      is_closed_price: false,
      hint:
        result.status === "not_configured"
          ? result.message
          : "No se pudo consultar BigQuery para comparables internos.",
      error: "error" in result ? result.error : undefined,
      missing: "missing" in result ? result.missing : undefined,
      rows: [],
      stats: emptyLocalComparableStats(),
      filters_used: comparableFiltersUsed(input, monthsBack, limit, minPrice, maxPrice),
    };
  }

  const rows = result.rows.map(normalizeLocalComparableRow);
  return {
    ok: true,
    status: "ok",
    source: "bigquery_internal_inventory",
    price_basis: "asking_price",
    is_closed_price: false,
    count: rows.length,
    rows,
    stats: localComparableStats(rows),
    filters_used: comparableFiltersUsed(input, monthsBack, limit, minPrice, maxPrice),
    notes:
      "Inventario interno publicado desde BigQuery; son precios publicados (asking prices), no precios de cierre. No se calcula precio/m² hasta confirmar campos de área confiables.",
    bigquery: {
      row_count: result.rowCount,
      truncated: result.truncated,
      bytes_processed: result.bytesProcessed ?? null,
      cache_hit: result.cacheHit ?? null,
    },
  };
}

function comparableFiltersUsed(
  input: BigQueryComparableLookupInput,
  monthsBack: number,
  limit: number,
  minPrice: number | null,
  maxPrice: number | null
) {
  return {
    zona: cleanString(input.zona),
    operation: input.operation ?? null,
    property_type: cleanString(input.property_type),
    target_price: positiveNumberOrNull(input.target_price) ?? positiveNumberOrNull(input.price),
    min_price: minPrice,
    max_price: maxPrice,
    months_back: monthsBack,
    limit,
    price_basis: "asking_price",
    source: "bigquery_internal_inventory",
  };
}

function normalizeLocalComparableRow(row: Record<string, unknown>): LocalComparableRow {
  const price = numberOrNull(row.price);
  const priceDisplay = cleanString(row.price_display);
  const normalized = {
    id: cleanStringOrNull(row.document_id),
    address: cleanStringOrNull(row.address),
    city: cleanStringOrNull(row.city),
    state: cleanStringOrNull(row.state),
    property_type: cleanStringOrNull(row.house_type),
    operation: cleanStringOrNull(row.monetization_type_display),
    price,
    price_display: priceDisplay ?? null,
    currency: cleanStringOrNull(row.currency_display),
    bedrooms: numberOrNull(row.bedroom),
    bathrooms: numberOrNull(row.bathroom),
    ad_status: cleanStringOrNull(row.ad_status),
    created_at: timestampLikeToIsoString(row.created_time),
    created_at_raw: cleanStringOrNull(row.created_time),
    url: cleanStringOrNull(row.public_url),
  };
  const qualityReasons = localComparableQualityReasons(normalized);
  return {
    source: "bigquery_internal_inventory",
    ...normalized,
    price_basis: "asking_price",
    is_closed_price: false,
    price_parse_status: price != null ? "parsed" : priceDisplay ? "failed" : "missing",
    quality: qualityReasons.length === 0 ? "complete" : "incomplete",
    quality_reasons: qualityReasons,
    usable_as_comparable: qualityReasons.length === 0,
  };
}

function localComparableQualityReasons(
  row: Pick<
    LocalComparableRow,
    "address" | "city" | "state" | "property_type" | "operation" | "price"
  >
) {
  const reasons: string[] = [];
  if (!row.property_type) reasons.push("missing_property_type");
  if (!row.operation) reasons.push("missing_operation");
  if (row.price == null) reasons.push("missing_price");
  if (!row.address && !row.city && !row.state) reasons.push("missing_location");
  return reasons;
}

function emptyLocalComparableStats() {
  return {
    count: 0,
    usable_count: 0,
    incomplete_count: 0,
    priced_count: 0,
    p25_price: null,
    p50_price: null,
    p75_price: null,
    average_price: null,
    min_price: null,
    max_price: null,
    price_per_m2_available: false,
  };
}

function localComparableStats(rows: LocalComparableRow[]) {
  const usableRows = rows.filter((row) => row.usable_as_comparable);
  const prices = usableRows
    .map((row) => row.price)
    .filter((price): price is number => typeof price === "number" && Number.isFinite(price))
    .sort((a, b) => a - b);
  if (prices.length === 0) {
    return {
      ...emptyLocalComparableStats(),
      count: rows.length,
      incomplete_count: rows.filter((row) => !row.usable_as_comparable).length,
    };
  }
  const sum = prices.reduce((acc, value) => acc + value, 0);
  return {
    count: rows.length,
    usable_count: usableRows.length,
    incomplete_count: rows.length - usableRows.length,
    priced_count: prices.length,
    p25_price: percentileNearestRank(prices, 0.25),
    p50_price: percentileNearestRank(prices, 0.5),
    p75_price: percentileNearestRank(prices, 0.75),
    average_price: Math.round(sum / prices.length),
    min_price: prices[0],
    max_price: prices[prices.length - 1],
    price_per_m2_available: false,
  };
}

function percentileNearestRank(sortedValues: number[], percentile: number) {
  if (sortedValues.length === 0) return null;
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(percentile * sortedValues.length) - 1)
  );
  return sortedValues[index];
}

function numberOrNull(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function timestampLikeToIsoString(value: unknown) {
  if (value == null) return null;
  const raw = typeof value === "string" ? value.trim() : String(value);
  if (!raw) return null;
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) {
    const millis = numeric > 1e12 ? numeric : numeric * 1000;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? raw : date.toISOString();
  }
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? raw : new Date(parsed).toISOString();
}

function positiveNumberOrNull(value: unknown) {
  const parsed = numberOrNull(value);
  return parsed != null && parsed > 0 ? parsed : null;
}

function cleanStringOrNull(value: unknown) {
  return cleanString(value) ?? null;
}

async function applyDefaultEasyBrokerAgent(
  ctx: ToolContext,
  input: EasyBrokerCreateListingInput
): Promise<EasyBrokerCreateListingInput> {
  if (cleanString(input.agent)) return input;
  const webCreds = await resolveEasyBrokerWebCredentials(ctx);
  const agentEmail = cleanString(webCreds?.email);
  return agentEmail ? { ...input, agent: agentEmail } : input;
}

async function createEasyBrokerListing(
  ctx: ToolContext,
  input: EasyBrokerCreateListingInput,
  creds: EasyBrokerCredentials,
  prebuiltPayload?: Record<string, unknown>
) {
  const payload = prebuiltPayload ?? buildEasyBrokerCreatePayload(input);
  if (input.dry_run) {
    return {
      ok: true,
      status: "dry_run",
      credential_source: creds.source,
      payload,
      hint: "Dry-run local: no se envió POST /v1/properties a EasyBroker.",
    };
  }
  const response = await easyBrokerApiRequest(creds, "/v1/properties", {
    method: "POST",
    body: payload,
  });
  const listingId = stringFromPayload(response.payload, [
    "public_id",
    "id",
    "property_id",
    "internal_id",
  ]);
  const publicUrl = stringFromPayload(response.payload, ["public_url", "url"]);
  const agentUrl = easyBrokerAgentUrlFromPublicUrl(publicUrl);
  return {
    ok: true,
    status: "created",
    credential_source: creds.source,
    listing_id: listingId,
    public_id: stringFromPayload(response.payload, ["public_id"]),
    internal_id: stringFromPayload(response.payload, ["internal_id"]),
    url: publicUrl,
    public_url: publicUrl,
    agent_url: agentUrl,
    easybroker_status: stringFromPayload(response.payload, ["status"]),
    request_status: payload.status,
    payload_sent: payload,
    raw: truncatePayload(response.payload),
  };
}

async function uploadEasyBrokerImages(
  ctx: ToolContext,
  input: EasyBrokerUploadImagesInput,
  creds: EasyBrokerCredentials
) {
  const images = await resolveEasyBrokerImagePayloads(ctx, input);
  const payload = {
    images: images.map((image) => ({
      url: image.url,
      ...(image.title ? { title: image.title } : {}),
    })),
  };
  if (input.dry_run) {
    return {
      ok: true,
      status: "dry_run",
      credential_source: creds.source,
      listing_id: input.listing_id,
      count: images.length,
      images,
      payload,
      hint:
        "Dry-run local: no se envió PATCH /v1/properties/{listing_id} a EasyBroker.",
    };
  }
  const response = await easyBrokerApiRequest(
    creds,
    `/v1/properties/${encodeURIComponent(input.listing_id)}`,
    {
      method: "PATCH",
      body: payload,
    }
  );
  return {
    ok: true,
    status: "images_submitted",
    credential_source: creds.source,
    listing_id: input.listing_id,
    count: images.length,
    images,
    caveat:
      "EasyBroker procesa imágenes de forma asíncrona. En PATCH, el arreglo images reemplaza las imágenes existentes de la propiedad.",
    raw: truncatePayload(response.payload),
  };
}

function buildEasyBrokerCreatePayload(input: EasyBrokerCreateListingInput) {
  const customFields = parseEasyBrokerCustomFields(input);
  const location = input.location ?? {};
  const street =
    cleanString(input.street) ??
    cleanString(location.street) ??
    cleanString(location.address);
  if (!street) {
    throw new Error(
      "easybroker_create_listing requiere `street` o `location.street` para crear la propiedad."
    );
  }
  if (!input.location || Object.keys(input.location).length === 0) {
    throw new Error(
      "easybroker_create_listing requiere `location` con la ubicación registrada/compatible con EasyBroker."
    );
  }
  const easyBrokerLocation = buildEasyBrokerLocationPayload(location, street);
  if (
    easyBrokerLocation.latitude === undefined ||
    easyBrokerLocation.longitude === undefined
  ) {
    throw new Error(
      "easybroker_create_listing requiere `location.latitude` y `location.longitude` para que EasyBroker geolocalice la propiedad. Alternativa futura: integrar lookup de city_id/administrative_division_id vía /v1/locations."
    );
  }
  // EasyBroker's create docs and read responses use `rental` for long-term rentals.
  const operationTypeMap: Record<string, string> = {
    sale: "sale",
    rent: "rental",
    rental: "rental",
    temporary_rental: "temporary_rental",
  };
  const operationType = operationTypeMap[input.operation] ?? input.operation;
  const payload: Record<string, unknown> = {
    ...customFields,
    property_type: input.property_type,
    title: input.title,
    description: input.description.slice(0, 4000),
    status: input.status ?? "not_published",
    location: easyBrokerLocation,
    operations: [
      {
        type: operationType,
        amount: input.price,
        currency: input.currency ?? "MXN",
        active: true,
        unit: "total",
      },
    ],
  };
  setIfPresent(payload, "private_description", cleanString(input.private_description));
  setIfPresent(payload, "agent", cleanString(input.agent));
  setIfPresent(payload, "show_prices", input.show_prices);
  setIfPresent(payload, "bedrooms", integerOrUndefined(input.bedrooms));
  setIfPresent(payload, "bathrooms", integerOrUndefined(input.bathrooms));
  setIfPresent(payload, "half_bathrooms", integerOrUndefined(input.half_bathrooms));
  setIfPresent(
    payload,
    "parking_spaces",
    integerOrUndefined(input.parking_spaces ?? input.parking)
  );
  setIfPresent(payload, "age", cleanString(input.age));
  setIfPresent(payload, "floor", cleanString(input.floor));
  setIfPresent(payload, "floors", integerOrUndefined(input.floors));
  setIfPresent(payload, "expenses", cleanString(input.expenses));
  setIfPresent(payload, "internal_id", cleanString(input.internal_id));
  setIfPresent(payload, "tags", nonEmptyStringArray(input.tags));
  // `features` must match EasyBroker's feature catalog exactly; omit from the
  // generic test recipe unless caller explicitly maps known-valid names later.
  setIfPresent(payload, "share_commission", input.share_commission);
  setIfPresent(payload, "collaboration_notes", cleanString(input.collaboration_notes));
  if (input.shared_commission_percentage !== undefined) {
    payload.shared_commission_percentage = input.shared_commission_percentage;
  }
  setIfPresent(
    payload,
    "construction_size",
    numberOrUndefined(input.construction_size ?? input.area_m2)
  );
  setIfPresent(payload, "lot_size", numberOrUndefined(input.lot_size));
  setIfPresent(payload, "lot_length", numberOrUndefined(input.lot_length));
  setIfPresent(payload, "lot_width", numberOrUndefined(input.lot_width));
  setIfPresent(payload, "covered_space", numberOrUndefined(input.covered_space));
  if (input.exclusive !== undefined) payload.exclusive = input.exclusive;
  setIfPresent(payload, "videos", nonEmptyStringArray(input.videos));
  setIfPresent(payload, "virtual_tour", cleanString(input.virtual_tour));
  setIfPresent(payload, "show_exact_location", input.show_exact_location ?? false);
  return payload;
}

function parseEasyBrokerCustomFields(input: EasyBrokerCreateListingInput) {
  const custom: Record<string, unknown> = { ...(input.custom_fields ?? {}) };
  if (input.custom_fields_json?.trim()) {
    const parsed = JSON.parse(input.custom_fields_json) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("custom_fields_json debe ser un objeto JSON.");
    }
    Object.assign(custom, parsed as Record<string, unknown>);
  }
  return custom;
}

function buildEasyBrokerLocationPayload(
  location: EasyBrokerListingLocationInput,
  street?: string
) {
  // OpenAPI create schema:
  // location.name is the registered full location string returned by /locations.
  // Do not send city_area/city/region/show_exact_location here; those appear in
  // read responses but are not permitted in POST /properties.
  const payload: Record<string, unknown> = {};
  const locationName =
    cleanString(location.full_name) ??
    cleanString(location.name) ??
    [location.city_area ?? location.neighborhood, location.city, location.region ?? location.state]
      .map(cleanString)
      .filter(Boolean)
      .join(", ");
  setIfPresent(payload, "name", cleanString(locationName));
  setIfPresent(payload, "street", cleanString(street));
  setIfPresent(payload, "postal_code", cleanString(location.postal_code));
  setIfPresent(payload, "latitude", numberOrUndefined(location.latitude));
  setIfPresent(payload, "longitude", numberOrUndefined(location.longitude));
  return payload;
}

async function resolveEasyBrokerImagePayloads(
  ctx: ToolContext,
  input: EasyBrokerUploadImagesInput
): Promise<EasyBrokerImagePayload[]> {
  if (input.image_paths.length > 50) {
    throw new Error("EasyBroker permite máximo 50 imágenes por propiedad.");
  }
  const images = await Promise.all(
    input.image_paths.map(async (imagePath, index) => {
      const title = input.image_titles?.[index]?.trim() || null;
      if (/^https?:\/\//i.test(imagePath)) {
        return { url: imagePath, title, source_path: imagePath };
      }
      const parsed = parseStoragePath(imagePath);
      const shortUrl = await publicAccountAssetUrlForEasyBroker(ctx, parsed);
      if (shortUrl) {
        return {
          url: shortUrl,
          title,
          source_path: imagePath,
        };
      }
      const { data, error } = await ctx.db.storage
        .from(parsed.bucket)
        .createSignedUrl(parsed.path, EASYBROKER_SIGNED_URL_TTL_SECONDS);
      if (error || !data?.signedUrl) {
        throw new Error(
          `No se pudo generar signed URL para ${imagePath}: ${
            error?.message ?? "respuesta vacía"
          }`
        );
      }
      return {
        url: ensureEasyBrokerImageUrlIsAccepted(
          ensureEasyBrokerImageUrlExtension(data.signedUrl, parsed.path)
        ),
        title,
        source_path: imagePath,
        expires_in_seconds: EASYBROKER_SIGNED_URL_TTL_SECONDS,
      };
    })
  );
  return images;
}

async function publicAccountAssetUrlForEasyBroker(
  ctx: ToolContext,
  parsed: { bucket: string; path: string }
) {
  const siteUrl = publicSiteUrl();
  if (!siteUrl) return null;
  const asset = await getAccountAssetByStoragePath(ctx.db, {
    storageBucket: parsed.bucket,
    storagePath: parsed.path,
  });
  if (!asset) return null;
  const extension = path.extname(parsed.path).replace(/^\./, "").toLowerCase();
  if (!["jpg", "jpeg", "png", "gif", "bmp", "heic"].includes(extension)) {
    throw new Error(
      `EasyBroker requiere URLs de imagen con extensión jpg/png/gif/bmp/heic; path recibido: ${parsed.path}`
    );
  }
  return ensureEasyBrokerImageUrlIsAccepted(
    `${siteUrl}/api/public/account-assets/${asset.id}/image.${extension}`
  );
}

function publicSiteUrl() {
  const explicit = process.env.EASYBROKER_PUBLIC_ASSET_BASE_URL?.trim();
  const configured =
    explicit ||
    process.env.NEXT_PUBLIC_SITE_URL?.trim() ||
    process.env.VERCEL_URL?.trim();
  if (!configured) return null;
  const withProtocol = /^https?:\/\//i.test(configured)
    ? configured
    : `https://${configured}`;
  const normalized = withProtocol.replace(/\/+$/, "");
  if (!explicit && /^https?:\/\/(localhost|127\.0\.0\.1)(?::\d+)?$/i.test(normalized)) {
    return null;
  }
  return normalized;
}

function ensureEasyBrokerImageUrlIsAccepted(url: string) {
  if (url.length <= EASYBROKER_MAX_IMAGE_URL_LENGTH) return url;
  throw new Error(
    `EasyBroker permite máximo ${EASYBROKER_MAX_IMAGE_URL_LENGTH} caracteres por URL de imagen; URL generada mide ${url.length}. Configura EASYBROKER_PUBLIC_ASSET_BASE_URL o NEXT_PUBLIC_SITE_URL con una URL pública corta.`
  );
}

function ensureEasyBrokerImageUrlExtension(url: string, sourcePath: string) {
  if (/\.(jpe?g|png|gif|bmp|heic)(?:[?#]|$)/i.test(url)) return url;
  const extension = path.extname(sourcePath).replace(/^\./, "").toLowerCase();
  if (!["jpg", "jpeg", "png", "gif", "bmp", "heic"].includes(extension)) {
    throw new Error(
      `EasyBroker requiere URLs de imagen con extensión jpg/png/gif/bmp/heic; path recibido: ${sourcePath}`
    );
  }
  return `${url}${url.includes("?") ? "&" : "?"}filename=image.${extension}`;
}

async function easyBrokerApiRequest(
  creds: EasyBrokerCredentials,
  pathname: string,
  options: { method: "POST" | "PATCH"; body: Record<string, unknown> }
) {
  const base = process.env.EASYBROKER_API_BASE?.trim() || "https://api.easybroker.com";
  const url = new URL(pathname, base.replace(/\/$/, ""));
  const res = await fetch(url, {
    method: options.method,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "Country-Code": "MX",
      "X-Authorization": creds.apiKey,
    },
    body: JSON.stringify(options.body),
  });
  const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new EasyBrokerApiError(
      `EasyBroker respondió ${res.status}: ${errorMessageFromPayload(payload)}`,
      res.status,
      payload
    );
  }
  return { status: res.status, payload };
}

function isEasyBrokerCredentialFailure(error: unknown) {
  return error instanceof EasyBrokerApiError
    ? error.statusCode === 401 || error.statusCode === 403
    : false;
}

async function markEasyBrokerCredentialResult(
  ctx: ToolContext,
  creds: EasyBrokerCredentials,
  ok: boolean,
  error?: unknown
) {
  if (ok) {
    await markAccountSecretSuccess(ctx, ACCOUNT_TOOL_PROVIDERS_REALESTATE.easybroker);
    return;
  }
  if (creds.source === "account") {
    await markAccountSecretFailure(
      ctx,
      ACCOUNT_TOOL_PROVIDERS_REALESTATE.easybroker,
      String(error ?? "EasyBroker write failed")
    );
  }
}

function cleanString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function setIfPresent(target: Record<string, unknown>, key: string, value: unknown) {
  if (value !== undefined && value !== null) target[key] = value;
}

function integerOrUndefined(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : undefined;
}

function numberOrUndefined(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonEmptyStringArray(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  const strings = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
  return strings.length ? strings : undefined;
}

function stringFromPayload(payload: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function easyBrokerAgentUrlFromPublicUrl(publicUrl: string | null) {
  if (!publicUrl) return null;
  try {
    const url = new URL(publicUrl);
    const slug = url.pathname.split("/").filter(Boolean).at(-1);
    if (!slug) return null;
    return `${url.origin}/agent/properties/${slug}`;
  } catch {
    return null;
  }
}

function truncatePayload(payload: Record<string, unknown>) {
  const serialized = JSON.stringify(payload);
  if (serialized.length <= 5000) return payload;
  return {
    truncated: true,
    preview: serialized.slice(0, 5000),
  };
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
