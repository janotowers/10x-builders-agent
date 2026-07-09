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
import { getAccountAssetByStoragePath,
  listAccountAssets,
  updateToolCallStatus,
  getOperationalCase,
  listOperationalCaseDocuments,
  insertOperationalCaseEvent,
  updateOperationalCase,
  createExternalContactNotification,
} from "@agents/db";
import type { ToolContext } from "./tool-context";
import { createTrackedToolCall } from "./tool-call-audit";
import {
  generatedDocumentDedupKey,
  normalizeGeneratedDocumentArgs,
  normalizeTelegramSendText,
  resolveOperationalCaseDocumentRequestTarget,
  SETTINGS_TEST_TELEGRAM_LAB_CHAT_ID,
  telegramSendInputsMatch,
  type ToolCallSource,
} from "@agents/types";
import { deriveCommissionContractTemplateData } from "./commission-contract-template-data";
import {
  buildPropertyDataMinimumsSummaryMessage,
  documentExtractionMinimumsContext,
  evaluatePropertyAdvanceGate,
  evaluatePropertyDataMinimumsForReview,
  ownerConsistencyStatusFromFields,
} from "./operational-cases-adapters";
import { sanitizeComparableSearchFilters } from "../operational-cases/comparable-search-contract";

/** Outbound Telegram messages that expect a reply from the external contact. */
const TELEGRAM_REPLY_EXPECTED_PURPOSES = new Set([
  "request_documents",
  "characteristics_pending",
]);
const TELEGRAM_EXTERNAL_CONTACT_PURPOSES = new Set([
  "request_documents",
  "initial_request",
  "characteristics_pending",
]);

function isSettingsOperationalTestCase(
  context: Record<string, unknown> | null | undefined
): boolean {
  if (!context) return false;
  return (
    context.created_from === "case_type_settings_test" &&
    (context.test_mode === true || context.test_mode === "true")
  );
}

function isControlledConversationalE2ECase(
  context: Record<string, unknown> | null | undefined
): boolean {
  if (!context) return false;
  return (
    context.created_from === "agent_conversation" &&
    context.e2e_controlled === true
  );
}

function shouldSimulateLabTelegramSend(
  chatId: number,
  toolCallSource?: ToolCallSource
): boolean {
  if (
    toolCallSource !== "skill_test" &&
    toolCallSource !== "step_test" &&
    toolCallSource !== "agent_e2e"
  ) {
    return false;
  }
  if (chatId === SETTINGS_TEST_TELEGRAM_LAB_CHAT_ID) return true;
  return !Number.isFinite(chatId) || chatId <= 0;
}

function telegramSendDedupKey(args: Record<string, unknown>): string {
  return [
    String(args.chat_id ?? ""),
    String(args.case_id ?? ""),
    String(args.purpose ?? ""),
    normalizeTelegramSendText(args.text),
  ].join("|");
}

function hasTelegramSendDedupKey(
  ctx: ToolContext,
  args: Record<string, unknown>
): boolean {
  const key = telegramSendDedupKey(args);
  return ctx.telegramSendDedupKeys?.has(key) ?? false;
}

/** Reserva el slot justo antes de enviar (no al crear la fila de auditoría). */
function claimTelegramSendDedupSlot(
  ctx: ToolContext,
  args: Record<string, unknown>
): void {
  const key = telegramSendDedupKey(args);
  if (!ctx.telegramSendDedupKeys) {
    ctx.telegramSendDedupKeys = new Set<string>();
  }
  ctx.telegramSendDedupKeys.add(key);
}

function documentArgsForDedup(
  ctx: ToolContext,
  args: Record<string, unknown>
): Record<string, unknown> {
  return normalizeGeneratedDocumentArgs(args, { caseIdFallback: ctx.caseId });
}

function documentDedupOptions(ctx: ToolContext) {
  return { caseIdFallback: ctx.caseId };
}

function claimGenerateDocumentDedupSlot(
  ctx: ToolContext,
  args: Record<string, unknown>
): void {
  const key = generatedDocumentDedupKey(
    documentArgsForDedup(ctx, args),
    documentDedupOptions(ctx)
  );
  if (!ctx.generateDocumentDedupKeys) {
    ctx.generateDocumentDedupKeys = new Set<string>();
  }
  ctx.generateDocumentDedupKeys.add(key);
}

function generateDocumentInFlightKey(
  ctx: ToolContext,
  args: Record<string, unknown>
): string {
  return `${ctx.sessionId}::${ctx.turnId ?? ""}::${generatedDocumentDedupKey(
    documentArgsForDedup(ctx, args),
    documentDedupOptions(ctx)
  )}`;
}

function createGenerateDocumentDeferred(): {
  promise: Promise<Record<string, unknown>>;
  resolve: (value: Record<string, unknown>) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: Record<string, unknown>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Record<string, unknown>>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function buildGenerateDocumentDedupResult(
  original: { id: string; result_json: Record<string, unknown> }
): Record<string, unknown> {
  return {
    ...original.result_json,
    ok: true,
    skipped_render: true,
    status: "deduplicated_same_turn",
    original_tool_call_id: original.id,
    hint:
      "Render de documento duplicado en el mismo turno (misma plantilla, formato y caso); se reutilizó el borrador ya generado.",
  };
}

async function findDuplicateTelegramCallInTurn(
  ctx: ToolContext,
  recordId: string,
  args: Record<string, unknown>
) {
  if (!ctx.turnId) return null;
  const { data, error } = await ctx.db
    .from("tool_calls")
    .select("id,status,arguments_json,result_json,created_at")
    .eq("turn_id", ctx.turnId)
    .eq("tool_name", "telegram_send_message_to_contact")
    .neq("id", recordId)
    .eq("status", "executed")
    .order("created_at", { ascending: true })
    .limit(20);
  if (error) {
    console.warn("[realestate] telegram_send: duplicate lookup failed:", error);
    return null;
  }
  return (
    (data ?? []).find((call) => {
      const result = call.result_json as Record<string, unknown> | null;
      if (result?.skipped_send === true) return false;
      return telegramSendInputsMatch(
        (call.arguments_json as Record<string, unknown>) ?? {},
        args
      );
    }) ?? null
  );
}
import {
  ACCOUNT_TOOL_PROVIDERS_REALESTATE,
  resolveAvaclickCredentials,
  markAccountSecretFailure,
  markAccountSecretSuccess,
  resolveEasyBrokerCredentials,
  resolveEasyBrokerWebCredentials,
  resolveUnggaCliCredentials,
  resolveUnggaCredentials,
} from "./realestate-credentials";
import {
  getAvaclickValuation,
  type AvaclickValuationInput,
} from "./avaclick";
import { geocodePropertyAddress } from "./geocoding";
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
const IMAGE_VISION_MODEL_ID =
  process.env.IMAGE_VISION_MODEL_ID?.trim() || "openai/gpt-4.1-mini";
const IMAGE_VISION_MAX_TOKENS = Number(
  process.env.IMAGE_VISION_MAX_TOKENS?.trim() || "2200"
);
const IMAGE_VISION_TEMPERATURE = Number(
  process.env.IMAGE_VISION_TEMPERATURE?.trim() || "0"
);
const LISTING_COPY_MODEL_ID =
  process.env.LISTING_COPY_MODEL_ID?.trim() || "openai/gpt-4.1-mini";
const LISTING_COPY_MAX_TOKENS = Number(
  process.env.LISTING_COPY_MAX_TOKENS?.trim() || "1200"
);
const LISTING_COPY_TEMPERATURE = Number(
  process.env.LISTING_COPY_TEMPERATURE?.trim() || "0.1"
);

type OpenRouterMessage = {
  role: "system" | "user" | "assistant";
  content: unknown;
};

async function callOpenRouterJsonTool(input: {
  model: string;
  maxTokens: number;
  temperature: number;
  messages: OpenRouterMessage[];
}) {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("missing_openrouter_api_key");
  }
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://agents.local",
    },
    body: JSON.stringify({
      model: input.model,
      temperature: Number.isFinite(input.temperature) ? input.temperature : 0,
      max_tokens: Number.isFinite(input.maxTokens) ? input.maxTokens : 1000,
      messages: input.messages,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  };
  const content = body.choices?.[0]?.message?.content;
  if (!res.ok || !content) {
    throw new Error(body.error?.message ?? `model_request_failed_${res.status}`);
  }
  return parseLenientJson(content);
}

function parseLenientJson(content: string): Record<string, unknown> {
  const trimmed = content.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
    if (fenced) {
      try {
        return JSON.parse(fenced) as Record<string, unknown>;
      } catch {
        // continue
      }
    }
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
      } catch {
        // continue
      }
    }
  }
  throw new Error("invalid_json_response");
}

function ensureStringArray(value: unknown, max = 24): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0)
    .slice(0, max);
}

function cleanNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    const cleaned = cleanNonEmptyString(value);
    if (cleaned) return cleaned;
  }
  return null;
}

function composeAddressFromRecord(address: Record<string, unknown>): string | null {
  const street = firstNonEmptyString(address.street, address.calle);
  const exterior = firstNonEmptyString(address.exterior_number, address.numero_exterior);
  const neighborhood = firstNonEmptyString(address.neighborhood, address.colonia);
  const municipality = firstNonEmptyString(
    address.municipality,
    address.municipio,
    address.city
  );
  const state = firstNonEmptyString(address.state, address.estado);
  const country = firstNonEmptyString(address.country, address.pais);
  const firstLine = [street, exterior].filter(Boolean).join(" ").trim();
  const parts = [firstLine, neighborhood, municipality, state, country].filter(
    (part): part is string => Boolean(part)
  );
  return parts.length > 0 ? parts.join(", ") : null;
}

function normalizeMissingIngredientsForDisplay(input: {
  missingIngredients: string[];
  ingredientPayload: Record<string, unknown>;
}): string[] {
  const payload = input.ingredientPayload;
  const municipality = cleanNonEmptyString(payload.municipality);
  const state = cleanNonEmptyString(payload.state);
  const neighborhood = cleanNonEmptyString(payload.neighborhood);
  const areaBuilt = payload.area_built_m2;
  return input.missingIngredients.filter((entry) => {
    const key = entry.trim().toLowerCase();
    if (!key) return false;
    if ((key === "municipality" || key === "municipality_state") && municipality) {
      return false;
    }
    if ((key === "state" || key === "municipality_state") && state) {
      return false;
    }
    if (key === "neighborhood" && neighborhood) {
      return false;
    }
    if (
      key === "area_built_m2" &&
      typeof areaBuilt === "number" &&
      Number.isFinite(areaBuilt) &&
      areaBuilt > 0
    ) {
      return false;
    }
    return true;
  });
}

function asPlainRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function persistCaseContextPatch(
  ctx: ToolContext,
  caseId: string,
  patch: Record<string, unknown>,
  eventPayload?: Record<string, unknown>
) {
  let current = await getOperationalCase(ctx.db, caseId);
  if (!current || current.user_id !== ctx.userId) return null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const mergedContext = {
      ...(asPlainRecord(current.context_jsonb) ?? {}),
      ...patch,
    };
    const updated = await updateOperationalCase(ctx.db, current.id, current.version, {
      context: mergedContext,
    });
    if (updated) {
      if (eventPayload) {
        await insertOperationalCaseEvent(ctx.db, {
          caseId: updated.id,
          eventType: "state_changed",
          actor: "agent",
          payload: eventPayload,
        });
      }
      return updated;
    }
    const reread = await getOperationalCase(ctx.db, caseId);
    if (!reread || reread.user_id !== ctx.userId) return null;
    current = reread;
  }
  return null;
}

async function persistPublishedDestination(
  ctx: ToolContext,
  caseId: string,
  destination: "easybroker" | "ungga",
  payload: Record<string, unknown>
) {
  const opCase = await getOperationalCase(ctx.db, caseId);
  if (!opCase || opCase.user_id !== ctx.userId) return null;
  const currentContext = asPlainRecord(opCase.context_jsonb);
  const published = asPlainRecord(currentContext.published);
  const destinationCurrent = asPlainRecord(published[destination]);
  const destinationPatch = {
    ...destinationCurrent,
    ...payload,
    updated_at: new Date().toISOString(),
  };
  const nextPublished = {
    ...published,
    [destination]: destinationPatch,
  };
  return persistCaseContextPatch(
    ctx,
    caseId,
    { published: nextPublished },
    {
      kind: "listing_publish_destination_persisted",
      destination,
      ...payload,
    }
  );
}

function safeNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function haversineMeters(
  fromLat: number,
  fromLon: number,
  toLat: number,
  toLon: number
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const r = 6371_000;
  const dLat = toRad(toLat - fromLat);
  const dLon = toRad(toLon - fromLon);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(fromLat)) *
      Math.cos(toRad(toLat)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(r * c);
}

