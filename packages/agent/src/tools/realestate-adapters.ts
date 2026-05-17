/**
 * LangChain adapters para tools del dominio inmobiliario:
 *   - telegram_send_message_to_contact (real)
 *   - easybroker_search_listings, easybroker_search_closed_deals (stub HTTP)
 *   - easybroker_create_listing, easybroker_upload_images (stub HTTP, write)
 *   - bigquery_lookup_local_comparables (real, sobre bigquery_run_query)
 *   - generate_document_from_template (stub: necesita templates por tenant)
 *   - image_watermark (stub: necesita asset por tenant)
 *   - ungga_publish_listing (stub: depende del POC API)
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
import { z } from "zod";
import {
  createToolCall,
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
  resolveUnggaCredentials,
} from "./realestate-credentials";

export interface RealEstateToolDeps {
  /**
   * Envía un mensaje de Telegram a un chat_id arbitrario. La implementación
   * vive en `apps/web/src/lib/telegram/send-message.ts`. Si lanza, el wrapper
   * registra el fallo y devuelve `{ ok: false, error }` al modelo.
   */
  sendTelegramMessage?: (chatId: number, text: string) => Promise<void>;
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

  // ── EasyBroker (read) — stub HTTP que respeta EASYBROKER_API_KEY ────
  if (toolEnabled("easybroker_search_listings", ctx)) {
    tools.push(makeEasyBrokerSearchTool(ctx, "easybroker_search_listings", "/properties"));
  }
  if (toolEnabled("easybroker_search_closed_deals", ctx)) {
    tools.push(
      makeEasyBrokerSearchTool(
        ctx,
        "easybroker_search_closed_deals",
        "/properties?status=closed"
      )
    );
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

  // ── Generate document — stub que indica plantilla faltante ─────────
  if (toolEnabled("generate_document_from_template", ctx)) {
    tools.push(
      tool(
        async (input: {
          template_slug: string;
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
          const out = {
            status: "not_configured",
            hint:
              "La tabla `realestate_templates(tenant, slug, body, fields_schema)` aún no está poblada para este tenant. Necesito la plantilla DOCX (con placeholders {{nombre}}, etc.) y el listado de campos. Cuando esté, este handler renderiza con `docx`/`pdf-lib` y devuelve la URL del archivo.",
            requested_template: input.template_slug,
            requested_format: input.format,
            received_fields: Object.keys(input.data),
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
          name: "generate_document_from_template",
          description:
            "Renders a DOCX/PDF document from a stored tenant-scoped template.",
          schema: z.object({
            template_slug: z.string().min(1),
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

  // ── Ungga publish — HTTP que prefiere account-tool secret → env ────
  if (toolEnabled("ungga_publish_listing", ctx)) {
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
          const creds = await resolveUnggaCredentials(ctx);
          if (!creds) {
            const out = {
              status: "not_configured",
              hint:
                "La API interna de Ungga no está configurada para esta cuenta. Conéctala desde Ajustes → Cuentas externas (Base URL + API Token) o pide al admin que configure las env vars UNGGA_INTERNAL_API_BASE / UNGGA_INTERNAL_API_TOKEN.",
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
            const res = await fetch(
              `${creds.apiBase.replace(/\/$/, "")}/v1/internal/listings`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${creds.apiToken}`,
                },
                body: JSON.stringify(input),
              }
            );
            const text = await res.text();
            const data = (() => {
              try {
                return JSON.parse(text);
              } catch {
                return { raw: text };
              }
            })();
            const out =
              res.ok
                ? { ok: true, status_code: res.status, data, credential_source: creds.source }
                : { ok: false, status_code: res.status, data, credential_source: creds.source };
            if (creds.source === "account") {
              if (res.ok) {
                await markAccountSecretSuccess(
                  ctx,
                  ACCOUNT_TOOL_PROVIDERS_REALESTATE.ungga
                );
              } else {
                await markAccountSecretFailure(
                  ctx,
                  ACCOUNT_TOOL_PROVIDERS_REALESTATE.ungga,
                  `HTTP ${res.status}`
                );
              }
            }
            await updateToolCallStatus(
              ctx.db,
              record.id,
              res.ok ? "executed" : "failed",
              out as unknown as Record<string, unknown>
            );
            return JSON.stringify(out);
          } catch (e) {
            const errMsg = (e as Error).message ?? String(e);
            if (creds.source === "account") {
              await markAccountSecretFailure(
                ctx,
                ACCOUNT_TOOL_PROVIDERS_REALESTATE.ungga,
                errMsg
              );
            }
            const out = { ok: false, error: errMsg };
            await updateToolCallStatus(ctx.db, record.id, "failed", out);
            return JSON.stringify(out);
          }
        },
        {
          name: "ungga_publish_listing",
          description: "Publishes a listing to Ungga via the internal API.",
          schema: z.object({
            title: z.string().min(1),
            description: z.string().optional(),
            operation: z.string().min(1),
            property_type: z.string().min(1),
            price: z.number().positive(),
            currency: z.string().optional(),
            location: z.record(z.string(), z.any()).optional(),
            image_urls: z.array(z.string().url()).optional(),
            case_id: z.string().min(1).optional(),
          }),
        }
      )
    );
  }
}

// ============================================================
// Helpers
// ============================================================

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

function makeEasyBrokerSearchTool(
  ctx: ToolContext,
  toolId: "easybroker_search_listings" | "easybroker_search_closed_deals",
  pathHint: string
) {
  return tool(
    async (input: Record<string, unknown>) => {
      const record = await createToolCall(
        ctx.db,
        ctx.sessionId,
        toolId,
        input,
        false,
        ctx.turnId
      );
      const creds = await resolveEasyBrokerCredentials(ctx);
      if (!creds) {
        const out = {
          status: "not_configured",
          hint:
            "EasyBroker no está conectado para esta cuenta. Conéctalo desde Ajustes → Cuentas externas o desde la pantalla de Casos de uso.",
        };
        await updateToolCallStatus(
          ctx.db,
          record.id,
          "executed",
          out as unknown as Record<string, unknown>
        );
        return JSON.stringify(out);
      }
      // El API real de EasyBroker tiene su propio shape; este wrapper
      // construye la URL de búsqueda con los filtros básicos. Cuando
      // confirmemos los nombres exactos de query params (e.g. operation_type),
      // ajustamos. De momento devolvemos un stub controlado pero ya marca
      // el uso de la credencial per-account para promoverla a `active`.
      if (creds.source === "account") {
        // El stub no ejecuta la request real todavía, pero ya confirmamos
        // que existe credencial válida en formato. Marcamos uso para que
        // la UI vea actividad.
        await markAccountSecretSuccess(
          ctx,
          ACCOUNT_TOOL_PROVIDERS_REALESTATE.easybroker
        );
      }
      const out = {
        status: "stub",
        credential_source: creds.source,
        hint:
          "Wrapper EasyBroker pendiente de mapear filtros a query params reales (operation_type, location, etc.). Mientras tanto consulta la docs y actualiza este adapter.",
        path_hint: pathHint,
        received_filters: input,
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
        toolId === "easybroker_search_listings"
          ? "Searches EasyBroker listings (read-only)."
          : "Searches EasyBroker closed/sold deals (read-only).",
      schema: z.object({
        zona: z.string().optional(),
        operation: z.enum(["sale", "rent"]).optional(),
        property_type: z.string().optional(),
        min_price: z.number().nonnegative().optional(),
        max_price: z.number().nonnegative().optional(),
        min_area_m2: z.number().nonnegative().optional(),
        max_area_m2: z.number().nonnegative().optional(),
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
      schema: z.record(z.string(), z.any()),
    }
  );
}