async function applyTelegramSendCaseWiring(
  ctx: ToolContext,
  input: {
    chat_id: number;
    text: string;
    case_id?: string;
    purpose?: string;
  },
  opCase: import("@agents/types").OperationalCase,
  suppressExternalNotification: boolean
) {
  let caseForUpdate = opCase;
  const currentChatId = (caseForUpdate.external_contact_jsonb as Record<string, unknown>)
    ?.chat_id;
  const chatIdMatches =
    currentChatId !== undefined && String(currentChatId) === String(input.chat_id);
  if (!chatIdMatches) {
    let rewired = await updateOperationalCase(
      ctx.db,
      caseForUpdate.id,
      caseForUpdate.version,
      {
        externalContact: {
          ...(caseForUpdate.external_contact_jsonb as import("@agents/types").OperationalCaseExternalContact),
          channel: "telegram",
          chat_id: input.chat_id,
        },
      }
    );
    if (!rewired) {
      const latest = await getOperationalCase(ctx.db, caseForUpdate.id);
      if (latest && latest.user_id === ctx.userId) {
        rewired = await updateOperationalCase(ctx.db, latest.id, latest.version, {
          externalContact: {
            ...(latest.external_contact_jsonb as import("@agents/types").OperationalCaseExternalContact),
            channel: "telegram",
            chat_id: input.chat_id,
          },
        });
      }
    }
    if (rewired) {
      caseForUpdate = rewired;
    }
  }
  await insertOperationalCaseEvent(ctx.db, {
    caseId: caseForUpdate.id,
    eventType: "reminder_sent",
    actor: "agent",
    payload: {
      channel: "telegram",
      chat_id: input.chat_id,
      purpose: input.purpose ?? "outbound",
      text_preview: input.text.slice(0, 200),
    },
  });
  if (!suppressExternalNotification) {
    await createExternalContactNotification(ctx.db, {
      userId: ctx.userId,
      caseId: caseForUpdate.id,
      contact: {
        ...(caseForUpdate.external_contact_jsonb as Record<string, unknown>),
        channel: "telegram",
        chat_id: input.chat_id,
      },
      channel: "telegram",
      recipientIdentifier: String(input.chat_id),
      messageBody: input.text,
      status: "sent",
      nextReminderAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
      metadata: {
        purpose: input.purpose ?? "outbound",
        source: "telegram_send_message_to_contact",
      },
    });
  }
  const purpose = input.purpose ?? "outbound";
  if (TELEGRAM_REPLY_EXPECTED_PURPOSES.has(purpose)) {
    const latest = await getOperationalCase(ctx.db, caseForUpdate.id);
    if (latest && latest.user_id === ctx.userId) {
      await updateOperationalCase(ctx.db, latest.id, latest.version, {
        status: "waiting_external",
        currentStep:
          purpose === "characteristics_pending"
            ? "documents_received"
            : latest.current_step,
        nextActionAt: suppressExternalNotification
          ? null
          : new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
      });
    }
  }
}

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
          const record = await createTrackedToolCall(ctx, "telegram_send_message_to_contact",
            input as unknown as Record<string, unknown>,
            true);
          const inputRecord = input as unknown as Record<string, unknown>;
          const inMemoryDuplicate = hasTelegramSendDedupKey(ctx, inputRecord);
          const duplicateInTurn = await findDuplicateTelegramCallInTurn(
            ctx,
            record.id,
            inputRecord
          );
          const duplicate =
            duplicateInTurn ??
            (inMemoryDuplicate ? { id: "in_memory_same_turn" } : null);
          if (duplicate) {
            const out = {
              ok: true,
              chat_id: input.chat_id,
              skipped_send: true,
              status: "deduplicated_same_turn",
              original_tool_call_id: duplicate.id,
              hint:
                "Duplicate Telegram send (mismo chat_id/case_id/purpose y texto equivalente tras normalización) en el mismo turno; se omitió el segundo envío.",
            };
            await updateToolCallStatus(ctx.db, record.id, "executed", out);
            return JSON.stringify(out);
          }
          claimTelegramSendDedupSlot(ctx, inputRecord);

          let opCase: import("@agents/types").OperationalCase | null = null;
          let settingsTestCase = false;
          let controlledConversationalE2ECase = false;
          if (input.case_id) {
            try {
              const loaded = await getOperationalCase(ctx.db, input.case_id);
              if (loaded && loaded.user_id === ctx.userId) {
                opCase = loaded;
                settingsTestCase = isSettingsOperationalTestCase(
                  loaded.context_jsonb as Record<string, unknown>
                );
                controlledConversationalE2ECase =
                  isControlledConversationalE2ECase(
                    loaded.context_jsonb as Record<string, unknown>
                  );
              }
            } catch (e) {
              console.warn("[realestate] telegram_send: case preload failed:", e);
            }
          }

          if (
            opCase &&
            input.purpose === "characteristics_pending" &&
            opCase.current_step === "documents_received"
          ) {
            try {
              const documents = await listOperationalCaseDocuments(ctx.db, {
                caseId: opCase.id,
                statuses: ["received"],
              });
              const documentFields = documentExtractionMinimumsContext(documents);
              const minimums = evaluatePropertyDataMinimumsForReview(
                opCase.context_jsonb,
                documentFields
              );
              if (!minimums.ok) {
                input.text = buildPropertyDataMinimumsSummaryMessage({
                  context: opCase.context_jsonb,
                  supplement: documentFields,
                  missing: minimums.missing,
                });
              }
            } catch (e) {
              console.warn(
                "[realestate] telegram_send: characteristics message normalization failed:",
                e
              );
            }
          }

          if (opCase) {
            const target = resolveOperationalCaseDocumentRequestTarget({
              externalContact: opCase.external_contact_jsonb,
              context: opCase.context_jsonb as Record<string, unknown>,
            });
            const purpose = input.purpose ?? "outbound";
            if (
              target === "internal_user" &&
              TELEGRAM_EXTERNAL_CONTACT_PURPOSES.has(purpose)
            ) {
              const out = {
                ok: false,
                status: "blocked_by_document_request_target",
                document_request_target: target,
                case_id: opCase.id,
                purpose,
                skipped_send: true,
                hint:
                  "Este caso está configurado para solicitar documentos al equipo interno. Usa notify_user o cambia document_request_target a external_contact antes de enviar al contacto externo.",
              };
              await updateToolCallStatus(ctx.db, record.id, "failed", out);
              return JSON.stringify(out);
            }
          }

          const simulateLabSend =
            (settingsTestCase || controlledConversationalE2ECase) &&
            shouldSimulateLabTelegramSend(
              input.chat_id,
              ctx.toolCallSource
            );

          if (simulateLabSend) {
            const out = {
              ok: true,
              chat_id: input.chat_id,
              settings_test_simulated: true,
              status: "settings_test_simulated",
              hint:
                "Envío a Telegram simulado en caso de prueba del laboratorio (sin chat_id real o id de laboratorio).",
            };
            await updateToolCallStatus(ctx.db, record.id, "executed", out);
            if (opCase) {
              try {
                await applyTelegramSendCaseWiring(
                  ctx,
                  input,
                  opCase,
                  true
                );
              } catch (e) {
                console.warn(
                  "[realestate] telegram_send: lab simulate wiring failed:",
                  e
                );
              }
            }
            return JSON.stringify(out);
          }

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

          if (input.case_id) {
            try {
              const caseForWiring =
                opCase ?? (await getOperationalCase(ctx.db, input.case_id));
              if (caseForWiring && caseForWiring.user_id === ctx.userId) {
                const labCase = isSettingsOperationalTestCase(
                  caseForWiring.context_jsonb as Record<string, unknown>
                );
                await applyTelegramSendCaseWiring(
                  ctx,
                  input,
                  caseForWiring,
                  labCase
                );
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

  // ── Address geocoding (read) ────────────────────────────────────────
  if (toolEnabled("geocode_property_address", ctx)) {
    tools.push(
      tool(
        async (input: {
          street?: string;
          exterior_number?: string;
          neighborhood?: string;
          municipality?: string;
          state?: string;
          postal_code?: string;
          country?: string;
        }) => {
          const record = await createTrackedToolCall(
            ctx,
            "geocode_property_address",
            input as unknown as Record<string, unknown>,
            false
          );
          const enrichedInput = await enrichGeocodeInputFromCaseContext(ctx, input);
          const out = await geocodePropertyAddress(enrichedInput);
          if (out.ok && out.status === "ok" && out.confidence === "high") {
            await persistGeocodeResultToCaseContext(ctx, enrichedInput, out);
          }
          await updateToolCallStatus(
            ctx.db,
            record.id,
            out.ok ? "executed" : "failed",
            out as unknown as Record<string, unknown>
          );
          return JSON.stringify(out);
        },
        {
          name: "geocode_property_address",
          description:
            "Geocodes a property address in Mexico and returns latitude/longitude with confidence and candidates.",
          schema: z
            .object({
              street: z.string().min(1).optional(),
              exterior_number: z.string().optional(),
              neighborhood: z.string().min(1).optional(),
              municipality: z.string().min(1).optional(),
              state: z.string().min(1).optional(),
              postal_code: z.string().min(3).max(10).optional(),
              country: z.string().min(2).max(64).optional(),
            })
            .superRefine((value, issueCtx) => {
              const filledCount = [
                value.street,
                value.neighborhood,
                value.municipality,
                value.state,
                value.postal_code,
              ].filter((item) => typeof item === "string" && item.trim().length > 0)
                .length;
              if (filledCount < 2) {
                issueCtx.addIssue({
                  code: z.ZodIssueCode.custom,
                  path: ["street"],
                  message:
                    "Proporciona al menos 2 componentes de dirección (ej. calle + municipio o colonia + municipio + estado).",
                });
              }
            }),
        }
      )
    );
  }

  // ── Listing package preparation tools (read) ───────────────────────────
  if (toolEnabled("analyze_property_images", ctx)) {
    tools.push(makeAnalyzePropertyImagesTool(ctx));
  }
  if (toolEnabled("lookup_property_surroundings", ctx)) {
    tools.push(makeLookupPropertySurroundingsTool(ctx));
  }
  if (toolEnabled("prepare_listing_description_draft", ctx)) {
    tools.push(makePrepareListingDescriptionDraftTool(ctx));
  }

  // ── Avaclick valuation (read) ───────────────────────────────────────
  if (toolEnabled("get_avaclick_valuation", ctx)) {
    tools.push(
      tool(
        async (input: AvaclickValuationInput) => {
          // Enriquecemos ANTES de persistir el tool_call para que arguments_json
          // refleje exactamente lo que se envió a Avaclick (superficies,
          // dirección, conservación), no solo el input parcial del agente.
          let enrichedInput = input;
          try {
            enrichedInput = await enrichAvaclickInputFromCaseContext(ctx, input);
          } catch {
            enrichedInput = input;
          }
          const record = await createTrackedToolCall(
            ctx,
            "get_avaclick_valuation",
            enrichedInput as unknown as Record<string, unknown>,
            false
          );
          if (enrichedInput.latitude == null || enrichedInput.longitude == null) {
            const out = {
              ok: false,
              status: "geocode_unresolved",
              message:
                "No se resolvieron coordenadas para Avaclick. Ejecuta geocode_property_address con direccion canonica o confirma candidato antes de reintentar.",
              retryable: true,
              missing_required_fields: ["latitude", "longitude"],
              hint:
                "Completa geocoding del inmueble objetivo y vuelve a ejecutar get_avaclick_valuation.",
            };
            await updateToolCallStatus(
              ctx.db,
              record.id,
              "failed",
              out as unknown as Record<string, unknown>
            );
            return JSON.stringify(out);
          }
          const creds = await resolveAvaclickCredentials(ctx);
          if (!creds) {
            const out = {
              ok: false,
              status: "not_configured",
              message:
                "Avaclick no está conectado para esta cuenta. Configura Credenciales por cuenta → Avaclick.",
              retryable: false,
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
            const out = await getAvaclickValuation(enrichedInput, creds);
            if (out.ok) {
              await markAccountSecretSuccess(
                ctx,
                ACCOUNT_TOOL_PROVIDERS_REALESTATE.avaclick
              );
            } else if (out.status === "auth_error") {
              await markAccountSecretFailure(
                ctx,
                ACCOUNT_TOOL_PROVIDERS_REALESTATE.avaclick,
                out.message
              );
            }
            await updateToolCallStatus(
              ctx.db,
              record.id,
              out.ok ? "executed" : "failed",
              out as unknown as Record<string, unknown>
            );
            return JSON.stringify(out);
          } catch (error) {
            const out = {
              ok: false,
              status: "provider_error",
              message: error instanceof Error ? error.message : String(error),
              retryable: false,
            };
            await updateToolCallStatus(
              ctx.db,
              record.id,
              "failed",
              out as unknown as Record<string, unknown>
            );
            return JSON.stringify(out);
          }
        },
        {
          name: "get_avaclick_valuation",
          description:
            "Gets an external Avaclick valuation opinion for house/condo-house/condo-apartment in Mexico.",
          schema: z.preprocess(
            normalizeAvaclickToolInput,
            z.object({
              customer_name: z.string().min(1).optional(),
              customer_email: z.string().email().optional(),
              customer_phone: z.string().min(7).optional(),
              property_type: z.enum(["house", "condo_house", "condo_apartment"]),
              latitude: z.number().min(-90).max(90).optional(),
              longitude: z.number().min(-180).max(180).optional(),
              state_name: z.string().min(1).optional(),
              municipality_name: z.string().min(1).optional(),
              neighborhood_name: z.string().min(1).optional(),
              zip_code: z.string().min(4).max(10).optional(),
              street: z.string().min(1).optional(),
              lot: z.string().optional(),
              block: z.string().optional(),
              interior_number: z.string().optional(),
              exterior_number: z.string().optional(),
              land_area_m2: z.number().positive().optional(),
              construction_area_m2: z.number().min(20),
              has_elevator: z.boolean().optional(),
              apartment_floor: z.number().int().positive().optional(),
              age_years: z.number().int().nonnegative().optional(),
              parking_spaces: z.number().int().nonnegative().optional(),
              bedrooms: z.number().int().nonnegative().optional(),
              full_bathrooms: z.number().nonnegative().optional(),
              half_bathrooms: z.number().nonnegative().optional(),
              floors: z.number().int().nonnegative().optional(),
              conservation: z.enum(["new", "very_good", "good", "regular", "bad"]).optional(),
              private_amenities: z.array(z.string()).optional(),
              common_amenities: z.array(z.string()).optional(),
            }).superRefine((value, issueCtx) => {
              if (value.property_type === "condo_apartment" && value.has_elevator) {
                if (value.apartment_floor == null || value.apartment_floor < 1) {
                  issueCtx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ["apartment_floor"],
                    message:
                      "apartment_floor es requerido para condo_apartment cuando has_elevator=true",
                  });
                }
              }
            })
          ),
        }
      )
    );
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
          const record = await createTrackedToolCall(ctx, "bigquery_lookup_local_comparables",
            input as unknown as Record<string, unknown>,
            false);
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
          schema: z.preprocess(
            normalizeBigQueryComparableLookupInput,
            z.object({
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
            })
          ),
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
          const inputRecord = input as unknown as Record<string, unknown>;
          const dedupArgs = documentArgsForDedup(ctx, inputRecord);
          const inFlightKey = generateDocumentInFlightKey(ctx, dedupArgs);

          if (!ctx.generateDocumentInFlight) {
            ctx.generateDocumentInFlight = new Map();
          }
          if (!ctx.generateDocumentDeferredByKey) {
            ctx.generateDocumentDeferredByKey = new Map();
          }

          // Reclamo SÍNCRONO del slot (sin await entre check y set): la primera
          // llamada equivalente del turno es la canónica; el resto son
          // seguidoras. Cubre tanto tool_calls paralelas del mismo mensaje como
          // re-llamadas en iteraciones posteriores (el Map vive todo el turno).
          const isFollower = ctx.generateDocumentInFlight.has(inFlightKey);
          if (isFollower) {
            const deferred = ctx.generateDocumentDeferredByKey.get(inFlightKey);
            try {
              const rendered = deferred
                ? await deferred.promise
                : { ok: true, status: "rendered" };
              const out =
                rendered.skipped_render === true
                  ? rendered
                  : buildGenerateDocumentDedupResult({
                      id: "same_turn_canonical",
                      result_json: rendered,
                    });
              // NO creamos fila de auditoría: el render duplicado del modelo no
              // debe ensuciar el historial; el modelo recibe el mismo borrador.
              return JSON.stringify(out);
            } catch (e) {
              return JSON.stringify({
                ok: false,
                status: "failed",
                error: e instanceof Error ? e.message : String(e),
              });
            }
          }

          const deferred = createGenerateDocumentDeferred();
          ctx.generateDocumentInFlight.set(inFlightKey, deferred.promise);
          ctx.generateDocumentDeferredByKey.set(inFlightKey, deferred);
          claimGenerateDocumentDedupSlot(ctx, dedupArgs);

          const record = await createTrackedToolCall(ctx, "generate_document_from_template",
            inputRecord,
            true);

          // Gate determinístico de titularidad (WS4): el contrato es la
          // transición donde la corroboración de identidad SÍ es precondición.
          // Fuente única de verdad (PATTERN_GATED_TRANSITION_WITH_OWNED_REMEDIATION).
          if (input.template_slug === "commission_contract") {
            const contractCaseId =
              typeof input.case_id === "string" && input.case_id.trim()
                ? input.case_id.trim()
                : typeof ctx.caseId === "string"
                  ? ctx.caseId.trim()
                  : "";
            if (contractCaseId) {
              const gateCase = await getOperationalCase(ctx.db, contractCaseId);
              if (gateCase && gateCase.case_type === "property_optioning") {
                const gateDocuments = await listOperationalCaseDocuments(ctx.db, {
                  caseId: gateCase.id,
                  statuses: ["received"],
                });
                const titularidadGate = evaluatePropertyAdvanceGate({
                  documents: gateDocuments,
                  context: gateCase.context_jsonb,
                  targetTransition: "contract_pending",
                });
                const titularidadBlock = titularidadGate.blocks.find(
                  (block) => block.reason === "titularidad_unverified"
                );
                const corroborationBlock = titularidadGate.blocks.find(
                  (block) => block.reason === "owner_corroboration_extraction_pending"
                );
                if (corroborationBlock) {
                  const out = {
                    ok: false,
                    status: "blocked",
                    error: "owner_corroboration_extraction_incomplete",
                    pending_owner_corroboration_document_ids:
                      corroborationBlock.remediation.document_ids ?? [],
                    hint:
                      "Antes de generar el contrato, termina la extracción de identificación/comprobante con operational_case_extract_document_fields (force=true) para los pending_owner_corroboration_document_ids y reintenta.",
                  };
                  await updateToolCallStatus(ctx.db, record.id, "failed", out);
                  return JSON.stringify(out);
                }
                if (titularidadBlock) {
                  const titularidadFields = documentExtractionMinimumsContext(gateDocuments);
                  const out = {
                    ok: false,
                    status: "blocked",
                    error: "titularidad_review_required",
                    titularidad_status:
                      titularidadBlock.remediation.titularidad_status ??
                      ownerConsistencyStatusFromFields(titularidadFields),
                    owner_consistency_note: titularidadFields.owner_consistency_note ?? null,
                    owner_consistency_warning:
                      titularidadFields.owner_consistency_warning ?? null,
                    hint:
                      "La titularidad no está verificada. Levanta notify_user(kind=\"titularidad_review\") describiendo el desajuste para que el asesor decida. Si el asesor aprueba avanzar, registra el override con operational_case_update_state (context.titularidad.override.approved=true) y reintenta. No generes el contrato hasta resolver esto.",
                  };
                  await updateToolCallStatus(ctx.db, record.id, "failed", out);
                  return JSON.stringify(out);
                }
              }
            }
          }

          try {
            const out = await renderDocumentFromTemplate(ctx, input);
            deferred.resolve(out);
            await updateToolCallStatus(
              ctx.db,
              record.id,
              out.ok === true ? "executed" : "failed",
              out
            );
            const caseIdForEvent =
              typeof input.case_id === "string" && input.case_id.trim()
                ? input.case_id.trim()
                : typeof ctx.caseId === "string"
                  ? ctx.caseId.trim()
                  : "";
            if (caseIdForEvent && out.ok && out.status === "rendered") {
              if (
                input.template_slug === "commission_contract" &&
                typeof out.output_path === "string" &&
                out.output_path.trim()
              ) {
                const opCase = await getOperationalCase(ctx.db, caseIdForEvent);
                if (opCase) {
                  const baseContext =
                    opCase.context_jsonb && typeof opCase.context_jsonb === "object"
                      ? (opCase.context_jsonb as Record<string, unknown>)
                      : {};
                  await updateOperationalCase(ctx.db, caseIdForEvent, opCase.version, {
                    context: {
                      ...baseContext,
                      contract_draft: {
                        ...(typeof baseContext.contract_draft === "object" &&
                        baseContext.contract_draft !== null &&
                        !Array.isArray(baseContext.contract_draft)
                          ? (baseContext.contract_draft as Record<string, unknown>)
                          : {}),
                        template_slug: out.template_slug,
                        output_bucket: out.output_bucket,
                        output_path: out.output_path,
                        generated_at: new Date().toISOString(),
                      },
                    },
                  });
                }
              }
              await insertOperationalCaseEvent(ctx.db, {
                caseId: caseIdForEvent,
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
            // Liberamos el slot para permitir un reintento real tras un fallo
            // (no queremos que un error deje "deduplicadas" las reintentos).
            ctx.generateDocumentInFlight.delete(inFlightKey);
            ctx.generateDocumentDeferredByKey.delete(inFlightKey);
            deferred.reject(e);
            await updateToolCallStatus(ctx.db, record.id, "failed", out);
            return JSON.stringify(out);
          }
        },
        {
          name: "generate_document_from_template",
          description:
            "Renders a DOCX document from a tenant-scoped template stored in account_assets. The placeholder values are derived automatically from the operational case (property_data, pricing_proposal, contact); `data` is optional and only needed to override or add fields.",
          schema: z.object({
            template_slug: z.string().min(1),
            asset_key: z.string().min(1).optional(),
            format: z.enum(["docx", "pdf"]),
            data: z.record(z.string(), z.any()).optional(),
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
          const record = await createTrackedToolCall(ctx, "image_watermark",
            input as unknown as Record<string, unknown>,
            false);
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
          const record = await createTrackedToolCall(ctx, "ungga_publish_listing",
            input,
            true);
          const caseId =
            typeof input.case_id === "string" && input.case_id.trim()
              ? input.case_id.trim()
              : ctx.caseId ?? null;
          let inputForExecution = { ...input };
          if (caseId) {
            const gate = await enforcePublishGateForCase({
              ctx,
              caseId,
              destination: "ungga",
            });
            if (!gate.ok) {
              await updateToolCallStatus(ctx.db, record.id, "failed", gate);
              return JSON.stringify(gate);
            }
            const approvedCopy = await approvedListingCopyFromCase(ctx, caseId);
            if (approvedCopy) {
              inputForExecution = {
                ...inputForExecution,
                title:
                  typeof inputForExecution.title === "string" &&
                  inputForExecution.title.trim().length > 0
                    ? inputForExecution.title
                    : approvedCopy.headline,
                description: approvedCopy.description,
              };
            }
          }
          const out = await executeUnggaPublishListing(ctx, inputForExecution, deps);
          await updateToolCallStatus(
            ctx.db,
            record.id,
            out.ok ? "executed" : "failed",
            out as unknown as Record<string, unknown>
          );
          if (caseId && out.ok) {
            if (out.action === "publish_draft") {
              await persistPublishedDestination(ctx, caseId, "ungga", {
                ungga_property_id:
                  typeof out.ungga_property_id === "string"
                    ? out.ungga_property_id
                    : null,
                published_url:
                  typeof out.published_url === "string" ? out.published_url : null,
                draft_url:
                  typeof out.draft_url === "string" ? out.draft_url : null,
                status: "published",
              });
            }
            const kind =
              out.action === "publish_draft" ? "ungga_published" : "ungga_draft_ready";
            await insertOperationalCaseEvent(ctx.db, {
              caseId,
              eventType: "step_completed",
              actor: "agent",
              stepKey: "package_ready",
              payload: {
                kind,
                destination: "ungga",
                ungga_property_id:
                  typeof out.ungga_property_id === "string"
                    ? out.ungga_property_id
                    : null,
                draft_url:
                  typeof out.draft_url === "string" ? out.draft_url : null,
                published_url:
                  typeof out.published_url === "string" ? out.published_url : null,
              },
            });
          }
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
  data?: Record<string, unknown>;
  case_id?: string;
};

const COMMISSION_CONTRACT_CRITICAL_FIELDS = [
  "owner_name",
  "owner_email",
  "property_address",
  "salida_price_formatted",
  "area_m2",
] as const;

function isMissingCriticalTemplateValue(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (typeof value === "number") return !Number.isFinite(value);
  return false;
}

export function missingRequiredCommissionContractFields(
  templateFields: string[],
  effectiveData: Record<string, unknown>
): string[] {
  const requiredFields = COMMISSION_CONTRACT_CRITICAL_FIELDS.filter((field) =>
    templateFields.includes(field)
  );
  return requiredFields.filter((field) =>
    isMissingCriticalTemplateValue(effectiveData[field])
  );
}

async function deriveTemplateDataFromCase(
  ctx: ToolContext,
  caseId: string | null | undefined
): Promise<Record<string, unknown>> {
  if (!caseId) return {};
  let oc;
  try {
    oc = await getOperationalCase(ctx.db, caseId);
  } catch {
    return {};
  }
  if (!oc) return {};

  const context = isRecord(oc.context_jsonb) ? oc.context_jsonb : {};
  return deriveCommissionContractTemplateData({
    case_context: context,
    property_data: isRecord(context.property_data) ? context.property_data : {},
    pricing_proposal: isRecord(context.pricing_proposal)
      ? context.pricing_proposal
      : {},
    commission_terms: isRecord(context.commission_terms)
      ? context.commission_terms
      : {},
    external_contact: isRecord(oc.external_contact_jsonb)
      ? (oc.external_contact_jsonb as Record<string, unknown>)
      : {},
  });
}

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
  const templateFields = extractDocxTemplateFields(zip);

  // Valores del modelo (si los dio) sobre los derivados del caso: los del
  // modelo ganan, pero el caso garantiza un relleno base aunque el modelo
  // omita `data` por completo (comportamiento común en gpt-4o-mini).
  const derivedData = await deriveTemplateDataFromCase(
    ctx,
    input.case_id ?? ctx.caseId
  );
  const modelData = isRecord(input.data) ? input.data : {};
  const effectiveData: Record<string, unknown> = { ...derivedData, ...modelData };

  const inputFields = Object.keys(effectiveData);
  if (
    input.template_slug === "commission_contract" &&
    templateFields.length > 0
  ) {
    const requiredFields = COMMISSION_CONTRACT_CRITICAL_FIELDS.filter((field) =>
      templateFields.includes(field)
    );
    const missingRequiredFields = missingRequiredCommissionContractFields(
      templateFields,
      effectiveData
    );
    if (missingRequiredFields.length > 0) {
      return {
        ok: false,
        status: "blocked",
        error: "commission_contract_missing_required_data",
        message:
          "Faltan datos contractuales obligatorios para generar el contrato.",
        missing_required_fields: missingRequiredFields,
        required_fields_checked: requiredFields,
        template_fields_detected: templateFields,
        received_fields: inputFields,
        hint:
          "Completa los campos faltantes en el caso (por ejemplo owner_email del comitente) y reintenta generate_document_from_template.",
      };
    }
  }
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    delimiters: { start: "{{", end: "}}" },
    // Cualquier placeholder sin valor se renderiza como cadena vacía en lugar
    // de lanzar un error de render que tumbaría toda la generación del DOCX.
    nullGetter: () => "",
  });
  doc.render(normalizeTemplateData(effectiveData));
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

  const signedUrlTtlSeconds = 7 * 24 * 60 * 60;
  const { data: signedUrlData } = await ctx.db.storage
    .from(templateAsset.storage_bucket)
    .createSignedUrl(outputPath, signedUrlTtlSeconds);

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
    signed_url: signedUrlData?.signedUrl ?? null,
    signed_url_expires_in_seconds: signedUrlTtlSeconds,
    received_fields: inputFields,
    template_fields_detected: templateFields,
    unmatched_input_fields:
      templateFields.length > 0
        ? inputFields.filter((field) => !templateFields.includes(field))
        : inputFields,
    warning:
      templateFields.length === 0
        ? "No detecté placeholders con formato {{campo}} en la plantilla DOCX; el documento puede generarse sin reemplazos."
        : undefined,
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
  const isDocxTemplate = (asset: { content_type?: string | null }) =>
    asset.content_type === DOCX_MIME;

  const directMatches = await listAccountAssets(ctx.db, {
    userId: ctx.userId,
    assetKeys: candidateKeys,
  });
  for (const key of candidateKeys) {
    const match = directMatches.find(
      (asset) => asset.asset_key === key && isDocxTemplate(asset)
    );
    if (match) return match;
  }

  const accountAssets = await listAccountAssets(ctx.db, { userId: ctx.userId });
  return (
    accountAssets.find(
      (asset) =>
        asset.source_tool_id === "generate_document_from_template" &&
        isDocxTemplate(asset)
    ) ??
    accountAssets.find(
      (asset) =>
        asset.asset_key.includes("template") && isDocxTemplate(asset)
    ) ??
    null
  );
}

type AnalyzePropertyImagesInput = {
  image_paths: string[];
  purpose?: string;
  case_id?: string;
};

const PHOTO_COVERAGE_KEYS = [
  "facade",
  "kitchen",
  "dining_room",
  "living_room",
  "primary_bedroom",
  "bathroom",
  "outdoor",
  "parking",
] as const;

const ANALYZE_PROPERTY_IMAGES_JSON_SCHEMA = {
  visible_spaces: "string[]",
  features_by_space:
    'Record<string, string[]> — claves en español (ej. fachada, cocina, sala, comedor, recámara principal, baño, exterior, estacionamiento). Cada feature SOLO en el espacio donde se ve claramente.',
  photo_coverage: {
    facade: "visible|unclear|not_visible",
    kitchen: "visible|unclear|not_visible",
    dining_room: "visible|unclear|not_visible",
    living_room: "visible|unclear|not_visible",
    primary_bedroom: "visible|unclear|not_visible",
    bathroom: "visible|unclear|not_visible",
    outdoor: "visible|unclear|not_visible",
    parking: "visible|unclear|not_visible",
  },
  style_tags: "string[] — solo si el estilo arquitectónico/decorativo es claramente visible",
  materials_visible: "string[] — materiales y acabados identificables",
  lighting_notes: "string[] — iluminación natural/artificial observable",
  outdoor_spaces: "string[] — patios, jardines, terrazas, balcones visibles",
  copy_safe_phrases:
    "string[] — frases cortas (máx 12 palabras) derivadas solo de evidencia visible",
  quality_notes: "string[]",
  uncertain_observations: "string[]",
  do_not_claim: "string[]",
  recommended_missing_photos: "string[]",
};

function parsePhotoCoverageRecord(value: unknown) {
  const raw = asRecord(value) ?? {};
  const out: Record<string, "visible" | "unclear" | "not_visible"> = {};
  for (const key of PHOTO_COVERAGE_KEYS) {
    out[key] = normalizeCoverageValue(raw[key]);
  }
  return out;
}

function parseFeaturesBySpace(value: unknown): Record<string, string[]> {
  const raw = asRecord(value) ?? {};
  const out: Record<string, string[]> = {};
  for (const [key, features] of Object.entries(raw)) {
    const space = key.trim();
    if (!space) continue;
    const list = ensureStringArray(features, 12);
    if (list.length > 0) out[space] = list;
  }
  return out;
}

function flattenFeaturesBySpace(featuresBySpace: Record<string, string[]>): string[] {
  const seen = new Set<string>();
  const flat: string[] = [];
  for (const features of Object.values(featuresBySpace)) {
    for (const feature of features) {
      const dedupeKey = feature.toLowerCase();
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      flat.push(feature);
    }
  }
  return flat.slice(0, 24);
}

function isEditorialInstructionText(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  return /\b(menciona(?:r)?|agrega(?:r)?|incluye(?:r)?|resalta(?:r)?|destaca(?:r)?|enfatiza(?:r)?|usa(?:r)?|evita(?:r)?|haz(?:lo)?|mejora(?:r)?|ajusta(?:r)?|cambia(?:r)?|corrige(?:r)?)\b/.test(
    normalized
  );
}

function splitHighlightAndInstructions(values: string[]) {
  const highlights: string[] = [];
  const editorialInstructions: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (isEditorialInstructionText(trimmed)) {
      editorialInstructions.push(trimmed);
    } else {
      highlights.push(trimmed);
    }
  }
  return { highlights, editorialInstructions };
}

function buildPhotoAnalysisIngredients(
  photoAnalysis: Record<string, unknown>
): Record<string, unknown> {
  const featuresBySpace = parseFeaturesBySpace(photoAnalysis.features_by_space);
  const visibleFeatures = ensureStringArray(photoAnalysis.visible_features, 24);
  return {
    visible_spaces: ensureStringArray(photoAnalysis.visible_spaces, 12),
    features_by_space:
      Object.keys(featuresBySpace).length > 0
        ? featuresBySpace
        : visibleFeatures.length > 0
          ? { general: visibleFeatures }
          : {},
    visible_features:
      Object.keys(featuresBySpace).length > 0
        ? flattenFeaturesBySpace(featuresBySpace)
        : visibleFeatures,
    photo_coverage: parsePhotoCoverageRecord(photoAnalysis.photo_coverage),
    style_tags: ensureStringArray(photoAnalysis.style_tags, 8),
    materials_visible: ensureStringArray(photoAnalysis.materials_visible, 12),
    lighting_notes: ensureStringArray(photoAnalysis.lighting_notes, 8),
    outdoor_spaces: ensureStringArray(photoAnalysis.outdoor_spaces, 8),
    copy_safe_phrases: ensureStringArray(photoAnalysis.copy_safe_phrases, 10),
    quality_notes: ensureStringArray(photoAnalysis.quality_notes, 12),
    uncertain_observations: ensureStringArray(photoAnalysis.uncertain_observations, 12),
    do_not_claim: ensureStringArray(photoAnalysis.do_not_claim, 16),
    recommended_missing_photos: ensureStringArray(
      photoAnalysis.recommended_missing_photos,
      12
    ),
  };
}

type ListingPriceResolution = {
  listing_price: number | null;
  pricing_ideal: number | null;
  pricing_minimum: number | null;
  pricing_source: "pricing_proposal.salida" | null;
  pricing_approval_status: string;
};

function resolveListingPriceForDraft(
  pricingProposal: Record<string, unknown>
): ListingPriceResolution {
  const approvalStatusRaw =
    typeof pricingProposal.approval_status === "string"
      ? pricingProposal.approval_status
      : "";
  const pricingApprovalStatus = approvalStatusRaw.trim().toLowerCase();
  const listingPrice = safeNumber(pricingProposal.salida);
  const pricingIdeal = safeNumber(pricingProposal.ideal);
  const pricingMinimum = safeNumber(pricingProposal.minimo);
  return {
    listing_price: listingPrice,
    pricing_ideal: pricingIdeal,
    pricing_minimum: pricingMinimum,
    pricing_source: listingPrice != null ? "pricing_proposal.salida" : null,
    pricing_approval_status: pricingApprovalStatus,
  };
}

function buildPhotoAnalysisOutput(
  parsed: Record<string, unknown>,
  selectedPaths: string[],
  imageCount: number
) {
  const featuresBySpace = parseFeaturesBySpace(parsed.features_by_space);
  const legacyFlat = ensureStringArray(parsed.visible_features, 24);
  const visibleFeatures =
    Object.keys(featuresBySpace).length > 0
      ? flattenFeaturesBySpace(featuresBySpace)
      : legacyFlat;

  return {
    ok: true,
    status: "analyzed",
    model: IMAGE_VISION_MODEL_ID,
    image_count: imageCount,
    visible_spaces: ensureStringArray(parsed.visible_spaces, 12),
    features_by_space: featuresBySpace,
    visible_features: visibleFeatures,
    photo_coverage: parsePhotoCoverageRecord(parsed.photo_coverage),
    style_tags: ensureStringArray(parsed.style_tags, 8),
    materials_visible: ensureStringArray(parsed.materials_visible, 12),
    lighting_notes: ensureStringArray(parsed.lighting_notes, 8),
    outdoor_spaces: ensureStringArray(parsed.outdoor_spaces, 8),
    copy_safe_phrases: ensureStringArray(parsed.copy_safe_phrases, 10),
    quality_notes: ensureStringArray(parsed.quality_notes, 12),
    uncertain_observations: ensureStringArray(parsed.uncertain_observations, 12),
    do_not_claim: ensureStringArray(parsed.do_not_claim, 16),
    recommended_missing_photos: ensureStringArray(parsed.recommended_missing_photos, 12),
    source_paths: selectedPaths,
  };
}

function analyzePropertyImagesSystemPrompt() {
  return (
    "Eres analista visual de inmobiliaria en México/LATAM. Devuelve JSON válido sin markdown. " +
    "Reglas estrictas: (1) ausencia visual NO implica ausencia real; " +
    "(2) nunca afirmes que la propiedad no tiene algo solo porque no se ve en fotos; " +
    "(3) cada característica va en features_by_space SOLO bajo el espacio donde se observa con claridad — " +
    "no mezcles detalles de fachada/exterior bajo espacios interiores ni viceversa; " +
    "(4) copy_safe_phrases y style_tags deben ser conservadores y basados solo en evidencia visible."
  );
}

function analyzePropertyImagesUserPrompt(purpose: string) {
  return (
    `Analiza estas imágenes para ${purpose}. ` +
    "Devuelve este shape JSON exacto (sin campos extra): " +
    `${JSON.stringify(ANALYZE_PROPERTY_IMAGES_JSON_SCHEMA)}. ` +
    "Usa claves de espacio en español en features_by_space, alineadas con visible_spaces. " +
    "Responde solo con JSON."
  );
}

function makeAnalyzePropertyImagesTool(ctx: ToolContext) {
  return tool(
    async (input: AnalyzePropertyImagesInput) => {
      const record = await createTrackedToolCall(
        ctx,
        "analyze_property_images",
        input as unknown as Record<string, unknown>,
        false
      );
      const maxImages = Math.min(input.image_paths.length, 8);
      const selectedPaths = input.image_paths.slice(0, maxImages);
      const imageMessages: Array<Record<string, unknown>> = [];
      for (const imagePath of selectedPaths) {
        try {
          const loaded = await loadImageInput(ctx, imagePath);
          const normalized = await sharp(loaded.buffer, { failOn: "none" })
            .rotate()
            .resize({ width: 1400, withoutEnlargement: true })
            .jpeg({ quality: 80 })
            .toBuffer();
          const dataUrl = `data:image/jpeg;base64,${normalized.toString("base64")}`;
          imageMessages.push({ type: "image_url", image_url: { url: dataUrl } });
        } catch {
          // Si una imagen falla seguimos con el resto; el modelo recibirá menos entradas.
        }
      }
      if (imageMessages.length === 0) {
        const out = {
          ok: false,
          status: "no_images_loaded",
          hint: "No se pudieron cargar imágenes válidas para análisis.",
        };
        await updateToolCallStatus(ctx.db, record.id, "failed", out);
        return JSON.stringify(out);
      }
      try {
        const parsed = await callOpenRouterJsonTool({
          model: IMAGE_VISION_MODEL_ID,
          maxTokens: IMAGE_VISION_MAX_TOKENS,
          temperature: IMAGE_VISION_TEMPERATURE,
          messages: [
            {
              role: "system",
              content: analyzePropertyImagesSystemPrompt(),
            },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: analyzePropertyImagesUserPrompt(
                    input.purpose ?? "listing_description"
                  ),
                },
                ...imageMessages,
              ],
            },
          ],
        });
        const out = buildPhotoAnalysisOutput(
          asRecord(parsed) ?? {},
          selectedPaths,
          imageMessages.length
        );
        const caseId = input.case_id ?? ctx.caseId ?? null;
        if (caseId) {
          await persistCaseContextPatch(
            ctx,
            caseId,
            { photo_analysis: out },
            {
              kind: "property_images_analyzed",
              tool: "analyze_property_images",
              image_count: out.image_count,
            }
          );
        }
        await updateToolCallStatus(
          ctx.db,
          record.id,
          "executed",
          out as unknown as Record<string, unknown>
        );
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
      name: "analyze_property_images",
      description:
        "Analyzes property images and returns structured visual evidence for listing copy (never infers absent features from missing photos).",
      schema: z.object({
        image_paths: z.array(z.string().min(1)).min(1).max(30),
        purpose: z.string().min(1).optional(),
        case_id: z.string().min(1).optional(),
      }),
    }
  );
}

type LookupPropertySurroundingsInput = {
  address?: string;
  neighborhood?: string;
  municipality?: string;
  state?: string;
  country?: string;
  latitude?: number;
  longitude?: number;
  radius_meters?: number;
  max_results_per_category?: number;
  case_id?: string;
};

type LookupCoordinatesResolution = {
  coordinates: {
    latitude: number;
    longitude: number;
    source: "input" | "case_context" | "geocode_property_address";
    formatted_address?: string;
  } | null;
  geocode_failure?: {
    status: string;
    message: string;
    retryable: boolean;
  };
};

function geocodeAttemptSummary(
  result: Awaited<ReturnType<typeof geocodePropertyAddress>>
) {
  if (result.ok) return null;
  return {
    status: result.status,
    message: result.message,
    retryable: result.retryable,
  };
}

function hasExplicitAddressInput(input: LookupPropertySurroundingsInput) {
  const values = [input.address, input.neighborhood, input.municipality, input.state];
  return values.some((value) => typeof value === "string" && value.trim().length > 0);
}

async function resolveSurroundingsCoordinates(
  ctx: ToolContext,
  input: LookupPropertySurroundingsInput
): Promise<LookupCoordinatesResolution> {
  const lat = safeNumber(input.latitude);
  const lon = safeNumber(input.longitude);
  if (lat != null && lon != null) {
    return {
      coordinates: { latitude: lat, longitude: lon, source: "input" as const },
    };
  }
  let geocodeFailure: LookupCoordinatesResolution["geocode_failure"];
  const caseId = input.case_id ?? ctx.caseId ?? "";
  const opCase =
    typeof caseId === "string" && caseId.trim()
      ? await getOperationalCase(ctx.db, caseId).catch(() => null)
      : null;
  const caseContext = asRecord(opCase?.context_jsonb) ?? {};
  const propertyData = asRecord(caseContext.property_data) ?? {};
  const caseAddress = asRecord(propertyData.address) ?? {};

  const caseLat = safeNumber(caseAddress.latitude ?? propertyData.latitude);
  const caseLon = safeNumber(caseAddress.longitude ?? propertyData.longitude);
  if (caseLat != null && caseLon != null) {
    return {
      coordinates: {
        latitude: caseLat,
        longitude: caseLon,
        source: "case_context" as const,
      },
    };
  }

  if (hasExplicitAddressInput(input)) {
    const geocodedFromInput = await geocodePropertyAddress({
      street: typeof input.address === "string" ? input.address.trim() : undefined,
      neighborhood:
        typeof input.neighborhood === "string" ? input.neighborhood.trim() : undefined,
      municipality:
        typeof input.municipality === "string" ? input.municipality.trim() : undefined,
      state: typeof input.state === "string" ? input.state.trim() : undefined,
      country: (typeof input.country === "string" && input.country.trim()) || "MX",
    });
    if (
      geocodedFromInput.ok &&
      geocodedFromInput.status === "ok" &&
      typeof geocodedFromInput.latitude === "number" &&
      typeof geocodedFromInput.longitude === "number"
    ) {
      return {
        coordinates: {
          latitude: geocodedFromInput.latitude,
          longitude: geocodedFromInput.longitude,
          source: "geocode_property_address" as const,
          formatted_address: geocodedFromInput.formatted_address,
        },
      };
    }
    geocodeFailure = geocodeAttemptSummary(geocodedFromInput) ?? geocodeFailure;
  }

  if (opCase) {
    const geocodedFromCase = await geocodePropertyAddress({
      street:
        (typeof caseAddress.street === "string" && caseAddress.street.trim()) || undefined,
      exterior_number:
        (typeof caseAddress.exterior_number === "string" &&
          caseAddress.exterior_number.trim()) ||
        undefined,
      neighborhood:
        (typeof caseAddress.neighborhood === "string" &&
          caseAddress.neighborhood.trim()) ||
        undefined,
      municipality:
        (typeof caseAddress.municipality === "string" &&
          caseAddress.municipality.trim()) ||
        (typeof propertyData.municipality === "string" &&
          propertyData.municipality.trim()) ||
        (typeof propertyData.city === "string" && propertyData.city.trim()) ||
        undefined,
      state:
        (typeof caseAddress.state === "string" && caseAddress.state.trim()) ||
        (typeof propertyData.state === "string" && propertyData.state.trim()) ||
        undefined,
      postal_code:
        (typeof caseAddress.postal_code === "string" &&
          caseAddress.postal_code.trim()) ||
        undefined,
      country:
        (typeof caseAddress.country === "string" && caseAddress.country.trim()) ||
        (typeof input.country === "string" && input.country.trim()) ||
        "MX",
    });
    if (
      geocodedFromCase.ok &&
      geocodedFromCase.status === "ok" &&
      typeof geocodedFromCase.latitude === "number" &&
      typeof geocodedFromCase.longitude === "number"
    ) {
      return {
        coordinates: {
          latitude: geocodedFromCase.latitude,
          longitude: geocodedFromCase.longitude,
          source: "geocode_property_address" as const,
          formatted_address: geocodedFromCase.formatted_address,
        },
      };
    }
    geocodeFailure = geocodeAttemptSummary(geocodedFromCase) ?? geocodeFailure;
  }

  return { coordinates: null, geocode_failure: geocodeFailure };
}

function normalizeCoverageValue(value: unknown): "visible" | "unclear" | "not_visible" {
  const normalized =
    typeof value === "string" ? value.trim().toLowerCase().replace(/\s+/g, "_") : "";
  if (normalized === "visible") return "visible";
  if (normalized === "not_visible" || normalized === "missing") return "not_visible";
  return "unclear";
}

function makeLookupPropertySurroundingsTool(ctx: ToolContext) {
  return tool(
    async (input: LookupPropertySurroundingsInput) => {
      const record = await createTrackedToolCall(
        ctx,
        "lookup_property_surroundings",
        input as unknown as Record<string, unknown>,
        false
      );
      const apiKey = process.env.GOOGLE_MAPS_API_KEY?.trim();
      if (!apiKey) {
        const out = {
          ok: false,
          status: "not_configured",
          hint: "Falta GOOGLE_MAPS_API_KEY para lookup de entorno.",
        };
        await updateToolCallStatus(ctx.db, record.id, "failed", out);
        return JSON.stringify(out);
      }
      const resolution = await resolveSurroundingsCoordinates(ctx, input);
      if (!resolution.coordinates) {
        const out = {
          ok: false,
          status: "missing_coordinates",
          hint:
            "No pude resolver coordenadas para consultar entorno. Proporciona lat/lng o dirección suficiente.",
          geocode_status: resolution.geocode_failure?.status ?? null,
          geocode_message: resolution.geocode_failure?.message ?? null,
          geocode_retryable: resolution.geocode_failure?.retryable ?? null,
        };
        await updateToolCallStatus(ctx.db, record.id, "failed", out);
        return JSON.stringify(out);
      }
      const coordinates = resolution.coordinates;
      const radius = Math.max(300, Math.min(3000, Math.round(safeNumber(input.radius_meters) ?? 1500)));
      const perCategory = Math.max(
        1,
        Math.min(8, Math.round(safeNumber(input.max_results_per_category) ?? 4))
      );
      const categories = [
        { key: "park", label: "Parques" },
        { key: "school", label: "Escuelas" },
        { key: "hospital", label: "Hospitales" },
        { key: "shopping_mall", label: "Centros comerciales" },
        { key: "transit_station", label: "Transporte" },
      ];
      const points: Array<Record<string, unknown>> = [];
      const warnings: string[] = [];
      for (const category of categories) {
        const url =
          "https://maps.googleapis.com/maps/api/place/nearbysearch/json" +
          `?location=${coordinates.latitude},${coordinates.longitude}` +
          `&radius=${radius}&type=${encodeURIComponent(category.key)}` +
          `&language=es&key=${encodeURIComponent(apiKey)}`;
        try {
          const res = await fetch(url);
          const body = (await res.json().catch(() => ({}))) as {
            results?: Array<Record<string, unknown>>;
            status?: string;
            error_message?: string;
          };
          if (!res.ok || (body.status && body.status !== "OK" && body.status !== "ZERO_RESULTS")) {
            warnings.push(
              `${category.label}: ${body.error_message || body.status || `HTTP_${res.status}`}`
            );
            continue;
          }
          for (const poi of (body.results ?? []).slice(0, perCategory)) {
            const geometry = asRecord(poi.geometry) ?? {};
            const location = asRecord(geometry.location) ?? {};
            const poiLat = safeNumber(location.lat);
            const poiLon = safeNumber(location.lng);
            const distanceMeters =
              poiLat != null && poiLon != null
                ? haversineMeters(coordinates.latitude, coordinates.longitude, poiLat, poiLon)
                : null;
            points.push({
              category: category.key,
              category_label: category.label,
              name: typeof poi.name === "string" ? poi.name.trim() : "POI",
              vicinity:
                typeof poi.vicinity === "string"
                  ? poi.vicinity.trim()
                  : typeof poi.formatted_address === "string"
                    ? poi.formatted_address.trim()
                    : "",
              distance_meters: distanceMeters,
              rating: safeNumber(poi.rating),
            });
          }
        } catch (err) {
          warnings.push(
            `${category.label}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
      points.sort((a, b) => {
        const aDistance = safeNumber(a.distance_meters) ?? Number.MAX_SAFE_INTEGER;
        const bDistance = safeNumber(b.distance_meters) ?? Number.MAX_SAFE_INTEGER;
        return aDistance - bDistance;
      });
      const pointsOfInterest = points
        .slice(0, 20)
        .map((poi) => {
          const name = typeof poi.name === "string" ? poi.name : "POI";
          const label =
            typeof poi.category_label === "string" ? poi.category_label : "POI";
          const distance = safeNumber(poi.distance_meters);
          return distance != null ? `${name} (${label}, ~${distance} m)` : `${name} (${label})`;
        });
      const out = {
        ok: true,
        status: "ok",
        source: "google_places_nearby",
        latitude: coordinates.latitude,
        longitude: coordinates.longitude,
        coordinate_source: coordinates.source,
        radius_meters: radius,
        points,
        points_of_interest: pointsOfInterest,
        mobility: points
          .filter((poi) => poi.category === "transit_station")
          .slice(0, 5)
          .map((poi) => poi.name),
        area_summary:
          pointsOfInterest.length > 0
            ? `Entorno con ${pointsOfInterest.length} puntos de interés verificados en radio de ${radius} m.`
            : "No se encontraron puntos de interés verificados en el radio consultado.",
        warnings,
      };
      const caseId = input.case_id ?? ctx.caseId ?? null;
      if (caseId) {
        await persistCaseContextPatch(
          ctx,
          caseId,
          { zone_context: out, zone_points_of_interest: pointsOfInterest },
          {
            kind: "property_surroundings_enriched",
            tool: "lookup_property_surroundings",
            points_count: pointsOfInterest.length,
          }
        );
      }
      await updateToolCallStatus(
        ctx.db,
        record.id,
        "executed",
        out as unknown as Record<string, unknown>
      );
      return JSON.stringify(out);
    },
    {
      name: "lookup_property_surroundings",
      description:
        "Builds surroundings context (POIs + area summary) around a property using coordinates/address.",
      schema: z.object({
        address: z.string().optional(),
        neighborhood: z.string().optional(),
        municipality: z.string().optional(),
        state: z.string().optional(),
        country: z.string().optional(),
        latitude: z.number().optional(),
        longitude: z.number().optional(),
        radius_meters: z.number().optional(),
        max_results_per_category: z.number().optional(),
        case_id: z.string().optional(),
      }),
    }
  );
}

function makePrepareListingDescriptionDraftTool(ctx: ToolContext) {
  return tool(
    async (input: { case_id: string; purpose?: string }) => {
      const record = await createTrackedToolCall(
        ctx,
        "prepare_listing_description_draft",
        input as unknown as Record<string, unknown>,
        false
      );
      const opCase = await getOperationalCase(ctx.db, input.case_id);
      if (!opCase || opCase.user_id !== ctx.userId) {
        const out = { ok: false, status: "case_not_found" };
        await updateToolCallStatus(ctx.db, record.id, "failed", out);
        return JSON.stringify(out);
      }
      const context = asRecord(opCase.context_jsonb) ?? {};
      const propertyData = asRecord(context.property_data) ?? {};
      const pricingProposal = asRecord(context.pricing_proposal) ?? {};
      const photoAnalysis = asRecord(context.photo_analysis) ?? {};
      const zoneContext = asRecord(context.zone_context) ?? {};
      const highlights = ensureStringArray(context.listing_highlights).slice(0, 12);
      const copyInstructionsFromContext = ensureStringArray(
        context.listing_copy_instructions
      ).slice(0, 8);
      const listingDescriptionReview = asRecord(context.listing_description_review) ?? {};
      const reviewClassification = asRecord(
        listingDescriptionReview.change_classification
      ) ?? {};
      const reviewHighlightsRaw = ensureStringArray(
        reviewClassification.new_facts_or_highlights
      ).slice(0, 12);
      const editorialInstructionsRaw = ensureStringArray(
        reviewClassification.editorial_instructions
      ).slice(0, 8);
      const highlightSplit = splitHighlightAndInstructions([
        ...highlights,
        ...reviewHighlightsRaw,
      ]);
      const reviewInstructionSplit = splitHighlightAndInstructions(editorialInstructionsRaw);
      const replacementCandidate = asRecord(
        context.listing_description_replacement_candidate
      );
      const replacementText =
        typeof replacementCandidate?.text === "string" &&
        replacementCandidate.text.trim()
          ? replacementCandidate.text.trim()
          : typeof reviewClassification.replacement_text === "string" &&
              reviewClassification.replacement_text.trim()
            ? reviewClassification.replacement_text.trim()
            : "";
      const mergedAdvisorHighlights = Array.from(new Set(highlightSplit.highlights)).slice(
        0,
        12
      );
      const mergedEditorialInstructions = Array.from(
        new Set([
          ...copyInstructionsFromContext,
          ...reviewInstructionSplit.editorialInstructions,
          ...highlightSplit.editorialInstructions,
        ])
      ).slice(0, 12);
      const missingIngredients: string[] = [];
      const listingPrice = resolveListingPriceForDraft(pricingProposal);
      if (listingPrice.pricing_approval_status !== "approved") {
        missingIngredients.push("pricing_proposal.approval_status=approved");
      }
      if (!listingPrice.listing_price || listingPrice.listing_price <= 0) {
        missingIngredients.push("pricing_proposal.salida");
      }
      if (!propertyData.property_type && !context.property_type) {
        missingIngredients.push("property_type");
      }
      if (!propertyData.operation && !context.operation_type) {
        missingIngredients.push("operation_type");
      }
      const rawPhotosCount = Array.isArray(context.raw_photos) ? context.raw_photos.length : 0;
      if (rawPhotosCount < 5) missingIngredients.push("raw_photos>=5");
      if (Object.keys(photoAnalysis).length === 0) missingIngredients.push("photo_analysis");
      if (Object.keys(zoneContext).length === 0) missingIngredients.push("zone_context");
      if (missingIngredients.length > 0) {
        const out = {
          ok: false,
          status: "missing_required_ingredients",
          missing_ingredients: missingIngredients,
        };
        await updateToolCallStatus(ctx.db, record.id, "failed", out);
        return JSON.stringify(out);
      }
      const propertyAddress = asRecord(propertyData.address) ?? {};
      const municipality = firstNonEmptyString(
        propertyData.municipality,
        propertyData.city,
        propertyAddress.municipality,
        propertyAddress.municipio,
        propertyAddress.city
      );
      const state = firstNonEmptyString(
        propertyData.state,
        propertyAddress.state,
        propertyAddress.estado
      );
      const neighborhood = firstNonEmptyString(
        propertyData.neighborhood,
        propertyData.fraccionamiento,
        propertyAddress.neighborhood,
        propertyAddress.colonia
      );
      const legalAddress = firstNonEmptyString(
        propertyData.legal_address,
        propertyAddress.formatted_address,
        propertyData.formatted_address,
        composeAddressFromRecord(propertyAddress)
      );
      const ingredientPayload = {
        property_type: propertyData.property_type ?? context.property_type ?? "propiedad",
        operation_type: propertyData.operation ?? context.operation_type ?? "N/D",
        legal_address: legalAddress ?? "N/D",
        municipality: municipality ?? "N/D",
        state: state ?? "N/D",
        neighborhood: neighborhood ?? "N/D",
        listing_price: listingPrice.listing_price,
        pricing_ideal: listingPrice.pricing_ideal,
        pricing_minimum: listingPrice.pricing_minimum,
        pricing_source: listingPrice.pricing_source,
        // Compatibilidad temporal para consumidores legacy de listing_copy_ingredients.
        target_price: listingPrice.listing_price,
        currency:
          pricingProposal.currency ?? propertyData.currency ?? context.currency ?? "MXN",
        bedrooms: propertyData.bedrooms ?? null,
        bathrooms: propertyData.bathrooms ?? null,
        parking_spots: propertyData.parking_spots ?? null,
        area_total_m2: propertyData.area_total_m2 ?? null,
        area_built_m2: propertyData.area_built_m2 ?? null,
        raw_photos_count: rawPhotosCount,
        photo_analysis: buildPhotoAnalysisIngredients(photoAnalysis),
        zone_context: {
          points_of_interest: ensureStringArray(zoneContext.points_of_interest),
          mobility: ensureStringArray(zoneContext.mobility),
          area_summary:
            typeof zoneContext.area_summary === "string"
              ? zoneContext.area_summary
              : "",
        },
        advisor_highlights: mergedAdvisorHighlights,
        editorial_instructions: mergedEditorialInstructions,
        revision_feedback: {
          change_type:
            typeof reviewClassification.change_type === "string"
              ? reviewClassification.change_type
              : null,
          editorial_instructions: mergedEditorialInstructions,
          replacement_text: replacementText,
        },
      };
      try {
        const parsed = await callOpenRouterJsonTool({
          model: LISTING_COPY_MODEL_ID,
          maxTokens: LISTING_COPY_MAX_TOKENS,
          temperature: LISTING_COPY_TEMPERATURE,
          messages: [
            {
              role: "system",
              content:
                "Eres copywriter inmobiliario LATAM. Devuelve JSON válido sin markdown. " +
                "No inventes amenidades ni cercanías; usa solo ingredientes provistos. " +
                "Prioriza features_by_space para describir cada área con sus detalles visibles; " +
                "no mezcles características de espacios distintos. " +
                "Usa copy_safe_phrases cuando encajen. Respeta do_not_claim y photo_coverage. " +
                "Menciona escuelas, transporte, hospitales o parques por nombre solo si aparecen en zone_context.points_of_interest. " +
                "Si revision_feedback trae replacement_text, úsalo como base y luego ajusta solo para mantener factualidad y claridad.",
            },
            {
              role: "user",
              content:
                "Con estos ingredientes genera un borrador comercial con este shape exacto: " +
                '{ "headline": string, "short_description": string, "description": string, "ingredients_used": string[], "excluded_claims": string[], "missing_ingredients": string[] }. ' +
                "El cuerpo description debe tener entre 120 y 220 palabras y tono sobrio. " +
                "Integra advisor_highlights y editorial_instructions cuando existan. " +
                "missing_ingredients debe contener etiquetas en español natural para el asesor, nunca slugs técnicos ni nombres de campos." +
                `\n\nIngredientes:\n${JSON.stringify(ingredientPayload)}`,
            },
          ],
        });
        const draft = {
          headline:
            typeof parsed.headline === "string" && parsed.headline.trim()
              ? parsed.headline.trim().slice(0, 140)
              : "Borrador de publicación",
          short_description:
            typeof parsed.short_description === "string" && parsed.short_description.trim()
              ? parsed.short_description.trim().slice(0, 220)
              : "",
          description:
            typeof parsed.description === "string" && parsed.description.trim()
              ? parsed.description.trim()
              : "",
          ingredients_used: ensureStringArray(parsed.ingredients_used),
          excluded_claims: ensureStringArray(parsed.excluded_claims),
          missing_ingredients: normalizeMissingIngredientsForDisplay({
            missingIngredients: ensureStringArray(parsed.missing_ingredients),
            ingredientPayload,
          }),
          model: LISTING_COPY_MODEL_ID,
          generated_at: new Date().toISOString(),
          purpose: input.purpose ?? "listing_description",
        };
        if (!draft.description) {
          const out = {
            ok: false,
            status: "empty_description",
            hint: "El modelo no devolvió descripción utilizable.",
          };
          await updateToolCallStatus(ctx.db, record.id, "failed", out);
          return JSON.stringify(out);
        }
        const patch = {
          listing_copy_ingredients: ingredientPayload,
          listing_description_draft: draft,
          listing_description_md: draft.description,
        };
        await persistCaseContextPatch(ctx, opCase.id, patch, {
          kind: "listing_description_drafted",
          tool: "prepare_listing_description_draft",
        });
        const out = {
          ok: true,
          status: "drafted",
          ...draft,
        };
        await updateToolCallStatus(
          ctx.db,
          record.id,
          "executed",
          out as unknown as Record<string, unknown>
        );
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
      name: "prepare_listing_description_draft",
      description:
        "Prepares a structured listing description draft from verified ingredients in the operational case.",
      schema: z.object({
        case_id: z.string().min(1),
        purpose: z.string().min(1).optional(),
      }),
    }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function extractDocxTemplateFields(zip: PizZip): string[] {
  const fields = new Set<string>();
  const files = Object.keys(zip.files).filter(
    (name) =>
      name.startsWith("word/") &&
      name.endsWith(".xml") &&
      (name.includes("document") ||
        name.includes("header") ||
        name.includes("footer"))
  );
  for (const fileName of files) {
    const file = zip.file(fileName);
    const xml = file?.asText();
    if (!xml) continue;
    const compact = xml.replace(/<[^>]+>/g, "");
    for (const match of compact.matchAll(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g)) {
      if (match[1]) fields.add(match[1]);
    }
  }
  return [...fields].sort();
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

  // EasyBroker MLS depende de una sesión web persistida (storage-state.json).
  // Cuando expira, el CLI intenta re-loguearse con email/password y, si pasa
  // el anti-bot, persiste una sesión fresca que el siguiente intento reutiliza
  // por la vía rápida. Como pasar el anti-bot es probabilístico, reintentamos
  // de forma acotada ante fallos de sesión/login: es el mismo efecto que
  // lograba el usuario al correr "Probar conexión" y volver a ejecutar la tool.
  const maxAttempts = easyBrokerMlsMaxAttempts();
  let lastResponse: Record<string, unknown> = {
    ok: false,
    status: "failed",
    source: "easybroker_mls",
    mode: "web_mls",
    tool: toolId,
    error: "EasyBroker MLS no devolvió respuesta.",
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    lastResponse = await executeEasyBrokerMlsCliOnce(
      pocDir,
      input,
      toolId,
      creds,
      attempt
    );
    if (lastResponse.ok !== false) return lastResponse;
    const recoverable = lastResponse.status === "needs_manual_login";
    if (!recoverable || attempt >= maxAttempts) {
      if (recoverable && attempt >= maxAttempts) {
        const assisted = await maybeRunEasyBrokerAssistedLogin(pocDir, creds);
        if (assisted.attempted) {
          if (!assisted.ok) {
            return {
              ...lastResponse,
              recovery_attempts: attempt,
              assisted_login: assisted,
            };
          }
          const assistedRetryAttempt = attempt + 1;
          const assistedRetry = await executeEasyBrokerMlsCliOnce(
            pocDir,
            input,
            toolId,
            creds,
            assistedRetryAttempt
          );
          return {
            ...assistedRetry,
            recovery_attempts: assistedRetryAttempt,
            assisted_login: assisted,
          };
        }
        return {
          ...lastResponse,
          recovery_attempts: attempt,
          assisted_login: assisted,
        };
      }
      return { ...lastResponse, recovery_attempts: attempt };
    }
  }

  return { ...lastResponse, recovery_attempts: maxAttempts };
}

/**
 * Número máximo de intentos del CLI MLS ante fallos de sesión/login.
 * Default 2 (un reintento). Configurable vía EASYBROKER_MLS_MAX_ATTEMPTS,
 * acotado a [1, 3] para no disparar la latencia ni los timeouts del runtime.
 */
function easyBrokerMlsMaxAttempts(): number {
  const raw = Number(process.env.EASYBROKER_MLS_MAX_ATTEMPTS ?? "2");
  if (!Number.isFinite(raw)) return 2;
  return Math.min(Math.max(Math.trunc(raw), 1), 3);
}

async function executeEasyBrokerMlsCliOnce(
  pocDir: string,
  input: EasyBrokerSearchInput,
  toolId: "easybroker_search_listings" | "easybroker_search_closed_deals",
  creds: EasyBrokerWebCredentials,
  attempt: number
): Promise<Record<string, unknown>> {
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
        env: easyBrokerMlsCliEnv(creds),
      }
    );
    const parsed = parseCliJson(stdout);
    const response = buildEasyBrokerMlsToolResponse(
      toolId,
      input,
      parsed,
      stderr,
      creds.source
    );
    return { ...response, attempt };
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
      attempt,
      exit_code: error.code,
      error: error.message ?? String(err),
      ...(needsManualLogin
        ? {
            hint:
              "EasyBroker pidió verificar la sesión (login manual, CAPTCHA/MFA o sesión expirada). Reconecta EasyBroker MLS en Credenciales API → 'Probar conexión' (o corre el login asistido del POC) y vuelve a intentar.",
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
  return /captcha|recaptcha|403|forbidden|access denied|login manual|sesi[oó]n persistente|storage[- ]?state|mfa|did not reach mls|authenticated page|login did not reach|no se pudo navegar a bolsa|inicia sesi[oó]n|account\/authentication/i.test(
    value
  );
}

function easyBrokerMlsCliEnv(creds: EasyBrokerWebCredentials): NodeJS.ProcessEnv {
  return {
    ...process.env,
    EASYBROKER_WEB_URL: creds.loginUrl,
    EASYBROKER_WEB_EMAIL: creds.email,
    EASYBROKER_WEB_PASSWORD: creds.password,
    EASYBROKER_MLS_HEADLESS: process.env.EASYBROKER_MLS_HEADLESS ?? "false",
  };
}

type AssistedLoginGate =
  | { enabled: true; reason: "enabled_by_env" | "auto_interactive" }
  | {
      enabled: false;
      reason:
        | "disabled_by_env"
        | "ci_like"
        | "headless"
        | "non_interactive_stdout";
    };

function easyBrokerAutoAssistedLoginGate(): AssistedLoginGate {
  const raw = process.env.EASYBROKER_MLS_AUTO_ASSISTED_LOGIN?.trim().toLowerCase();
  if (raw) {
    if (raw === "1" || raw === "true" || raw === "yes") {
      return { enabled: true, reason: "enabled_by_env" };
    }
    return { enabled: false, reason: "disabled_by_env" };
  }
  const ci = process.env.CI?.trim().toLowerCase();
  const ciLike = ci === "1" || ci === "true" || ci === "yes";
  if (ciLike) return { enabled: false, reason: "ci_like" };
  const headless = process.env.EASYBROKER_MLS_HEADLESS?.trim().toLowerCase();
  if (headless === "true") return { enabled: false, reason: "headless" };
  if (!process.stdout.isTTY) {
    return { enabled: false, reason: "non_interactive_stdout" };
  }
  return { enabled: true, reason: "auto_interactive" };
}

function easyBrokerAutoAssistedTimeoutMs() {
  const raw = Number(process.env.EASYBROKER_MLS_AUTO_ASSISTED_TIMEOUT_MS ?? "300000");
  if (!Number.isFinite(raw) || raw <= 0) return 300_000;
  return Math.min(Math.max(Math.trunc(raw), 60_000), 900_000);
}

async function maybeRunEasyBrokerAssistedLogin(
  pocDir: string,
  creds: EasyBrokerWebCredentials
): Promise<Record<string, unknown>> {
  const gate = easyBrokerAutoAssistedLoginGate();
  if (!gate.enabled) {
    return {
      attempted: false,
      ok: false,
      reason: gate.reason,
      hint:
        gate.reason === "disabled_by_env"
          ? "EASYBROKER_MLS_AUTO_ASSISTED_LOGIN está desactivado por configuración."
          : gate.reason === "ci_like"
            ? "Entorno tipo CI detectado; login asistido requiere interacción humana local."
            : gate.reason === "headless"
              ? "EASYBROKER_MLS_HEADLESS=true bloquea login asistido (requiere navegador visible)."
              : "stdout no interactivo; define EASYBROKER_MLS_AUTO_ASSISTED_LOGIN=true para forzar el asistido en entorno local.",
    };
  }
  if (!(await fileExists(path.join(pocDir, "src", "login-assisted.mjs")))) {
    return {
      attempted: false,
      ok: false,
      reason: "login_assisted_script_not_found",
    };
  }

  const assistedTimeout = easyBrokerAutoAssistedTimeoutMs();
  const env = {
    ...easyBrokerMlsCliEnv(creds),
    EASYBROKER_MLS_HEADLESS: "false",
    EASYBROKER_ASSISTED_TIMEOUT_MS: String(assistedTimeout),
  };
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["src/login-assisted.mjs"],
      {
        cwd: pocDir,
        timeout: assistedTimeout + 30_000,
        maxBuffer: 4 * 1024 * 1024,
        env,
      }
    );
    const parsed = parseCliJson(stdout);
    return {
      attempted: true,
      ok: parsed.ok === true,
      gate_reason: gate.reason,
      timeout_ms: assistedTimeout,
      ...(parsed && Object.keys(parsed).length > 0 ? { result: parsed } : {}),
      ...(stderr.trim() ? { stderr: stderr.trim().slice(0, 2000) } : {}),
    };
  } catch (err) {
    const error = err as {
      message?: string;
      stdout?: string;
      stderr?: string;
    };
    const parsed = error.stdout ? parseCliJson(error.stdout) : null;
    const assistedOk = parsed?.ok === true;
    return {
      attempted: true,
      ok: assistedOk,
      gate_reason: gate.reason,
      timeout_ms: assistedTimeout,
      error: error.message ?? String(err),
      ...(parsed ? { result: parsed } : {}),
      ...(error.stderr?.trim() ? { stderr: error.stderr.trim().slice(0, 2000) } : {}),
    };
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
  const cliMetrics = Array.isArray(parsed.metrics)
    ? parsed.metrics.filter(
        (entry): entry is Record<string, unknown> =>
          Boolean(entry) && typeof entry === "object" && !Array.isArray(entry)
      )
    : [];
  const sessionRefreshed = cliMetrics.some(
    (metric) => metric.step === "save_storage_state" && metric.ok === true
  );
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
    session_refreshed: sessionRefreshed,
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

function comparableResultCount(payload: Record<string, unknown>) {
  if (typeof payload.count === "number" && Number.isFinite(payload.count)) {
    return payload.count;
  }
  const results = Array.isArray(payload.results) ? payload.results : [];
  return results.length;
}

function makeEasyBrokerSearchTool(
  ctx: ToolContext,
  toolId: "easybroker_search_listings" | "easybroker_search_closed_deals"
) {
  return tool(
    async (input: EasyBrokerSearchInput) => {
      const record = await createTrackedToolCall(ctx, toolId,
        input as unknown as Record<string, unknown>,
        false);
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
      const rawInput = input as unknown as Record<string, unknown>;
      const inputPropertyData = asRecord(rawInput.property_data);
      let casePropertyData: Record<string, unknown> | undefined;
      if (!inputPropertyData && ctx.caseId) {
        const opCase = await getOperationalCase(ctx.db, ctx.caseId);
        const caseContext = asRecord(opCase?.context_jsonb);
        const fromCase = asRecord(caseContext?.property_data) ?? caseContext;
        casePropertyData = fromCase ?? undefined;
      }
      const normalizedInput = sanitizeComparableSearchFilters({
        raw: rawInput,
        propertyData: inputPropertyData ?? casePropertyData,
      });
      if (normalizedInput.search_validity === "invalid_filters") {
        const out = {
          ok: false,
          status: "validation_error",
          source: "easybroker_mls",
          tool: toolId,
          error: "invalid_comparable_filters",
          invalid_fields: normalizedInput.invalid_fields,
          warnings: normalizedInput.warnings,
          suggested_filters: normalizedInput.suggested_filters ?? null,
          fallback_filters: normalizedInput.fallback_filters ?? null,
          filters_used: normalizedInput.filters,
        };
        await updateToolCallStatus(ctx.db, record.id, "executed", out);
        return JSON.stringify(out);
      }
      try {
        const primaryFilters = normalizedInput.filters as EasyBrokerSearchInput;
        const fallbackLadder = Array.isArray(normalizedInput.fallback_filter_ladder)
          ? normalizedInput.fallback_filter_ladder
              .filter((step) => isRecord(step) && isRecord(step.filters))
              .map((step) => ({
                level:
                  typeof step.level === "string" ? step.level : "expanded",
                reason:
                  typeof step.reason === "string" ? step.reason : "fallback",
                filters: step.filters as EasyBrokerSearchInput,
              }))
          : [];

        let out = await searchEasyBrokerProperties(
          ctx,
          toolId,
          primaryFilters,
          creds
        );
        let appliedFallbackLevel: string | null = null;
        const searchAttempts: Array<Record<string, unknown>> = [
          {
            level: "strict",
            reason: "canonical_strict",
            filters: primaryFilters,
            count: comparableResultCount(out),
          },
        ];

        if (out.ok !== false && comparableResultCount(out) === 0) {
          for (const step of fallbackLadder) {
            if (JSON.stringify(step.filters) === JSON.stringify(primaryFilters)) continue;
            const retryOut = await searchEasyBrokerProperties(
              ctx,
              toolId,
              step.filters,
              creds
            );
            searchAttempts.push({
              level: step.level,
              reason: step.reason,
              filters: step.filters,
              count: comparableResultCount(retryOut),
            });
            if (retryOut.ok !== false) {
              out = retryOut;
            }
            if (retryOut.ok !== false && comparableResultCount(retryOut) > 0) {
              appliedFallbackLevel = step.level;
              break;
            }
          }
        }

        const filtersUsed =
          appliedFallbackLevel == null
            ? normalizedInput.filters
            : (searchAttempts.find((attempt) => attempt.level === appliedFallbackLevel)
                ?.filters as EasyBrokerSearchInput | undefined) ?? normalizedInput.filters;

        const outWithFilters = {
          ...out,
          filters_used: filtersUsed,
          filter_warnings:
            normalizedInput.warnings.length > 0 || appliedFallbackLevel != null
              ? [
                  ...normalizedInput.warnings,
                  ...(appliedFallbackLevel != null
                    ? [
                        `Se aplico fallback de comparables en nivel ${appliedFallbackLevel} tras 0 resultados iniciales en banda estricta.`,
                      ]
                    : []),
                ]
              : undefined,
          search_attempts:
            searchAttempts.length > 1
              ? {
                  strict_filters: normalizedInput.filters,
                  attempts: searchAttempts,
                }
              : undefined,
        };
        if (out.ok !== false) {
          await markAccountSecretSuccess(
            ctx,
            ACCOUNT_TOOL_PROVIDERS_REALESTATE.easybroker_web
          );
        }
        await updateToolCallStatus(ctx.db, record.id, "executed", outWithFilters);
        return JSON.stringify(outWithFilters);
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

type PublishDestination = "easybroker" | "ungga" | "manual";

function collectPublishGateMissing(
  context: Record<string, unknown>,
  destination: PublishDestination
) {
  const propertyData = asRecord(context.property_data) ?? {};
  const pricingProposal = asRecord(context.pricing_proposal) ?? {};
  const contractReview = asRecord(context.contract_review) ?? {};
  const missing: string[] = [];
  const approvalStatus =
    typeof pricingProposal.approval_status === "string"
      ? pricingProposal.approval_status
      : typeof context.approval_status === "string"
        ? context.approval_status
        : "";
  if (approvalStatus !== "approved") {
    missing.push("pricing_proposal.approval_status=approved");
  }
  if (
    typeof contractReview.status !== "string" ||
    contractReview.status !== "sent_by_email"
  ) {
    missing.push("contract_review.status=sent_by_email");
  }
  const rawPhotos = Array.isArray(context.raw_photos) ? context.raw_photos.length : 0;
  if (rawPhotos < 5) missing.push("raw_photos>=5");
  if (!asRecord(context.photo_analysis) || Object.keys(asRecord(context.photo_analysis) ?? {}).length === 0) {
    missing.push("photo_analysis");
  }
  if (!asRecord(context.zone_context) || Object.keys(asRecord(context.zone_context) ?? {}).length === 0) {
    missing.push("zone_context");
  }
  const descriptionApproved = asRecord(context.listing_description_approved) ?? {};
  if (
    typeof descriptionApproved.description !== "string" ||
    !descriptionApproved.description.trim()
  ) {
    missing.push("listing_description_approved");
  }
  const publishApprovals = asRecord(context.publish_approvals) ?? {};
  if (destination !== "manual") {
    const destinationState = publishApprovals[destination];
    if (destinationState !== "approved") {
      missing.push(`publish_approvals.${destination}=approved`);
    }
  }
  const propertyType =
    typeof propertyData.property_type === "string"
      ? propertyData.property_type.trim()
      : typeof context.property_type === "string"
        ? context.property_type.trim()
        : "";
  const operationType =
    typeof propertyData.operation === "string"
      ? propertyData.operation.trim()
      : typeof context.operation_type === "string"
        ? context.operation_type.trim()
        : "";
  const currency =
    (typeof propertyData.currency === "string" && propertyData.currency.trim()) ||
    (typeof pricingProposal.currency === "string" && pricingProposal.currency.trim()) ||
    (typeof context.currency === "string" && context.currency.trim()) ||
    "";
  if (!propertyType) missing.push("property_type");
  if (!operationType) missing.push("operation_type");
  if (!currency) missing.push("currency");
  return missing;
}

async function enforcePublishGateForCase(params: {
  ctx: ToolContext;
  caseId: string;
  destination: PublishDestination;
}) {
  const opCase = await getOperationalCase(params.ctx.db, params.caseId);
  if (!opCase || opCase.user_id !== params.ctx.userId) {
    return {
      ok: false,
      status: "case_not_found",
      hint: "No encontré el caso asociado para validar publicación.",
    };
  }
  if (opCase.case_type !== "property_optioning") {
    return { ok: true as const, opCase };
  }
  const context = asRecord(opCase.context_jsonb) ?? {};
  const missing = collectPublishGateMissing(context, params.destination);
  if (missing.length > 0) {
    return {
      ok: false,
      status: "publish_gate_blocked",
      case_id: opCase.id,
      destination: params.destination,
      missing,
      hint:
        "No se puede publicar aún. Completa preflight, aprueba descripción y registra aprobación del destino.",
    };
  }
  return { ok: true as const, opCase };
}

async function approvedListingCopyFromCase(
  ctx: ToolContext,
  caseId: string
): Promise<{ headline: string; description: string } | null> {
  const opCase = await getOperationalCase(ctx.db, caseId).catch(() => null);
  if (!opCase || opCase.user_id !== ctx.userId) return null;
  const context = asRecord(opCase.context_jsonb) ?? {};
  const approved = asRecord(context.listing_description_approved) ?? {};
  const headline =
    typeof approved.headline === "string" ? approved.headline.trim() : "";
  const description =
    typeof approved.description === "string" ? approved.description.trim() : "";
  if (!description) return null;
  return { headline, description };
}

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
      const record = await createTrackedToolCall(ctx, "easybroker_create_listing",
        input as unknown as Record<string, unknown>,
        true);
      if (input.case_id) {
        const gate = await enforcePublishGateForCase({
          ctx,
          caseId: input.case_id,
          destination: "easybroker",
        });
        if (!gate.ok) {
          await updateToolCallStatus(ctx.db, record.id, "failed", gate);
          return JSON.stringify(gate);
        }
      }
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
        let inputForExecution = await applyDefaultEasyBrokerAgent(ctx, input);
        if (input.case_id) {
          const approvedCopy = await approvedListingCopyFromCase(ctx, input.case_id);
          if (approvedCopy) {
            inputForExecution = {
              ...inputForExecution,
              title: approvedCopy.headline || inputForExecution.title,
              description: approvedCopy.description,
            };
          }
        }
        attemptedPayload = buildEasyBrokerCreatePayload(inputForExecution);
        const out = await createEasyBrokerListing(ctx, inputForExecution, creds, attemptedPayload);
        await markEasyBrokerCredentialResult(ctx, creds, out.ok !== false, out.status);
        await updateToolCallStatus(ctx.db, record.id, out.ok === false ? "failed" : "executed", out);
        if (input.case_id && out.ok !== false) {
          await persistPublishedDestination(ctx, input.case_id, "easybroker", {
            listing_id:
              typeof out.listing_id === "string" ? out.listing_id : null,
            public_id:
              typeof out.public_id === "string" ? out.public_id : null,
            public_url:
              typeof out.public_url === "string"
                ? out.public_url
                : typeof out.url === "string"
                  ? out.url
                  : null,
            agent_url:
              typeof out.agent_url === "string" ? out.agent_url : null,
            status:
              typeof out.status === "string" ? out.status : "not_published",
          });
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
          await insertOperationalCaseEvent(ctx.db, {
            caseId: input.case_id,
            eventType: "step_completed",
            actor: "agent",
            stepKey: "package_ready",
            payload: {
              kind: "easybroker_published",
              destination: "easybroker",
              listing_id: out.listing_id ?? null,
              public_url: out.public_url ?? out.url ?? null,
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
      const record = await createTrackedToolCall(ctx, "easybroker_upload_images",
        input as unknown as Record<string, unknown>,
        true);
      if (input.case_id) {
        const gate = await enforcePublishGateForCase({
          ctx,
          caseId: input.case_id,
          destination: "easybroker",
        });
        if (!gate.ok) {
          await updateToolCallStatus(ctx.db, record.id, "failed", gate);
          return JSON.stringify(gate);
        }
      }
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

function normalizeAvaclickPropertyType(value: unknown) {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
  if (!normalized) return undefined;
  if (normalized === "house" || normalized.includes("casa habitacion")) return "house";
  if (
    normalized === "condo_house" ||
    normalized.includes("casa en condominio")
  ) {
    return "condo_house";
  }
  if (
    normalized === "condo_apartment" ||
    normalized.includes("depto en condominio") ||
    normalized.includes("departamento")
  ) {
    return "condo_apartment";
  }
  return undefined;
}

function normalizeAvaclickConservation(value: unknown) {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
  if (!normalized) return undefined;
  if (normalized === "new" || normalized === "nuevo") return "new";
  if (
    normalized === "very_good" ||
    normalized === "muy bueno" ||
    normalized === "muy_bueno"
  ) {
    return "very_good";
  }
  if (normalized === "good" || normalized === "bueno") return "good";
  if (normalized === "regular") return "regular";
  if (normalized === "bad" || normalized === "malo") return "bad";
  return undefined;
}

function normalizeAvaclickToolInput(raw: unknown): unknown {
  const root = asRecord(raw);
  if (!root) return raw;
  const customer = asRecord(root.customer) ?? {};
  const property = asRecord(root.property) ?? {};
  const propertyData = asRecord(root.property_data) ?? {};
  const address = asRecord(root.address) ??
    asRecord(property.address) ??
    asRecord(propertyData.address) ??
    {};
  const merged: Record<string, unknown> = { ...propertyData, ...property, ...root };
  return {
    customer_name:
      firstNonEmptyComparableString(
        merged.customer_name,
        customer.name,
        customer.customer_name
      ) ?? undefined,
    customer_email:
      firstNonEmptyComparableString(
        merged.customer_email,
        customer.email,
        customer.customer_email
      ) ?? undefined,
    customer_phone:
      firstNonEmptyComparableString(
        merged.customer_phone,
        customer.phone,
        customer.customer_phone
      ) ?? undefined,
    property_type: normalizeAvaclickPropertyType(
      merged.property_type ?? merged.tipo_inmueble ?? merged.propertyType
    ),
    latitude:
      typeof merged.latitude === "number"
        ? merged.latitude !== 0
          ? merged.latitude
          : undefined
        : (() => {
            const parsed = Number(merged.latitude ?? merged.lat);
            return Number.isFinite(parsed) && parsed !== 0 ? parsed : undefined;
          })(),
    longitude:
      typeof merged.longitude === "number"
        ? merged.longitude !== 0
          ? merged.longitude
          : undefined
        : (() => {
            const parsed = Number(merged.longitude ?? merged.lng ?? merged.lon);
            return Number.isFinite(parsed) && parsed !== 0 ? parsed : undefined;
          })(),
    state_name:
      firstNonEmptyComparableString(
        merged.state_name,
        merged.estado,
        property.state_name,
        address.state,
        address.estado
      ) ?? undefined,
    municipality_name:
      firstNonEmptyComparableString(
        merged.municipality_name,
        merged.municipio,
        property.municipality_name,
        address.municipality,
        address.municipio,
        address.city
      ) ?? undefined,
    neighborhood_name:
      firstNonEmptyComparableString(
        merged.neighborhood_name,
        merged.colonia,
        merged.neighborhood,
        property.neighborhood_name,
        address.neighborhood,
        address.colonia
      ) ?? undefined,
    zip_code:
      firstNonEmptyComparableString(
        merged.zip_code,
        merged.postal_code,
        merged.cp,
        property.zip_code,
        address.postal_code,
        address.cp,
        address.zip_code
      ) ?? undefined,
    street:
      firstNonEmptyComparableString(
        merged.street,
        merged.calle,
        merged.address_line,
        property.street,
        address.street,
        address.full,
        address.formatted
      ) ?? undefined,
    lot: firstNonEmptyComparableString(merged.lot, merged.lote) ?? undefined,
    block: firstNonEmptyComparableString(merged.block, merged.manzana) ?? undefined,
    interior_number:
      firstNonEmptyComparableString(merged.interior_number, merged.numero_interior) ??
      undefined,
    exterior_number:
      firstNonEmptyComparableString(
        merged.exterior_number,
        merged.numero_exterior,
        address.exterior_number,
        address.numero_exterior,
        address.number
      ) ?? undefined,
    land_area_m2: comparablePositiveNumber(merged.land_area_m2 ?? merged.terreno),
    construction_area_m2: comparablePositiveNumber(
      merged.construction_area_m2 ??
        merged.area_construida_m2 ??
        merged.built_area_m2 ??
        merged.construccion ??
        merged.area_m2
    ),
    has_elevator:
      typeof merged.has_elevator === "boolean"
        ? merged.has_elevator
        : merged.elevador === 1 || merged.elevador === "1" || undefined,
    apartment_floor:
      comparablePositiveNumber(
        merged.apartment_floor ?? merged.piso_departamento ?? merged.floor
      ) ?? undefined,
    age_years: comparablePositiveNumber(merged.age_years ?? merged.edad),
    parking_spaces:
      comparablePositiveNumber(merged.parking_spaces ?? merged.cochera),
    bedrooms: comparablePositiveNumber(merged.bedrooms ?? merged.recamaras),
    full_bathrooms:
      comparablePositiveNumber(
        merged.full_bathrooms ?? merged.banios ?? merged.bathrooms
      ),
    half_bathrooms:
      comparablePositiveNumber(merged.half_bathrooms ?? merged.medio_banio),
    floors: comparablePositiveNumber(merged.floors ?? merged.numero_pisos),
    conservation: normalizeAvaclickConservation(
      merged.conservation ?? merged.conservacion
    ),
    private_amenities:
      Array.isArray(merged.private_amenities) &&
      merged.private_amenities.every((item) => typeof item === "string")
        ? merged.private_amenities
        : undefined,
    common_amenities:
      Array.isArray(merged.common_amenities) &&
      merged.common_amenities.every((item) => typeof item === "string")
        ? merged.common_amenities
        : undefined,
  };
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function enrichGeocodeInputFromCaseContext(
  ctx: ToolContext,
  input: {
    street?: string;
    exterior_number?: string;
    neighborhood?: string;
    municipality?: string;
    state?: string;
    postal_code?: string;
    country?: string;
  }
) {
  const normalizedInput = {
    street: cleanString(input.street),
    exterior_number: cleanString(input.exterior_number),
    neighborhood: cleanString(input.neighborhood),
    municipality: cleanString(input.municipality),
    state: cleanString(input.state),
    postal_code: cleanString(input.postal_code),
    country: cleanString(input.country),
  };
  if (!ctx.caseId) return normalizedInput;

  const opCase = await getOperationalCase(ctx.db, ctx.caseId);
  const caseContext = asRecord(opCase?.context_jsonb);
  const propertyData = asRecord(caseContext?.property_data) ?? caseContext ?? {};
  const address = asRecord(propertyData.address) ?? {};

  return {
    street:
      normalizedInput.street ??
      firstNonEmptyComparableString(
        address.street,
        address.full,
        address.formatted,
        propertyData.street,
        propertyData.calle
      ) ??
      undefined,
    exterior_number:
      normalizedInput.exterior_number ??
      firstNonEmptyComparableString(
        address.exterior_number,
        address.numero_exterior,
        address.number,
        propertyData.exterior_number,
        propertyData.numero_exterior
      ) ??
      undefined,
    neighborhood:
      normalizedInput.neighborhood ??
      firstNonEmptyComparableString(
        propertyData.neighborhood,
        propertyData.colonia,
        address.neighborhood,
        address.colonia
      ) ??
      undefined,
    municipality:
      normalizedInput.municipality ??
      firstNonEmptyComparableString(
        propertyData.municipality,
        propertyData.municipio,
        propertyData.city,
        address.municipality,
        address.municipio,
        address.city
      ) ??
      undefined,
    state:
      normalizedInput.state ??
      firstNonEmptyComparableString(
        propertyData.state,
        propertyData.estado,
        address.state,
        address.estado
      ) ??
      undefined,
    postal_code:
      normalizedInput.postal_code ??
      firstNonEmptyComparableString(
        propertyData.postal_code,
        propertyData.cp,
        propertyData.zip_code,
        address.postal_code,
        address.cp,
        address.zip_code
      ) ??
      undefined,
    country:
      normalizedInput.country ??
      firstNonEmptyComparableString(propertyData.country, propertyData.pais, address.country) ??
      undefined,
  };
}

function geocodePostalMunicipalityFromFormattedAddress(formattedAddress: string): {
  geocoded_postal_code?: string;
  geocoded_municipality?: string;
} {
  const cleaned = cleanString(formattedAddress);
  if (!cleaned) return {};
  const postalAndMunicipality = cleaned.match(/\b(\d{5})\s+([^,]+?)(?:,\s*[^,]+)?(?:,\s*Mexico|,\s*M[eé]xico)?$/i);
  if (!postalAndMunicipality) return {};
  const postal = cleanString(postalAndMunicipality[1]);
  const municipality = cleanString(postalAndMunicipality[2]);
  return {
    geocoded_postal_code: postal,
    geocoded_municipality: municipality,
  };
}

function normalizeAddressComparable(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function isGeocodeAlignedWithCanonicalAddress(params: {
  canonicalStreet?: unknown;
  canonicalExterior?: unknown;
  requestStreet?: unknown;
  requestExterior?: unknown;
  formattedAddress?: unknown;
}) {
  const canonicalStreet = normalizeAddressComparable(params.canonicalStreet);
  const canonicalExterior = normalizeAddressComparable(params.canonicalExterior);
  if (!canonicalStreet && !canonicalExterior) return true;
  const requestStreet = normalizeAddressComparable(params.requestStreet);
  const requestExterior = normalizeAddressComparable(params.requestExterior);
  const formattedAddress = normalizeAddressComparable(params.formattedAddress);
  if (canonicalStreet && requestStreet && canonicalStreet !== requestStreet) return false;
  if (canonicalExterior && requestExterior && canonicalExterior !== requestExterior) return false;
  if (canonicalStreet && formattedAddress && !formattedAddress.includes(canonicalStreet)) return false;
  if (canonicalExterior && formattedAddress && !formattedAddress.includes(canonicalExterior)) return false;
  return true;
}

async function latestSuccessfulGeocodeFromCurrentTurn(ctx: ToolContext): Promise<{
  latitude?: number;
  longitude?: number;
  formatted_address?: string;
  geocode_provider?: string;
  geocode_confidence?: string;
  place_id?: string;
  geocoded_postal_code?: string;
  geocoded_municipality?: string;
} | null> {
  if (!ctx.turnId) return null;
  const { data, error } = await ctx.db
    .from("tool_calls")
    .select("result_json,created_at")
    .eq("turn_id", ctx.turnId)
    .eq("tool_name", "geocode_property_address")
    .eq("status", "executed")
    .order("created_at", { ascending: false })
    .limit(5);
  if (error) return null;
  const firstSuccessful = (data ?? [])
    .map((row) => asRecord((row as { result_json?: unknown }).result_json))
    .find(
      (result) =>
        result?.ok === true &&
        result?.status === "ok" &&
        typeof result.latitude === "number" &&
        typeof result.longitude === "number"
    );
  if (!firstSuccessful) return null;
  const formatted_address = cleanString(firstSuccessful.formatted_address);
  const parsedAddress = formatted_address
    ? geocodePostalMunicipalityFromFormattedAddress(formatted_address)
    : {};
  return {
    latitude: numberOrUndefined(firstSuccessful.latitude),
    longitude: numberOrUndefined(firstSuccessful.longitude),
    formatted_address,
    geocode_provider: cleanString(firstSuccessful.provider),
    geocode_confidence: cleanString(firstSuccessful.confidence),
    place_id:
      Array.isArray(firstSuccessful.candidates) && firstSuccessful.candidates.length > 0
        ? cleanString(asRecord(firstSuccessful.candidates[0])?.place_id)
        : undefined,
    geocoded_postal_code: parsedAddress.geocoded_postal_code,
    geocoded_municipality: parsedAddress.geocoded_municipality,
  };
}

async function persistGeocodeResultToCaseContext(
  ctx: ToolContext,
  requestInput: {
    street?: string;
    exterior_number?: string;
    neighborhood?: string;
    municipality?: string;
    state?: string;
    postal_code?: string;
    country?: string;
  },
  out: {
    latitude: number;
    longitude: number;
    formatted_address: string;
    provider: string;
    confidence: "high" | "medium" | "low";
    candidates: Array<{ place_id?: string | null }>;
  }
) {
  if (!ctx.caseId) return;
  const opCase = await getOperationalCase(ctx.db, ctx.caseId);
  if (!opCase || opCase.user_id !== ctx.userId) return;
  const context = asRecord(opCase.context_jsonb) ?? {};
  const propertyData = asRecord(context.property_data) ?? {};
  const address = asRecord(propertyData.address) ?? {};
  const canonicalStreet =
    firstNonEmptyComparableString(address.street, propertyData.street, propertyData.calle) ?? null;
  const canonicalExterior =
    firstNonEmptyComparableString(
      address.exterior_number,
      address.numero_exterior,
      propertyData.exterior_number,
      propertyData.numero_exterior
    ) ?? null;
  const aligned = isGeocodeAlignedWithCanonicalAddress({
    canonicalStreet,
    canonicalExterior,
    requestStreet: requestInput.street,
    requestExterior: requestInput.exterior_number,
    formattedAddress: out.formatted_address,
  });
  if (!aligned) {
    await insertOperationalCaseEvent(ctx.db, {
      caseId: opCase.id,
      eventType: "state_changed",
      actor: "system",
      payload: {
        kind: "property_address_geocode_discarded_mismatch",
        source: "geocode_property_address",
        request_input: requestInput,
        canonical_street: canonicalStreet,
        canonical_exterior_number: canonicalExterior,
        formatted_address: out.formatted_address,
      },
    });
    return;
  }
  const geocodedParts = geocodePostalMunicipalityFromFormattedAddress(out.formatted_address);
  const nextAddress: Record<string, unknown> = {
    ...address,
    latitude: out.latitude,
    longitude: out.longitude,
    formatted_address: out.formatted_address,
    geocode_provider: out.provider,
    geocode_confidence: out.confidence,
    geocoded_at: new Date().toISOString(),
    ...(out.candidates[0]?.place_id ? { place_id: out.candidates[0]?.place_id } : {}),
    ...(geocodedParts.geocoded_postal_code
      ? { geocoded_postal_code: geocodedParts.geocoded_postal_code }
      : {}),
    ...(geocodedParts.geocoded_municipality
      ? { geocoded_municipality: geocodedParts.geocoded_municipality }
      : {}),
  };
  const nextPropertyData: Record<string, unknown> = {
    ...propertyData,
    address: nextAddress,
  };
  const updated = await updateOperationalCase(ctx.db, opCase.id, opCase.version, {
    context: {
      ...context,
      property_data: nextPropertyData,
    },
  });
  if (!updated) return;
  await insertOperationalCaseEvent(ctx.db, {
    caseId: updated.id,
    eventType: "state_changed",
    actor: "system",
    payload: {
      kind: "property_address_geocoded",
      source: "geocode_property_address",
      confidence: out.confidence,
      provider: out.provider,
      formatted_address: out.formatted_address,
      request_input: requestInput,
      geocoded_postal_code: geocodedParts.geocoded_postal_code ?? null,
      geocoded_municipality: geocodedParts.geocoded_municipality ?? null,
    },
  });
}

async function enrichAvaclickInputFromCaseContext(
  ctx: ToolContext,
  input: AvaclickValuationInput
): Promise<AvaclickValuationInput> {
  const enriched: AvaclickValuationInput = { ...input };
  let canonicalStreet: string | undefined;
  let canonicalExterior: string | undefined;
  const coordinateFromUnknown = (value: unknown): number | undefined => {
    if (typeof value === "number" && Number.isFinite(value) && value !== 0) return value;
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value.trim().replace(/,/g, ""));
      return Number.isFinite(parsed) && parsed !== 0 ? parsed : undefined;
    }
    return undefined;
  };
  let contextAddress: Record<string, unknown> = {};
  if (ctx.caseId) {
    const opCase = await getOperationalCase(ctx.db, ctx.caseId);
    const caseContext = asRecord(opCase?.context_jsonb);
    const propertyData = asRecord(caseContext?.property_data) ?? caseContext ?? {};
    contextAddress = asRecord(propertyData.address) ?? {};
    canonicalStreet = firstNonEmptyComparableString(
      contextAddress.street,
      contextAddress.full,
      contextAddress.formatted,
      propertyData.street,
      propertyData.calle
    );
    canonicalExterior = firstNonEmptyComparableString(
      contextAddress.exterior_number,
      contextAddress.numero_exterior,
      contextAddress.number,
      propertyData.exterior_number,
      propertyData.numero_exterior
    );
    const contextGeocodeConfidence = firstNonEmptyComparableString(
      contextAddress.geocode_confidence,
      contextAddress.confidence
    );
    const contextGeocodeTrusted =
      typeof contextGeocodeConfidence === "string" &&
      contextGeocodeConfidence.trim().toLowerCase() === "high";
    if (contextGeocodeTrusted && (enriched.latitude == null || enriched.longitude == null)) {
      const contextFormattedAddress = firstNonEmptyComparableString(
        contextAddress.formatted_address,
        contextAddress.full,
        contextAddress.formatted
      );
      const aligned = isGeocodeAlignedWithCanonicalAddress({
        canonicalStreet,
        canonicalExterior,
        formattedAddress: contextFormattedAddress,
      });
      if (aligned) {
        if (enriched.latitude == null) {
          enriched.latitude = coordinateFromUnknown(contextAddress.latitude);
        }
        if (enriched.longitude == null) {
          enriched.longitude = coordinateFromUnknown(contextAddress.longitude);
        }
      }
    }
    enriched.street =
      enriched.street ??
      firstNonEmptyComparableString(
        contextAddress.street,
        contextAddress.full,
        contextAddress.formatted,
        propertyData.street,
        propertyData.calle
      );
    enriched.exterior_number =
      enriched.exterior_number ??
      firstNonEmptyComparableString(
        contextAddress.exterior_number,
        contextAddress.numero_exterior,
        contextAddress.number,
        propertyData.exterior_number,
        propertyData.numero_exterior
      );
    enriched.neighborhood_name =
      enriched.neighborhood_name ??
      firstNonEmptyComparableString(
        contextAddress.neighborhood,
        contextAddress.colonia,
        propertyData.neighborhood,
        propertyData.colonia
      );
    enriched.municipality_name =
      enriched.municipality_name ??
      firstNonEmptyComparableString(
        contextAddress.geocoded_municipality,
        contextAddress.municipality,
        contextAddress.municipio,
        propertyData.municipality,
        propertyData.municipio,
        propertyData.city
      );
    enriched.zip_code =
      enriched.zip_code ??
      firstNonEmptyComparableString(
        contextAddress.geocoded_postal_code,
        contextAddress.postal_code,
        contextAddress.cp,
        contextAddress.zip_code,
        propertyData.postal_code,
        propertyData.cp,
        propertyData.zip_code
      );
    enriched.state_name =
      enriched.state_name ??
      firstNonEmptyComparableString(
        contextAddress.state,
        contextAddress.estado,
        propertyData.state,
        propertyData.estado
      );
    // Superficies: Avaclick rechaza valoraciones (validation_error) cuando
    // falta land_area_m2 (terreno) en casas. Tomamos las superficies canónicas
    // de property_data cuando el agente no las proporcionó.
    if (enriched.land_area_m2 == null) {
      enriched.land_area_m2 = comparablePositiveNumber(
        propertyData.area_total_m2 ??
          propertyData.terreno ??
          propertyData.area_terreno_m2 ??
          propertyData.lot_area_m2 ??
          propertyData.surface_m2 ??
          propertyData.sup_terr
      );
    }
    if (enriched.construction_area_m2 == null) {
      const constructionFromContext = comparablePositiveNumber(
        propertyData.area_construida_m2 ??
          propertyData.construction_area_m2 ??
          propertyData.built_area_m2 ??
          propertyData.sup_const
      );
      if (constructionFromContext != null) {
        enriched.construction_area_m2 = constructionFromContext;
      }
    }
    if (enriched.bedrooms == null) {
      enriched.bedrooms = comparablePositiveNumber(
        propertyData.bedrooms ?? propertyData.recamaras ?? propertyData.habitaciones
      );
    }
    if (enriched.full_bathrooms == null) {
      enriched.full_bathrooms = comparablePositiveNumber(
        propertyData.full_bathrooms ?? propertyData.bathrooms ?? propertyData.banios
      );
    }
    if (enriched.half_bathrooms == null) {
      if (
        typeof propertyData.half_bathrooms === "number" &&
        Number.isFinite(propertyData.half_bathrooms)
      ) {
        enriched.half_bathrooms = Math.max(0, propertyData.half_bathrooms);
      } else if (
        typeof propertyData.medios_banos === "number" &&
        Number.isFinite(propertyData.medios_banos)
      ) {
        enriched.half_bathrooms = Math.max(0, propertyData.medios_banos);
      }
    }
    if (enriched.parking_spaces == null) {
      enriched.parking_spaces = comparablePositiveNumber(
        propertyData.parking_spots ?? propertyData.parking_spaces ?? propertyData.cochera
      );
    }
    if (enriched.floors == null) {
      enriched.floors = comparablePositiveNumber(
        propertyData.floors ?? propertyData.numero_pisos ?? propertyData.plantas
      );
    }
    if (propertyData.integral_kitchen === true || propertyData.cocina_integral === true) {
      const currentPrivateAmenities = Array.isArray(enriched.private_amenities)
        ? [...enriched.private_amenities]
        : [];
      if (
        !currentPrivateAmenities.some(
          (value) =>
            typeof value === "string" &&
            value
              .normalize("NFD")
              .replace(/\p{Diacritic}/gu, "")
              .toLowerCase()
              .includes("cocina integral")
        )
      ) {
        currentPrivateAmenities.push("Cocina Integral");
      }
      enriched.private_amenities = currentPrivateAmenities;
    }
    if (enriched.conservation == null) {
      const conservationHint = normalizeAvaclickConservation(
        propertyData.conservation ??
          propertyData.estado_conservacion ??
          propertyData.conservation_state
      );
      // Default neutro: Avaclick puede requerir conservation; "good" es el
      // punto medio defendible cuando no hay señal explícita en el caso.
      enriched.conservation = conservationHint ?? "good";
    }
  }

  if (enriched.latitude == null || enriched.longitude == null) {
    const geocodeFromTurn = await latestSuccessfulGeocodeFromCurrentTurn(ctx);
    const geocodeFromTurnAligned = geocodeFromTurn
      ? isGeocodeAlignedWithCanonicalAddress({
          canonicalStreet,
          canonicalExterior,
          formattedAddress: geocodeFromTurn.formatted_address,
        })
      : false;
    if (geocodeFromTurn && geocodeFromTurnAligned) {
      enriched.latitude = enriched.latitude ?? geocodeFromTurn.latitude;
      enriched.longitude = enriched.longitude ?? geocodeFromTurn.longitude;
      enriched.municipality_name =
        enriched.municipality_name ?? geocodeFromTurn.geocoded_municipality;
      enriched.zip_code = enriched.zip_code ?? geocodeFromTurn.geocoded_postal_code;
    }
  }

  if (enriched.latitude == null || enriched.longitude == null) {
    const geocodeInput = {
      street: enriched.street,
      exterior_number: enriched.exterior_number,
      neighborhood: enriched.neighborhood_name,
      municipality: enriched.municipality_name,
      state: enriched.state_name,
      postal_code: enriched.zip_code,
      country: "MX",
    };
    const filledComponents = [
      geocodeInput.street,
      geocodeInput.neighborhood,
      geocodeInput.municipality,
      geocodeInput.state,
      geocodeInput.postal_code,
    ].filter((item) => typeof item === "string" && item.trim().length > 0).length;
    if (filledComponents >= 2) {
      try {
        const geocodeOut = await geocodePropertyAddress(geocodeInput);
        if (
          geocodeOut.ok &&
          geocodeOut.status === "ok" &&
          isUnequivocalGeocodeForAvaclick(geocodeOut) &&
          typeof geocodeOut.latitude === "number" &&
          typeof geocodeOut.longitude === "number"
        ) {
          enriched.latitude = geocodeOut.latitude;
          enriched.longitude = geocodeOut.longitude;
          if (ctx.caseId) {
            await persistGeocodeResultToCaseContext(ctx, geocodeInput, geocodeOut);
          }
        }
      } catch {
        // Avaclick seguirá con validation_error si faltan coordenadas.
      }
    }
  }

  return enriched;
}

function isUnequivocalGeocodeForAvaclick(geocodeOut: {
  confidence: "high" | "medium" | "low";
  candidates: Array<{ confidence: "high" | "medium" | "low" }>;
}) {
  if (geocodeOut.confidence === "high") return true;
  if (geocodeOut.confidence !== "medium") return false;
  return !geocodeOut.candidates
    .slice(1)
    .some((candidate) => candidate.confidence === "high" || candidate.confidence === "medium");
}

function firstNonEmptyComparableString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const cleaned = cleanString(value);
    if (cleaned) return cleaned;
  }
  return undefined;
}


function comparablePositiveNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = Number(trimmed.replace(/,/g, ""));
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function comparablePositiveInt(value: unknown): number | undefined {
  const parsed = comparablePositiveNumber(value);
  if (parsed == null) return undefined;
  const rounded = Math.trunc(parsed);
  return rounded > 0 ? rounded : undefined;
}

function normalizeComparableOperation(value: unknown): "sale" | "rent" | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "sale" || normalized === "venta") return "sale";
  if (normalized === "rent" || normalized === "renta") return "rent";
  return undefined;
}

function normalizeBigQueryComparableLookupInput(
  raw: unknown
): BigQueryComparableLookupInput | unknown {
  const root = asRecord(raw);
  if (!root) return raw;
  const nestedFilters = asRecord(root.filters) ?? {};
  const nestedAddress = asRecord(root.address) ?? {};
  const merged: Record<string, unknown> = { ...nestedFilters, ...root };
  const mergedAddress = asRecord(merged.address) ?? nestedAddress;

  const normalized: BigQueryComparableLookupInput = {
    zona: firstNonEmptyComparableString(
      merged.zona,
      merged.search_zone,
      merged.neighborhood,
      merged.colonia,
      merged.property_zone,
      merged.city_area,
      merged.city,
      mergedAddress.neighborhood,
      mergedAddress.colonia,
      mergedAddress.city,
      mergedAddress.state,
      merged.address
    ),
    operation: normalizeComparableOperation(
      merged.operation ?? merged.operation_type ?? merged.monetization_type
    ),
    property_type: firstNonEmptyComparableString(
      merged.property_type,
      merged.propertyType,
      merged.property_kind,
      merged.tipo_propiedad
    ),
    target_price: comparablePositiveNumber(merged.target_price ?? merged.targetPrice),
    price: comparablePositiveNumber(merged.price),
    min_price: comparablePositiveNumber(merged.min_price ?? merged.price_min),
    max_price: comparablePositiveNumber(merged.max_price ?? merged.price_max),
    min_area_m2: comparablePositiveNumber(
      merged.min_area_m2 ?? merged.min_area ?? merged.area_min
    ),
    max_area_m2: comparablePositiveNumber(
      merged.max_area_m2 ?? merged.max_area ?? merged.area_max
    ),
    months_back: comparablePositiveInt(
      merged.months_back ?? merged.monthsBack ?? merged.max_age_months
    ),
    limit: comparablePositiveInt(merged.limit),
  };

  return Object.fromEntries(
    Object.entries(normalized).filter(([, value]) => value !== undefined)
  ) as BigQueryComparableLookupInput;
}

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
