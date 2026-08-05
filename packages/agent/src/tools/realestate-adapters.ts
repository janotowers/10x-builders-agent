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
import { createHash } from "node:crypto";
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
  IMAGE_VISION_MODEL_ID,
  LISTING_COPY_MODEL_ID,
} from "../model";
import {
  recordOpenRouterCallUsage,
  type OpenRouterUsagePayload,
} from "../usage/ai-usage-meter";
import {
  executeBigQueryQuery,
  type BigQueryParamValue,
} from "./bigquery-adapter";
import { getAccountAssetByStoragePath,
  listAccountAssets,
  upsertAccountAsset,
  updateToolCallStatus,
  getOperationalCase,
  listOperationalCaseDocuments,
  insertOperationalCaseEvent,
  getRecentOperationalCaseEvents,
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
  buildContractDataReviewNotifyText,
  buildPropertyDataMinimumsSummaryMessage,
  documentExtractionMinimumsContext,
  evaluatePropertyAdvanceGate,
  evaluatePropertyDataMinimumsForReview,
  ownerConsistencyStatusFromFields,
} from "./operational-cases-adapters";
import {
  buildContractCommercialMinimumsSummaryMessage,
  evaluateContractCommercialMinimums,
  mapCollaborationToEasyBroker,
  mapCollaborationToUngga,
  parseCommissionTerms,
} from "../operational-cases/contract-commercial-terms";
import { sanitizeComparableSearchFilters, mapToEasyBrokerPropertyType, propertyTypesMatch } from "../operational-cases/comparable-search-contract";
import {
  applyPublicUrlsToManifest,
  applyWatermarkOutputsToManifest,
  buildPhotoManifestFromRawPhotos,
  mergePhotoLabelsIntoManifest,
  normalizePhotoSourcePath,
  parsePhotoManifest,
  photoUploadPairsFromManifest,
  resolveRawPhotoPaths,
  type PhotoManifestEntry,
  type PhotoUploadPair,
} from "../operational-cases/photo-manifest";
import {
  contextRequiresWatermark,
  findAccountWatermarkAsset,
  resolveRequireWatermark,
} from "../operational-cases/watermark-requirement";
import { sanitizeListingDescriptionCommercialCopy } from "../operational-cases/listing-description-review";

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
const IMAGE_VISION_MAX_TOKENS = Number(
  process.env.IMAGE_VISION_MAX_TOKENS?.trim() || "2200"
);
const IMAGE_VISION_TEMPERATURE = Number(
  process.env.IMAGE_VISION_TEMPERATURE?.trim() || "0"
);
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
  const startedAt = Date.now();
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
      // Slice 0.4: pide el costo facturado en la respuesta (usage.cost).
      usage: { include: true },
    }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    id?: string;
    choices?: Array<{ message?: { content?: string } }>;
    usage?: OpenRouterUsagePayload;
    error?: { message?: string };
  };
  const content = body.choices?.[0]?.message?.content;
  // Slice 0.4 — metering best-effort (nunca bloquea la tool).
  void recordOpenRouterCallUsage({
    modelId: input.model,
    modelRole:
      input.model === IMAGE_VISION_MODEL_ID
        ? "image_vision"
        : input.model === LISTING_COPY_MODEL_ID
          ? "listing_copy"
          : "realestate_json_tool",
    operation: input.model === IMAGE_VISION_MODEL_ID ? "vision" : "chat_completion",
    usage: body.usage ?? null,
    providerRequestId: typeof body.id === "string" ? body.id : null,
    latencyMs: Date.now() - startedAt,
    status: res.ok && content ? "ok" : "error",
    errorCode: res.ok && content ? null : `http_${res.status}`,
  });
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

export type UnggaLocationSource =
  | "input"
  | "property_data"
  | "geocode"
  | "zone_context";

/**
 * Canonical Ungga address string: legal_address first, then composed address
 * object, then street fragments. Never lets bare street beat legal_address.
 */
export function resolveUnggaCanonicalAddress(
  propertyData: Record<string, unknown> | null | undefined
): string | null {
  const data = asRecord(propertyData) ?? {};
  const addressObj = asRecord(data.address);
  const composed = addressObj ? composeAddressFromRecord(addressObj) : null;
  return firstNonEmptyString(
    data.legal_address,
    typeof data.address === "string" ? data.address : null,
    composed,
    data.street,
    data.calle
  );
}

/**
 * Resolve usable lat/lng for Ungga prepare (parity with EasyBroker merge).
 * Rejects 0,0 / near-zero placeholders via isUsableLatLng.
 */
export function resolveUnggaLocationFromCaseSources(sources: {
  inputLocation?: Record<string, unknown> | null;
  propertyData?: Record<string, unknown> | null;
  geocode?: Record<string, unknown> | null;
  zoneContext?: Record<string, unknown> | null;
}): {
  latitude: number;
  longitude: number;
  source: UnggaLocationSource;
} | null {
  const inputLoc = asRecord(sources.inputLocation) ?? {};
  const inputLat = safeNumber(inputLoc.latitude ?? inputLoc.lat);
  const inputLng = safeNumber(
    inputLoc.longitude ?? inputLoc.lng ?? inputLoc.lon
  );
  if (isUsableLatLng(inputLat, inputLng)) {
    return {
      latitude: inputLat as number,
      longitude: inputLng as number,
      source: "input",
    };
  }

  const propertyData = asRecord(sources.propertyData) ?? {};
  const address = asRecord(propertyData.address) ?? {};
  const propertyLoc = asRecord(propertyData.location) ?? {};
  const geocode = asRecord(sources.geocode) ?? {};
  const zoneContext = asRecord(sources.zoneContext) ?? {};
  const zoneCoordinates = asRecord(zoneContext.coordinates) ?? {};

  const candidates: Array<{
    lat: unknown;
    lng: unknown;
    source: UnggaLocationSource;
  }> = [
    {
      lat: address.latitude ?? address.lat,
      lng: address.longitude ?? address.lng ?? address.lon,
      source: "property_data",
    },
    {
      lat: propertyLoc.latitude ?? propertyLoc.lat,
      lng: propertyLoc.longitude ?? propertyLoc.lng ?? propertyLoc.lon,
      source: "property_data",
    },
    {
      lat: propertyData.latitude ?? propertyData.lat,
      lng: propertyData.longitude ?? propertyData.lng ?? propertyData.lon,
      source: "property_data",
    },
    {
      lat: geocode.latitude ?? geocode.lat,
      lng: geocode.longitude ?? geocode.lng ?? geocode.lon,
      source: "geocode",
    },
    {
      lat: zoneContext.latitude ?? zoneContext.lat,
      lng: zoneContext.longitude ?? zoneContext.lng ?? zoneContext.lon,
      source: "zone_context",
    },
    {
      lat: zoneCoordinates.latitude ?? zoneCoordinates.lat,
      lng:
        zoneCoordinates.longitude ??
        zoneCoordinates.lng ??
        zoneCoordinates.lon,
      source: "zone_context",
    },
  ];

  for (const candidate of candidates) {
    const lat = safeNumber(candidate.lat);
    const lng = safeNumber(candidate.lng);
    if (isUsableLatLng(lat, lng)) {
      return {
        latitude: lat as number,
        longitude: lng as number,
        source: candidate.source,
      };
    }
  }
  return null;
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
          stepKey: updated.current_step ?? undefined,
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
  const {
    buildPublicationContextPatch,
    publicationFromContext,
    reconcilePublicationWithArtifacts,
  } = await import("../operational-cases/publication-workflow");
  const nextContextBase = {
    ...currentContext,
    published: nextPublished,
  };
  const publication = reconcilePublicationWithArtifacts(
    publicationFromContext(nextContextBase),
    nextContextBase
  );
  const publicationPatch = buildPublicationContextPatch(publication);
  return persistCaseContextPatch(
    ctx,
    caseId,
    {
      ...publicationPatch,
      published: {
        ...(asPlainRecord(publicationPatch.published)),
        [destination]: {
          ...asPlainRecord(
            asPlainRecord(publicationPatch.published)[destination]
          ),
          ...destinationPatch,
        },
      },
    },
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

/**
 * Coordenadas usables para Places/Avaclick. Rechaza placeholders (0,0) que el
 * LLM suele pasar cuando “no sabe” lat/lng — eso apuntaría a Null Island.
 */
export function isUsableLatLng(
  lat: number | null | undefined,
  lon: number | null | undefined
): boolean {
  if (lat == null || lon == null) return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (lat === 0 && lon === 0) return false;
  if (Math.abs(lat) < 1e-6 && Math.abs(lon) < 1e-6) return false;
  return true;
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

/** Structured Outputs–safe optional: accepts null and coerces to undefined. */
const nullableOptional = <T extends z.ZodTypeAny>(schema: T) =>
  schema.nullish().transform((value) => value ?? undefined);

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
  if (toolEnabled("easybroker_publish_listing", ctx)) {
    tools.push(makeEasyBrokerPublishListingTool(ctx));
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
          data?: Record<string, unknown>;
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
            } else if (
              caseIdForEvent &&
              out.ok === false &&
              out.error === "commission_contract_missing_required_data" &&
              input.template_slug === "commission_contract"
            ) {
              const missingRequiredFields = Array.isArray(
                out.missing_required_fields
              )
                ? out.missing_required_fields.filter(
                    (field): field is string =>
                      typeof field === "string" && field.trim().length > 0
                  )
                : [];
              const remediation = await emitOwnedContractDataReviewIfNeeded(
                ctx,
                deps,
                {
                  caseId: caseIdForEvent,
                  missingRequiredFields,
                }
              );
              out.owned_remediation = {
                kind: "contract_data_review",
                ...remediation,
              };
            }
            return JSON.stringify(out);
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            const out = {
              ok: false,
              status: /502|503|504|cloudflare|bad gateway/i.test(message)
                ? "infrastructure_error"
                : "failed",
              error: message,
              hint: /502|503|504|cloudflare|bad gateway/i.test(message)
                ? "Error temporal del almacenamiento al renderizar el DOCX. Reintenta con «Revisar avance»."
                : undefined,
            };
            // Mark the audit row failed BEFORE releasing followers so a later
            // classify/heal pass never treats this attempt as live HITL.
            await updateToolCallStatus(ctx.db, record.id, "failed", out);
            // Liberamos el slot para permitir un reintento real tras un fallo
            // (no queremos que un error deje "deduplicadas" las reintentos).
            ctx.generateDocumentInFlight.delete(inFlightKey);
            ctx.generateDocumentDeferredByKey.delete(inFlightKey);
            // Resolve (don't reject) so same-turn followers receive the payload
            // instead of bubbling an uncaught exception to the graph wrapper.
            deferred.resolve(out);
            return JSON.stringify(out);
          }
        },
        {
          name: "generate_document_from_template",
          description:
            "Renders a DOCX document from a tenant-scoped template stored in account_assets. The placeholder values are derived automatically from the operational case (property_data, pricing_proposal, contact); `data` is optional and only needed to override or add fields. Omit optional fields instead of sending empty strings.",
          schema: z.preprocess(
            stripEmptyAndNullishProps,
            z.object({
              template_slug: z.string().min(1),
              asset_key: z.string().min(1).optional(),
              format: z.enum(["docx", "pdf"]),
              data: z.record(z.string(), z.any()).optional(),
              case_id: z.string().min(1).optional(),
            })
          ),
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
          case_id?: string;
        }) => {
          const record = await createTrackedToolCall(ctx, "image_watermark",
            input as unknown as Record<string, unknown>,
            false);
          try {
            if (input.case_id) {
              const opCase = await getOperationalCase(ctx.db, input.case_id).catch(
                () => null
              );
              const rawPaths = resolveRawPhotoPaths(
                asRecord(opCase?.context_jsonb)?.raw_photos
              );
              const normalizedInput = input.input_paths.map(normalizePhotoSourcePath);
              if (
                rawPaths.length > 0 &&
                (rawPaths.length !== normalizedInput.length ||
                  rawPaths.some((photoPath, index) => photoPath !== normalizedInput[index]))
              ) {
                const out = {
                  ok: false,
                  status: "photo_identity_mismatch",
                  expected_paths: rawPaths,
                  received_paths: normalizedInput,
                  missing: rawPaths.filter((photoPath) => !normalizedInput.includes(photoPath)),
                  hint:
                    "input_paths debe contener exactamente raw_photos, en el mismo orden.",
                };
                await updateToolCallStatus(ctx.db, record.id, "failed", out);
                return JSON.stringify(out);
              }
            }
            const out = await applyImageWatermark(ctx, input);
            if (input.case_id && out.status === "not_configured") {
              await persistCaseContextPatch(ctx, input.case_id, {
                watermark_configured: false,
              });
              // No brand watermark → skip without failing the publication tick.
              await updateToolCallStatus(ctx.db, record.id, "executed", out);
              return JSON.stringify({ ...out, ok: true, skipped: true });
            }
            if (input.case_id && Array.isArray(out.outputs)) {
              const persisted = await persistWatermarkedPhotosToCase(
                ctx,
                input.case_id,
                out
              );
              if (!persisted) {
                const failOut = {
                  ...out,
                  ok: false,
                  status: "watermark_persist_failed",
                  hint:
                    "Las imágenes se marcaron en storage pero no se pudo persistir photo_manifest.watermarked_path. Reintenta image_watermark(case_id).",
                };
                await updateToolCallStatus(ctx.db, record.id, "failed", failOut);
                return JSON.stringify(failOut);
              }
            }
            const toolFailed =
              out.ok === false ||
              (typeof out.status === "string" &&
                (out.status === "partial_failure" ||
                  out.status === "failed" ||
                  out.status === "not_configured"));
            await updateToolCallStatus(
              ctx.db,
              record.id,
              toolFailed ? "failed" : "executed",
              out
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
            case_id: z.string().min(1).optional(),
          }),
        }
      )
    );
  }

  // ── Ungga publish — prepare_draft (HITL) + publish_draft (post-aprobación) ─
  if (toolEnabled("ungga_publish_listing", ctx)) {
    // Canonical model surface: action + case_id (+ GU-ID fields for publish).
    // .passthrough() keeps programmatic/tool-readiness extras; adapter owns
    // listing fields + image_urls from case context (never trust model URLs).
    const unggaPublishSchema = z.preprocess(
      stripEmptyAndNullishProps,
      z
        .object({
          case_id: z
            .string()
            .min(1)
            .describe(
              "Operational property_optioning case_id (required). Adapter enriches listing fields and photo_manifest.public_url from the case."
            ),
          action: nullableOptional(z.enum(["prepare_draft", "publish_draft"]))
            .transform((value) => value ?? "prepare_draft")
            .describe(
              "prepare_draft: wizard + save draft. publish_draft: publish an approved draft by GU-ID. Prefer only this + case_id."
            ),
          ungga_property_id: nullableOptional(z.string().min(1)).describe(
            "Required for publish_draft when draft_url is absent."
          ),
          draft_url: nullableOptional(z.string().url()).describe(
            "Optional publish_draft shortcut: /app/propiedades/{GU-ID}."
          ),
        })
        .passthrough()
        .superRefine((data, refineCtx) => {
          const action =
            typeof data.action === "string" && data.action.trim()
              ? data.action.trim()
              : "prepare_draft";
          if (action === "publish_draft") {
            if (!resolveUnggaPropertyId(data)) {
              refineCtx.addIssue({
                code: z.ZodIssueCode.custom,
                message:
                  "publish_draft requires ungga_property_id or draft_url pointing to /app/propiedades/{GU-ID}",
                path: ["ungga_property_id"],
              });
            }
          }
        })
    );

    tools.push(
      tool(
        async (input: Record<string, unknown>) => {
          const record = await createTrackedToolCall(ctx, "ungga_publish_listing",
            input,
            false);
          const caseId =
            typeof input.case_id === "string" && input.case_id.trim()
              ? input.case_id.trim()
              : ctx.caseId ?? null;
          if (!caseId) {
            const out = {
              ok: false,
              status: "case_id_required",
              hint:
                "ungga_publish_listing requiere case_id para validar el gate de publicación.",
            };
            await updateToolCallStatus(ctx.db, record.id, "failed", out);
            return JSON.stringify(out);
          }
          // Drop model-supplied image_urls before enrichment — photo_manifest wins.
          const { image_urls: _discardImageUrls, ...inputWithoutModelUrls } =
            input;
          void _discardImageUrls;
          let inputForExecution = await enrichUnggaPublishInputFromCaseContext(
            ctx,
            { ...inputWithoutModelUrls, case_id: caseId }
          );
          const action =
            typeof inputForExecution.action === "string" &&
            inputForExecution.action.trim()
              ? inputForExecution.action.trim()
              : "prepare_draft";

          if (action === "publish_draft") {
            const publishPropertyId = resolveUnggaPropertyId(
              inputForExecution as { ungga_property_id?: string; draft_url?: string }
            );
            if (!publishPropertyId) {
              const out = {
                ok: false,
                status: "validation_error",
                error:
                  "publish_draft requires ungga_property_id or draft_url from a prior prepare_draft",
              };
              await updateToolCallStatus(ctx.db, record.id, "failed", out);
              return JSON.stringify(out);
            }
            if (caseId) {
              const phaseGate = await enforceUnggaPublishPhaseGate(
                ctx,
                caseId,
                publishPropertyId
              );
              if (!phaseGate.ok) {
                await updateToolCallStatus(ctx.db, record.id, "failed", phaseGate);
                return JSON.stringify(phaseGate);
              }
            }
          } else {
            const missing: string[] = [];
            if (
              typeof inputForExecution.title !== "string" ||
              !inputForExecution.title.trim()
            ) {
              missing.push("title");
            }
            if (
              typeof inputForExecution.operation !== "string" ||
              !inputForExecution.operation.trim()
            ) {
              missing.push("operation");
            }
            if (
              typeof inputForExecution.property_type !== "string" ||
              !inputForExecution.property_type.trim()
            ) {
              missing.push("property_type");
            }
            if (
              typeof inputForExecution.price !== "number" ||
              !(inputForExecution.price > 0)
            ) {
              missing.push("price");
            }
            if (missing.length > 0) {
              const out = {
                ok: false,
                status: "validation_error",
                error: `prepare_draft missing required fields after case enrichment: ${missing.join(", ")}`,
                missing_fields: missing,
                hint: "Pasa case_id con listing_description_approved y pricing_proposal, o suministra title/operation/property_type/price.",
              };
              await updateToolCallStatus(ctx.db, record.id, "failed", out);
              return JSON.stringify(out);
            }
            const imageUrls = Array.isArray(inputForExecution.image_urls)
              ? inputForExecution.image_urls.filter(
                  (url) => typeof url === "string" && url.trim().length > 0
                )
              : [];
            if (caseId && imageUrls.length === 0) {
              const opCaseForImages = await getOperationalCase(ctx.db, caseId).catch(
                () => null
              );
              const ctxImages = asRecord(opCaseForImages?.context_jsonb) ?? {};
              const manifest = Array.isArray(ctxImages.photo_manifest)
                ? ctxImages.photo_manifest
                : [];
              const rawPhotos = Array.isArray(ctxImages.raw_photos)
                ? ctxImages.raw_photos
                : [];
              if (manifest.length > 0 || rawPhotos.length > 0) {
                const out = {
                  ok: false,
                  status: "validation_error",
                  error:
                    "prepare_draft requires image_urls from photo_manifest.public_url when the case has photos; refusing empty image_urls",
                  expected_image_count: manifest.length || rawPhotos.length,
                  hint: "Ejecuta image_watermark(case_id) / easybroker_upload_images primero para persistir public_url en photo_manifest; el adapter no acepta image_urls del modelo.",
                };
                await updateToolCallStatus(ctx.db, record.id, "failed", out);
                return JSON.stringify(out);
              }
            }
          }

          const gate = await enforcePublishGateForCase({
            ctx,
            caseId,
            destination: "ungga",
            operationType:
              input.action === "publish_draft" ? "publish" : "create_draft",
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
                creation_source: "cli",
              });
            } else {
              await persistPublishedDestination(ctx, caseId, "ungga", {
                ungga_property_id:
                  typeof out.ungga_property_id === "string"
                    ? out.ungga_property_id
                    : null,
                draft_url:
                  typeof out.draft_url === "string" ? out.draft_url : null,
                status: "draft",
                creation_source: "cli",
                // Persistido para que el preflight pueda escalar a
                // publication_review_required cuando distance_m es grande.
                ...(asRecord(out.location_accuracy_warning)
                  ? {
                      location_accuracy_warning: asRecord(
                        out.location_accuracy_warning
                      ),
                    }
                  : {}),
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
                ...(asRecord(out.location_accuracy_warning)
                  ? {
                      location_accuracy_warning: asRecord(
                        out.location_accuracy_warning
                      ),
                    }
                  : {}),
              },
            });
          }
          return JSON.stringify(out);
        },
        {
          name: "ungga_publish_listing",
          description:
            "Ungga listing in two phases: prepare_draft then publish_draft. Call with case_id + action only; the adapter enriches title/price/commission/image_urls from the case (do not invent or copy image_urls). publish_draft also needs ungga_property_id or draft_url. Omit empty strings.",
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
        const apiImageCount = Array.isArray(input.image_urls)
          ? input.image_urls.filter(
              (u) => typeof u === "string" && u.trim().length > 0
            ).length
          : 0;
        out.expected_image_count = apiImageCount;
        out.uploaded_image_count = apiImageCount;
        out.image_count = apiImageCount;
        // Internal Ungga API accepts image_urls in the create payload; treat
        // accepted create as submitted+verified evidence for the runner.
        out.images_submitted = apiImageCount > 0;
        out.images_verified = apiImageCount > 0;
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

/**
 * Remediación owned cuando generate falla por datos contractuales faltantes:
 * el sistema (no el LLM) emite `contract_data_review` con los campos exactos.
 * Deduplica por conjunto ordenado de faltantes y refresca el unread existente.
 */
async function emitOwnedContractDataReviewIfNeeded(
  ctx: ToolContext,
  deps: RealEstateToolDeps,
  params: {
    caseId: string;
    missingRequiredFields?: string[];
  }
): Promise<{
  sent: boolean;
  skipped?: boolean;
  reason?: string;
  error?: string;
}> {
  if (!deps.notifyUser) {
    return { sent: false, skipped: true, reason: "notify_user_unavailable" };
  }

  const opCase = await getOperationalCase(ctx.db, params.caseId).catch(() => null);
  if (!opCase) {
    return { sent: false, skipped: true, reason: "case_not_found" };
  }
  const context = isRecord(opCase.context_jsonb) ? opCase.context_jsonb : {};
  const propertyData = isRecord(context.property_data)
    ? context.property_data
    : {};
  const externalContact = isRecord(opCase.external_contact_jsonb)
    ? (opCase.external_contact_jsonb as Record<string, unknown>)
    : {};

  const commercial = evaluateContractCommercialMinimums({
    context,
    propertyData,
    externalContact,
    requireConfirmation: true,
  });
  const requiredMissing = commercial.missing.filter(
    (item) => item.optional !== true
  );
  // Merge template-only missing keys (e.g. owner_name) that are outside commercial model.
  const templateMissing = (params.missingRequiredFields ?? [])
    .map((field) => (typeof field === "string" ? field.trim() : ""))
    .filter((field) => field.length > 0)
    .filter(
      (field) =>
        !requiredMissing.some((item) => item.key === field) &&
        !(field === "owner_email" && commercial.owner_email)
    );
  const missingKeys = [
    ...requiredMissing.map((item) => item.key),
    ...templateMissing,
  ];
  if (missingKeys.length === 0 && commercial.ok) {
    return { sent: false, skipped: true, reason: "no_missing_fields" };
  }

  const orderedKeySet = missingKeys.slice().sort().join(",");
  const recentEvents = await getRecentOperationalCaseEvents(
    ctx.db,
    params.caseId,
    20
  );
  const alreadyRequestedSameSet = recentEvents.some((event) => {
    const payload =
      event.payload_jsonb &&
      typeof event.payload_jsonb === "object" &&
      !Array.isArray(event.payload_jsonb)
        ? (event.payload_jsonb as Record<string, unknown>)
        : null;
    if (payload?.kind !== "contract_data_review_requested") return false;
    const prior = Array.isArray(payload.missing_required_fields)
      ? payload.missing_required_fields
          .filter((field): field is string => typeof field === "string")
          .slice()
          .sort()
          .join(",")
      : "";
    return prior === orderedKeySet;
  });
  // Still refresh body/metadata via upsert even if same set was requested;
  // skip only a parallel email-only duplicate when nothing commercial remains.
  if (
    alreadyRequestedSameSet &&
    requiredMissing.length === 0 &&
    templateMissing.length === 1 &&
    templateMissing[0] === "owner_email" &&
    commercial.owner_email
  ) {
    return { sent: false, skipped: true, reason: "already_requested" };
  }

  const notifyText =
    requiredMissing.length > 0 || commercial.known.length > 0
      ? buildContractCommercialMinimumsSummaryMessage(commercial)
      : buildContractDataReviewNotifyText(missingKeys);

  try {
    await deps.notifyUser(
      ctx.db,
      ctx.userId,
      {
        text: notifyText,
        kind: "contract_data_review",
        data: {
          case_id: params.caseId,
          missing_required_fields: missingKeys,
          missing_fields: commercial.missing,
          known_fields: commercial.known,
          source: "generate_document_from_template",
        },
      },
      "high"
    );
    if (!alreadyRequestedSameSet) {
      await insertOperationalCaseEvent(ctx.db, {
        caseId: params.caseId,
        eventType: "human_decision",
        actor: "system",
        stepKey: "contract_pending",
        payload: {
          kind: "contract_data_review_requested",
          source: "generate_document_from_template",
          missing_required_fields: missingKeys,
        },
      });
    }
    return { sent: true };
  } catch (e) {
    return {
      sent: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
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

  // Managed publication (workflow v1, default) owns Telegram closure via
  // listing_published_summary. Draft/publish pings are redundant and noisy.
  if (caseId) {
    const opCase = await getOperationalCase(ctx.db, caseId).catch(() => null);
    const context = asRecord(opCase?.context_jsonb) ?? {};
    if (context.publication_workflow_v1 !== false) return;
  }

  let text: string | null = null;
  if (action === "prepare_draft") {
    const draftUrl =
      typeof out.draft_url === "string" ? out.draft_url.trim() : "";
    // Legacy path only: publication_workflow_v1 === false keeps human draft review.
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
    timezone: ctx.userTimezone ?? "America/Mexico_City",
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

  // Preventive commercial preflight (before template-field checks).
  if (input.template_slug === "commission_contract") {
    const caseId = input.case_id ?? ctx.caseId;
    if (caseId) {
      const oc = await getOperationalCase(ctx.db, caseId).catch(() => null);
      if (oc) {
        const context = isRecord(oc.context_jsonb) ? oc.context_jsonb : {};
        const propertyData = isRecord(context.property_data)
          ? context.property_data
          : {};
        const externalContact = isRecord(oc.external_contact_jsonb)
          ? (oc.external_contact_jsonb as Record<string, unknown>)
          : {};
        const commercial = evaluateContractCommercialMinimums({
          context,
          propertyData,
          externalContact,
          requireConfirmation: true,
        });
        const requiredMissing = commercial.missing.filter(
          (item) => item.optional !== true
        );
        if (!commercial.ok || requiredMissing.length > 0) {
          return {
            ok: false,
            status: "blocked",
            error: "commission_contract_missing_required_data",
            message:
              "Faltan condiciones comerciales o datos del comitente para generar el contrato.",
            missing_required_fields: requiredMissing.map((item) => item.key),
            missing_fields: commercial.missing,
            known_fields: commercial.known,
            commercial_summary:
              buildContractCommercialMinimumsSummaryMessage(commercial),
            hint:
              "Completa commission_terms / owner_email vía contract_data_review antes de regenerar. No uses notify_user(kind=contract_review) hasta tener output_path.",
          };
        }
      }
    }
  }

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
          "Completa los campos faltantes en el caso (por ejemplo owner_email del comitente). El sistema solicitará contract_data_review automáticamente; no uses notify_user(kind=contract_review) hasta regenerar con output_path.",
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

export type CommissionContractRenderResult =
  | {
      kind: "rendered";
      outputBucket: string;
      outputPath: string;
      templateSlug: string;
    }
  | { kind: "titularidad_review_required"; detail?: string }
  | { kind: "owner_corroboration_incomplete"; documentIds: string[] }
  | { kind: "missing_required_data"; missingRequiredFields: string[] }
  | { kind: "template_missing"; hint?: string }
  | { kind: "infrastructure_error"; error: string }
  | { kind: "failed"; error: string };

/**
 * Render programático del contrato de comisión para remediación determinista
 * post-agente (PATTERN_DETERMINISTIC_AUTO_REMEDIATION_WITH_CIRCUIT_BREAKER).
 *
 * Reutiliza EXACTAMENTE los mismos gates (titularidad/corroboración), el core
 * de render y la persistencia de `contract_draft` que el wrapper de la tool
 * `generate_document_from_template`, de modo que laboratorio y producción
 * comparten una sola ruta de código. El caller (cron / tick E2E) es dueño de
 * las notificaciones; esta función NO hace side-effects de notify.
 */
export async function renderCommissionContractForCase(
  ctx: ToolContext,
  params: { caseId: string }
): Promise<CommissionContractRenderResult> {
  const caseId = params.caseId?.trim();
  if (!caseId) return { kind: "failed", error: "missing_case_id" };

  // Gate de titularidad — misma fuente de verdad que el wrapper de la tool.
  const gateCase = await getOperationalCase(ctx.db, caseId).catch(() => null);
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
    const corroborationBlock = titularidadGate.blocks.find(
      (block) => block.reason === "owner_corroboration_extraction_pending"
    );
    if (corroborationBlock) {
      return {
        kind: "owner_corroboration_incomplete",
        documentIds: corroborationBlock.remediation.document_ids ?? [],
      };
    }
    const titularidadBlock = titularidadGate.blocks.find(
      (block) => block.reason === "titularidad_unverified"
    );
    if (titularidadBlock) {
      const titularidadFields = documentExtractionMinimumsContext(gateDocuments);
      return {
        kind: "titularidad_review_required",
        detail:
          typeof titularidadFields.owner_consistency_note === "string"
            ? titularidadFields.owner_consistency_note
            : undefined,
      };
    }
  }

  let out: Record<string, unknown>;
  try {
    out = await renderDocumentFromTemplate(ctx, {
      template_slug: "commission_contract",
      format: "docx",
      data: {},
      case_id: caseId,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return /502|503|504|cloudflare|bad gateway/i.test(message)
      ? { kind: "infrastructure_error", error: message }
      : { kind: "failed", error: message };
  }

  if (
    out.ok === true &&
    out.status === "rendered" &&
    typeof out.output_path === "string" &&
    out.output_path.trim()
  ) {
    // Persistencia idéntica a la del wrapper, pero con actor=system porque el
    // render lo dispara el runtime, no el modelo.
    let persisted = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const opCase = await getOperationalCase(ctx.db, caseId);
      if (!opCase) break;
      const baseContext = isRecord(opCase.context_jsonb)
        ? opCase.context_jsonb
        : {};
      const updated = await updateOperationalCase(ctx.db, caseId, opCase.version, {
        context: {
          ...baseContext,
          contract_draft: {
            ...(isRecord(baseContext.contract_draft)
              ? baseContext.contract_draft
              : {}),
            template_slug: out.template_slug,
            output_bucket: out.output_bucket,
            output_path: out.output_path,
            generated_at: new Date().toISOString(),
          },
        },
      });
      if (updated) {
        persisted = true;
        break;
      }
    }
    if (!persisted) {
      return {
        kind: "failed",
        error: "contract_draft_persist_conflict",
      };
    }
    await insertOperationalCaseEvent(ctx.db, {
      caseId,
      eventType: "state_changed",
      actor: "system",
      payload: {
        tool: "generate_document_from_template",
        source: "deterministic_post_agent",
        output_bucket: out.output_bucket,
        output_path: out.output_path,
        template_asset_key: out.template_asset_key,
        format: out.format,
      },
    });
    return {
      kind: "rendered",
      outputBucket: String(out.output_bucket ?? ""),
      outputPath: String(out.output_path),
      templateSlug: String(out.template_slug ?? "commission_contract"),
    };
  }

  if (
    out.ok === false &&
    out.error === "commission_contract_missing_required_data"
  ) {
    const missing = Array.isArray(out.missing_required_fields)
      ? out.missing_required_fields.filter(
          (field): field is string =>
            typeof field === "string" && field.trim().length > 0
        )
      : [];
    return { kind: "missing_required_data", missingRequiredFields: missing };
  }

  if (out.ok === false && out.status === "not_configured") {
    return {
      kind: "template_missing",
      hint: typeof out.hint === "string" ? out.hint : undefined,
    };
  }

  return {
    kind: "failed",
    error: typeof out.error === "string" ? out.error : "render_failed",
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
  image_paths?: string[];
  purpose?: string;
  case_id?: string;
};

/**
 * Normaliza `raw_photos` (strings u objetos de caso) a refs `bucket:path`.
 * Misma semántica que la recipe N1 de laboratorio.
 */
export function resolveImagePathsFromRawPhotos(
  rawPhotos: unknown,
  maxCount = Number.POSITIVE_INFINITY
): string[] {
  if (!Array.isArray(rawPhotos)) return [];
  const paths: string[] = [];
  for (const item of rawPhotos) {
    if (typeof item === "string") {
      const normalized = normalizeAnalyzeImageStorageRef(item);
      if (normalized) paths.push(normalized);
    } else if (asRecord(item)) {
      const record = asRecord(item)!;
      const bucket =
        typeof record.storage_bucket === "string"
          ? record.storage_bucket.trim()
          : "";
      const storagePath =
        typeof record.storage_path === "string"
          ? record.storage_path.trim()
          : "";
      if (bucket && storagePath) {
        paths.push(`${bucket}:${storagePath.replace(/^\/+/, "")}`);
      } else if (storagePath) {
        const normalized = normalizeAnalyzeImageStorageRef(storagePath);
        if (normalized) paths.push(normalized);
      }
    }
    if (paths.length >= maxCount) break;
  }
  return paths;
}

/**
 * El agente a menudo pasa solo `storage_path` sin bucket. Esas rutas viven en
 * `case-documents`, no en el default de watermark (`account-assets`).
 */
export function normalizeAnalyzeImageStorageRef(inputPath: string): string {
  const trimmed = inputPath.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^[a-z0-9._-]+:/i.test(trimmed)) return trimmed;
  return `case-documents:${trimmed.replace(/^\/+/, "")}`;
}

async function resolveAnalyzePropertyImagePaths(
  ctx: ToolContext,
  input: AnalyzePropertyImagesInput
): Promise<{ paths: string[]; source: "args" | "case_raw_photos" | "none" }> {
  const caseId =
    (typeof input.case_id === "string" && input.case_id.trim()) ||
    (typeof ctx.caseId === "string" && ctx.caseId.trim()) ||
    "";
  // Preferir raw_photos del caso: son canónicos con bucket. Los image_paths del
  // agente suelen venir sin prefijo bucket y fallan al descargar.
  if (caseId) {
    const opCase = await getOperationalCase(ctx.db, caseId).catch(() => null);
    if (opCase && opCase.user_id === ctx.userId) {
      const context = asRecord(opCase.context_jsonb) ?? {};
      const fromCase = resolveImagePathsFromRawPhotos(context.raw_photos);
      if (fromCase.length > 0) {
        return { paths: fromCase, source: "case_raw_photos" };
      }
    }
  }
  const fromArgs = Array.isArray(input.image_paths)
    ? input.image_paths
        .map((path) =>
          typeof path === "string" ? normalizeAnalyzeImageStorageRef(path) : ""
        )
        .filter((path) => path.length > 0)
    : [];
  if (fromArgs.length > 0) {
    return { paths: fromArgs, source: "args" };
  }
  return { paths: [], source: "none" };
}

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
    "string[] — frases cortas (máx 12 palabras) derivadas solo de evidencia visible; NUNCA muebles, decoración ni electrodomésticos portátiles (esas observaciones van a do_not_claim)",
  quality_notes: "string[]",
  uncertain_observations: "string[]",
  do_not_claim:
    "string[] — afirmaciones a evitar en copy; incluye muebles/decoración/electrodomésticos portátiles visibles (las fotos no prueban que se incluyan en venta o renta) y cualquier detalle no verificable",
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

export function buildPhotoAnalysisOutput(
  parsed: Record<string, unknown>,
  manifest: PhotoManifestEntry[],
  imageCount: number,
  loadErrors: Array<{ path: string; error: string }> = []
) {
  const featuresBySpace = parseFeaturesBySpace(parsed.features_by_space);
  const legacyFlat = ensureStringArray(parsed.visible_features, 24);
  const visibleFeatures =
    Object.keys(featuresBySpace).length > 0
      ? flattenFeaturesBySpace(featuresBySpace)
      : legacyFlat;

  return {
    ok: loadErrors.length === 0,
    status: loadErrors.length === 0 ? "analyzed" : "partial_failure",
    model: IMAGE_VISION_MODEL_ID,
    image_count: imageCount,
    total_photo_count: manifest.length,
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
    source_paths: manifest.map((entry) => entry.source_path),
    images: manifest,
    photo_manifest: manifest,
    missing: loadErrors.map((item) => item.path),
    load_errors: loadErrors,
  };
}

const PHOTO_CLASSIFIER_CONCURRENCY = 3;
const PHOTO_CLASSIFIER_MAX_TOKENS = 180;

type LoadedPhoto = {
  sourcePath: string;
  sha256: string;
  dataUrl: string;
};

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor++;
        results[index] = await mapper(values[index]);
      }
    })
  );
  return results;
}

async function classifyLoadedPhoto(photo: LoadedPhoto): Promise<{
  source_path: string;
  sha256: string;
  space_label: string | null;
  confidence: number | null;
  uncertain: boolean;
  error: PhotoManifestEntry["error"];
}> {
  try {
    const parsed = asRecord(
      await callOpenRouterJsonTool({
        model: IMAGE_VISION_MODEL_ID,
        maxTokens: PHOTO_CLASSIFIER_MAX_TOKENS,
        temperature: 0,
        messages: [
          {
            role: "system",
            content:
              "Clasifica una sola foto inmobiliaria. Devuelve JSON sin markdown: " +
              '{"space_label":"etiqueta breve en español","confidence":0.0,"uncertain":false}.',
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  "Identifica únicamente el espacio principal visible. Si no es claro, usa space_label null y uncertain true.",
              },
              { type: "image_url", image_url: { url: photo.dataUrl } },
            ],
          },
        ],
      })
    );
    const label =
      typeof parsed?.space_label === "string"
        ? parsed.space_label.trim() || null
        : null;
    const confidence =
      typeof parsed?.confidence === "number" ? parsed.confidence : null;
    return {
      source_path: photo.sourcePath,
      sha256: photo.sha256,
      space_label: label,
      confidence,
      uncertain:
        parsed?.uncertain === true ||
        !label ||
        confidence == null ||
        confidence < 0.7,
      error: null,
    };
  } catch (error) {
    return {
      source_path: photo.sourcePath,
      sha256: photo.sha256,
      space_label: null,
      confidence: null,
      uncertain: true,
      error: {
        code: "classification_failed",
        message: error instanceof Error ? error.message : String(error),
        stage: "classify",
      },
    };
  }
}

/** Exported for selftests — policy for visual analysis vs commercial claims. */
export function analyzePropertyImagesSystemPrompt() {
  return (
    "Eres analista visual de inmobiliaria en México/LATAM. Devuelve JSON válido sin markdown. " +
    "Reglas estrictas: (1) ausencia visual NO implica ausencia real; " +
    "(2) nunca afirmes que la propiedad no tiene algo solo porque no se ve en fotos; " +
    "(3) cada característica va en features_by_space SOLO bajo el espacio donde se observa con claridad — " +
    "no mezcles detalles de fachada/exterior bajo espacios interiores ni viceversa; " +
    "(4) copy_safe_phrases y style_tags deben ser conservadores y basados solo en evidencia visible; " +
    "(5) política anti-mobiliario movible (venta y renta): muebles, decoración y electrodomésticos " +
    "portátiles observados (sofás, mesas, sillas, camas, refrigerador, microondas, TV, lámparas, etc.) " +
    "van a do_not_claim, NUNCA a copy_safe_phrases — las fotos nunca prueban que se incluyan en la " +
    "operación de venta o renta; (6) elementos fijos verificables (cocina integral, clósets empotrados, " +
    "canceles, aire acondicionado instalado, pisos, cancelería) sí pueden ir a features_by_space / " +
    "copy_safe_phrases si se ven con claridad."
  );
}

/** Exported for selftests — commercial draft factuality rules. */
export function prepareListingDescriptionDraftSystemPrompt() {
  return (
    "Eres copywriter inmobiliario LATAM. Devuelve JSON válido sin markdown. " +
    "No inventes amenidades ni cercanías; usa solo ingredientes provistos. " +
    "Prioriza features_by_space para describir cada área con sus detalles visibles; " +
    "no mezcles características de espacios distintos. " +
    "Usa copy_safe_phrases cuando encajen. Respeta do_not_claim y photo_coverage. " +
    "Política anti-mobiliario movible (venta y renta por igual): no menciones muebles, " +
    "decoración ni electrodomésticos portátiles salvo confirmación explícita en property_data, " +
    "advisor_highlights, listing_copy_instructions o revision_feedback/feedback humano " +
    "(p. ej. «se renta amueblada», «incluye refrigerador»). " +
    "Sí puedes mencionar elementos fijos verificables (cocina integral, clósets empotrados, " +
    "canceles, aire acondicionado instalado, etc.) si aparecen en los ingredientes. " +
    "La descripción, el título y el resumen son copy comercial para el cliente: nunca menciones fotos, imágenes, cobertura visual, elementos no visibles ni limitaciones del análisis. " +
    "No incluyas precio, moneda, comisión, mantenimiento, disponibilidad, vigencia ni estado de publicación; son campos estructurados mutables del listing y no pertenecen al copy. " +
    "Si un dato está verificado en property_data (por ejemplo, cajones de estacionamiento), úsalo sin comentar si aparece o no en las fotos. " +
    "Los faltantes deben ir exclusivamente en missing_ingredients y nunca dentro de headline, short_description o description. " +
    "Menciona escuelas, transporte, hospitales o parques por nombre solo si aparecen en zone_context.points_of_interest. " +
    "Si revision_feedback trae replacement_text, úsalo como base y luego ajusta solo para mantener factualidad y claridad."
  );
}

/**
 * Pure policy helper: photos alone never justify movable furniture/equipment claims
 * for sale or rent. Explicit advisor confirmation unlocks those claims.
 */
export function allowsMovableItemCommercialClaim(input: {
  operationType?: string | null;
  photoShowsMovableItems?: boolean;
  explicitConfirmationText?: string | null;
}): { allowed: boolean; reason: string } {
  const confirmation = (input.explicitConfirmationText ?? "").trim();
  const hasExplicit =
    /\b(amueblad[oa]s?|semi[\s-]?amueblad[oa]s?|incluye\b|con\s+muebles|equipad[oa]s?)\b/i.test(
      confirmation
    );
  if (hasExplicit) {
    return {
      allowed: true,
      reason: "explicit_confirmation",
    };
  }
  const op = (input.operationType ?? "").toLowerCase();
  const isSaleOrRent =
    /venta|sale|renta|rent|lease|alquiler/.test(op) || op.length === 0;
  if (input.photoShowsMovableItems && isSaleOrRent) {
    return {
      allowed: false,
      reason: "photos_do_not_prove_inclusion_sale_or_rent",
    };
  }
  return {
    allowed: false,
    reason: "no_explicit_confirmation",
  };
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
      const resolved = await resolveAnalyzePropertyImagePaths(ctx, input);
      if (resolved.paths.length === 0) {
        const out = {
          ok: false,
          status: "missing_image_paths",
          hint:
            "Pasa image_paths (refs bucket:path) o case_id de un caso con context_jsonb.raw_photos (>=1 foto).",
        };
        await updateToolCallStatus(ctx.db, record.id, "failed", out);
        return JSON.stringify(out);
      }
      const caseId = input.case_id ?? ctx.caseId ?? null;
      const opCase = caseId
        ? await getOperationalCase(ctx.db, caseId).catch(() => null)
        : null;
      const existingManifest = parsePhotoManifest(
        asRecord(opCase?.context_jsonb)?.photo_manifest
      );
      let manifest = buildPhotoManifestFromRawPhotos(
        resolved.paths,
        existingManifest
      );
      const loadedResults = await mapWithConcurrency(
        resolved.paths,
        PHOTO_CLASSIFIER_CONCURRENCY,
        async (
          imagePath
        ): Promise<LoadedPhoto | { sourcePath: string; loadError: string }> => {
          try {
            const loaded = await loadImageInput(ctx, imagePath);
            const sha256 = createHash("sha256").update(loaded.buffer).digest("hex");
            const normalized = await sharp(loaded.buffer, { failOn: "none" })
              .rotate()
              .resize({ width: 1400, withoutEnlargement: true })
              .jpeg({ quality: 80 })
              .toBuffer();
            return {
              sourcePath: imagePath,
              sha256,
              dataUrl: `data:image/jpeg;base64,${normalized.toString("base64")}`,
            };
          } catch (err) {
            return {
              sourcePath: imagePath,
              loadError: err instanceof Error ? err.message : String(err),
            };
          }
        }
      );
      const loadedPhotos = loadedResults.filter(
        (item): item is LoadedPhoto => "dataUrl" in item
      );
      const loadErrors = loadedResults.flatMap((item) =>
        "loadError" in item
          ? [{ path: item.sourcePath, error: item.loadError }]
          : []
      );
      const loadFailureLabels = loadErrors.map((item) => ({
        source_path: item.path,
        space_label: null,
        confidence: null,
        uncertain: true,
        error: {
          code: "image_load_failed",
          message: item.error,
          stage: "load" as const,
        },
      }));
      const classifications = await mapWithConcurrency(
        loadedPhotos,
        PHOTO_CLASSIFIER_CONCURRENCY,
        classifyLoadedPhoto
      );
      manifest = mergePhotoLabelsIntoManifest(manifest, [
        ...classifications,
        ...loadFailureLabels,
      ]);

      // Persist identity/classification before aggregate copy analysis so a
      // later model failure never discards hashes or shifts photo labels.
      if (caseId) {
        await persistCaseContextPatch(ctx, caseId, {
          photo_manifest: manifest,
        });
      }

      if (loadedPhotos.length === 0) {
        const out = buildPhotoAnalysisOutput({}, manifest, 0, loadErrors);
        if (caseId) {
          await persistCaseContextPatch(ctx, caseId, { photo_analysis: out });
        }
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
                ...loadedPhotos.map((photo) => ({
                  type: "image_url",
                  image_url: { url: photo.dataUrl },
                })),
              ],
            },
          ],
        });
        const out = buildPhotoAnalysisOutput(
          asRecord(parsed) ?? {},
          manifest,
          loadedPhotos.length,
          loadErrors
        );
        if (caseId) {
          await persistCaseContextPatch(
            ctx,
            caseId,
            {
              photo_analysis: out,
              photo_manifest: out.photo_manifest,
            },
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
          ...buildPhotoAnalysisOutput({}, manifest, loadedPhotos.length, loadErrors),
          ok: false,
          status: "aggregate_analysis_failed",
          error: err instanceof Error ? err.message : String(err),
        };
        if (caseId) {
          await persistCaseContextPatch(ctx, caseId, {
            photo_analysis: out,
            photo_manifest: manifest,
          });
        }
        await updateToolCallStatus(ctx.db, record.id, "failed", out);
        return JSON.stringify(out);
      }
    },
    {
      name: "analyze_property_images",
      description:
        "Analyzes property images and returns structured visual evidence for listing copy (never infers absent features from missing photos). Prefer case_id alone when the case already has raw_photos; image_paths must use bucket:path refs (e.g. case-documents:user/case/photo.jpg).",
      schema: z.object({
        image_paths: z.array(z.string().min(1)).min(1).optional(),
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
  if (isUsableLatLng(lat, lon)) {
    return {
      coordinates: {
        latitude: lat as number,
        longitude: lon as number,
        source: "input" as const,
      },
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

  const caseLat = safeNumber(
    caseAddress.latitude ?? propertyData.latitude ?? propertyData.lat
  );
  const caseLon = safeNumber(
    caseAddress.longitude ??
      propertyData.longitude ??
      propertyData.lng ??
      propertyData.lon
  );
  if (isUsableLatLng(caseLat, caseLon)) {
    return {
      coordinates: {
        latitude: caseLat as number,
        longitude: caseLon as number,
        source: "case_context" as const,
      },
    };
  }

  if (hasExplicitAddressInput(input)) {
    const geocodeInputFromInput = {
      street: typeof input.address === "string" ? input.address.trim() : undefined,
      neighborhood:
        typeof input.neighborhood === "string" ? input.neighborhood.trim() : undefined,
      municipality:
        typeof input.municipality === "string" ? input.municipality.trim() : undefined,
      state: typeof input.state === "string" ? input.state.trim() : undefined,
      country: (typeof input.country === "string" && input.country.trim()) || "MX",
    };
    const geocodedFromInput = await geocodePropertyAddress(geocodeInputFromInput);
    if (
      geocodedFromInput.ok &&
      geocodedFromInput.status === "ok" &&
      typeof geocodedFromInput.latitude === "number" &&
      typeof geocodedFromInput.longitude === "number"
    ) {
      // Persistimos la coordenada canónica en property_data.address para que
      // futuros ticks/consumidores (Avaclick, publicación, este mismo resolver)
      // no re-geocodifiquen. El candado de confianza + alineación evita
      // envenenar la dirección canónica con un match dudoso.
      await maybePersistSurroundingsGeocode(ctx, geocodeInputFromInput, geocodedFromInput);
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
    const geocodeInputFromCase = {
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
    };
    const geocodedFromCase = await geocodePropertyAddress(geocodeInputFromCase);
    if (
      geocodedFromCase.ok &&
      geocodedFromCase.status === "ok" &&
      typeof geocodedFromCase.latitude === "number" &&
      typeof geocodedFromCase.longitude === "number"
    ) {
      await maybePersistSurroundingsGeocode(ctx, geocodeInputFromCase, geocodedFromCase);
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

/**
 * Persiste en `property_data.address` la coordenada resuelta internamente por
 * `lookup_property_surroundings`, reutilizando el mismo candado que el tool
 * `geocode_property_address`: solo `confidence === "high"` y la alineación de
 * dirección (dentro de `persistGeocodeResultToCaseContext`) evitan sobrescribir
 * la ubicación canónica con un match dudoso. Best-effort: cualquier fallo se
 * traga porque el surroundings ya tiene coordenadas para continuar.
 */
async function maybePersistSurroundingsGeocode(
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
  geocoded: Awaited<ReturnType<typeof geocodePropertyAddress>>
): Promise<void> {
  if (!ctx.caseId) return;
  if (!geocoded.ok || geocoded.status !== "ok") return;
  if (geocoded.confidence !== "high") return;
  if (!isUsableLatLng(geocoded.latitude, geocoded.longitude)) return;
  try {
    await persistGeocodeResultToCaseContext(ctx, requestInput, {
      latitude: geocoded.latitude,
      longitude: geocoded.longitude,
      formatted_address: geocoded.formatted_address,
      provider: geocoded.provider,
      confidence: geocoded.confidence,
      candidates: geocoded.candidates,
    });
  } catch (err) {
    console.warn(
      "[realestate] lookup_property_surroundings: persist canonical geocode failed:",
      err
    );
  }
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
      // Defensa en profundidad: nunca persistir zone_context con coordenadas
      // no usables (Null Island / 0,0). Antes del fix de isUsableLatLng un
      // input=0,0 llegaba hasta aquí y dejaba un zone_context envenenado que
      // luego se reusaba como fallback.
      if (caseId && isUsableLatLng(coordinates.latitude, coordinates.longitude)) {
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
        "Builds surroundings context (POIs + area summary) around a property. Prefer case_id so coordinates come from prior geocode in the case. Do NOT pass latitude/longitude=0 as placeholders; omit them if unknown.",
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
          hint:
            "Antes de prepare_listing_description_draft ejecuta analyze_property_images(case_id=...) si falta photo_analysis y lookup_property_surroundings(case_id=...) si falta zone_context. No uses notify_user(kind=listing_description_review) hasta tener listing_description_draft.",
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
      const mutableCommercialIngredientKeys = new Set([
        "listing_price",
        "pricing_ideal",
        "pricing_minimum",
        "target_price",
        "currency",
      ]);
      const copySafeIngredientPayload = Object.fromEntries(
        Object.entries(ingredientPayload).filter(
          ([key]) => !mutableCommercialIngredientKeys.has(key)
        )
      );
      try {
        const parsed = await callOpenRouterJsonTool({
          model: LISTING_COPY_MODEL_ID,
          maxTokens: LISTING_COPY_MAX_TOKENS,
          temperature: LISTING_COPY_TEMPERATURE,
          messages: [
            {
              role: "system",
              content: prepareListingDescriptionDraftSystemPrompt(),
            },
            {
              role: "user",
              content:
                "Con estos ingredientes genera un borrador comercial con este shape exacto: " +
                '{ "headline": string, "short_description": string, "description": string, "ingredients_used": string[], "excluded_claims": string[], "missing_ingredients": string[] }. ' +
                "El cuerpo description debe tener entre 120 y 220 palabras y tono sobrio. " +
                "Integra advisor_highlights y editorial_instructions cuando existan. " +
                "missing_ingredients debe contener etiquetas en español natural para el asesor, nunca slugs técnicos ni nombres de campos." +
                `\n\nIngredientes:\n${JSON.stringify(copySafeIngredientPayload)}`,
            },
          ],
        });
        const draft = {
          headline:
            typeof parsed.headline === "string" && parsed.headline.trim()
              ? sanitizeListingDescriptionCommercialCopy(parsed.headline).slice(0, 140)
              : "Borrador de publicación",
          short_description:
            typeof parsed.short_description === "string" && parsed.short_description.trim()
              ? sanitizeListingDescriptionCommercialCopy(parsed.short_description).slice(
                  0,
                  220
                )
              : "",
          description:
            typeof parsed.description === "string" && parsed.description.trim()
              ? sanitizeListingDescriptionCommercialCopy(parsed.description)
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
  case_id?: string;
};

const IMAGE_WATERMARK_OUTPUT_BUCKET = "account-assets";

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

async function persistWatermarkedPhotosToCase(
  ctx: ToolContext,
  caseId: string,
  watermarkResult: Record<string, unknown>
): Promise<boolean> {
  const opCase = await getOperationalCase(ctx.db, caseId).catch(() => null);
  if (!opCase || opCase.user_id !== ctx.userId) return false;
  const context = asRecord(opCase.context_jsonb) ?? {};
  const outputs = Array.isArray(watermarkResult.outputs)
    ? watermarkResult.outputs
        .map((entry) => asRecord(entry))
        .filter((entry): entry is Record<string, unknown> => Boolean(entry))
        .map((row) => ({
          input_path:
            typeof row.input_path === "string" ? row.input_path.trim() : "",
          output_path:
            typeof row.output_path === "string" ? row.output_path.trim() : undefined,
          output_bucket:
            typeof row.output_bucket === "string"
              ? row.output_bucket
              : IMAGE_WATERMARK_OUTPUT_BUCKET,
          ok: row.ok !== false,
          error: typeof row.error === "string" ? row.error : undefined,
        }))
        .filter((entry) => entry.input_path.length > 0)
    : [];
  const existingManifest = parsePhotoManifest(context.photo_manifest);
  const baseManifest = buildPhotoManifestFromRawPhotos(
    Array.isArray(context.raw_photos)
      ? context.raw_photos
      : outputs.map((entry) => entry.input_path),
    existingManifest
  );
  const applied = applyWatermarkOutputsToManifest(baseManifest, outputs);
  const watermarkedPaths = applied.manifest
    .map((entry) => entry.watermarked_path)
    .filter((entry): entry is string => Boolean(entry));
  const updated = await persistCaseContextPatch(ctx, caseId, {
    watermark_configured: true,
    watermarked_photos: watermarkedPaths,
    photo_manifest: applied.manifest,
    watermark_missing: applied.missing,
  });
  return Boolean(updated);
}

async function resolveWatermarkAsset(ctx: ToolContext, assetKey?: string) {
  return findAccountWatermarkAsset(ctx.db, ctx.userId, assetKey);
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
    if (parsed) {
      const response = buildEasyBrokerMlsToolResponse(
        toolId,
        input,
        parsed,
        error.stderr ?? "",
        creds.source
      );
      if (response.status === "filter_not_applied") {
        return { ...response, attempt, exit_code: error.code };
      }
    }
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

export function buildEasyBrokerMlsToolResponse(
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
  const statusFilterRaw =
    cliResult.status_filter && typeof cliResult.status_filter === "object"
      ? (cliResult.status_filter as Record<string, unknown>)
      : null;
  const statusMetric = cliMetrics.find((metric) => metric.step === "apply_status_filter");
  const statusFilter = {
    requested:
      isHistoricalReference ||
      statusFilterRaw?.requested === true ||
      statusMetric?.requested === true,
    applied: statusFilterRaw?.applied === true || statusMetric?.applied === true,
    verified: statusFilterRaw?.verified === true || statusMetric?.verified === true,
    selected_label:
      (typeof statusFilterRaw?.selected_label === "string"
        ? statusFilterRaw.selected_label
        : null) ??
      (typeof statusMetric?.selected_label === "string" ? statusMetric.selected_label : null),
  };
  const statusFilterFailed =
    isHistoricalReference &&
    (cliResult.error === "status_filter_not_applied" ||
      parsed.error === "status_filter_not_applied" ||
      statusFilter.verified !== true);

  if (statusFilterFailed) {
    return {
      ok: false,
      status: "filter_not_applied",
      source: "easybroker_mls",
      mode: "web_mls",
      tool: toolId,
      credential_source: credentialSource,
      query: {
        ...input,
        backend:
          "EasyBroker MLS web (/agent/mls_properties). Se aplican filtros en UI cuando existen y se normaliza/filtra de nuevo en Gu OS.",
        historical_status_filter: "solo_cerradas",
      },
      count: 0,
      results: [],
      status_filter: statusFilter,
      historical_status_filter_unverified: true,
      caveat:
        "No se pudo verificar el filtro Estatus=Solo cerradas en EasyBroker MLS. No se reportan resultados como históricos para evitar etiquetar activas como cerradas. Reintenta desde Credenciales API → Probar conexión EasyBroker MLS o valida manualmente el filtro Estatus.",
      session_refreshed: sessionRefreshed,
      cli_result: {
        ...parsed,
        result: {
          ...cliResult,
          raw_count: Array.isArray(cliResult.results) ? cliResult.results.length : 0,
          count: 0,
          results: [],
          status_filter: statusFilter,
        },
      },
      ...(stderr.trim() ? { stderr: stderr.trim().slice(0, 2000) } : {}),
    };
  }

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
      status_filter: statusFilter,
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
      historical_status_filter: isHistoricalReference ? "solo_cerradas" : null,
    },
    count: normalized.length,
    results: normalized,
    status_filter: statusFilter,
    caveat: isHistoricalReference
      ? "Resultados con Estatus=Solo cerradas verificado en EasyBroker MLS. El precio visible puede ser precio publicado o capturado, no necesariamente el precio final real de cierre."
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
    property_type: mapToEasyBrokerPropertyType(item.property_type) ?? item.property_type ?? null,
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
  const requestedTypes = [
    ...(input.property_type?.trim() ? [input.property_type.trim()] : []),
    ...(Array.isArray(input.property_types) ? input.property_types : []),
  ]
    .map((value) => String(value).trim())
    .filter(Boolean);
  if (requestedTypes.length > 0) {
    if (
      !property.property_type ||
      !requestedTypes.some((type) => propertyTypesMatch(property.property_type, type))
    ) {
      return false;
    }
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

export function resolveComparableSearchAttemptTrace(input: {
  strictFilters: Record<string, unknown>;
  attempts: Array<Record<string, unknown>>;
  appliedFallbackLevel?: string | null;
}): {
  filters_used: Record<string, unknown>;
  search_attempts: {
    strict_filters: Record<string, unknown>;
    attempts: Array<Record<string, unknown>>;
    last_attempt_level: string;
    applied_level: string | null;
    exhausted: boolean;
  };
} {
  const attempts = input.attempts;
  const lastAttempt = attempts[attempts.length - 1] ?? null;
  const appliedFallbackLevel = input.appliedFallbackLevel ?? null;
  const successfulAttempt =
    appliedFallbackLevel != null
      ? attempts.find((attempt) => attempt.level === appliedFallbackLevel)
      : attempts.find(
          (attempt) =>
            attempt.ok === true &&
            typeof attempt.count === "number" &&
            attempt.count > 0
        );
  const exhausted =
    appliedFallbackLevel == null &&
    attempts.length > 1 &&
    attempts.every(
      (attempt) =>
        attempt.ok === true &&
        typeof attempt.count === "number" &&
        attempt.count === 0
    );
  const filtersUsed =
    successfulAttempt && isRecord(successfulAttempt.filters)
      ? successfulAttempt.filters
      : exhausted && lastAttempt && isRecord(lastAttempt.filters)
        ? lastAttempt.filters
        : input.strictFilters;
  return {
    filters_used: filtersUsed,
    search_attempts: {
      strict_filters: input.strictFilters,
      attempts,
      last_attempt_level:
        typeof lastAttempt?.level === "string" ? lastAttempt.level : "strict",
      applied_level: appliedFallbackLevel,
      exhausted,
    },
  };
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

        const searchAttempts: Array<Record<string, unknown>> = [];
        const recordAttempt = (
          level: string,
          reason: string,
          filters: EasyBrokerSearchInput,
          result: Record<string, unknown>
        ) => {
          searchAttempts.push({
            level,
            reason,
            filters,
            count: comparableResultCount(result),
            ok: result.ok !== false,
            status:
              typeof result.status === "string" ? result.status : undefined,
          });
        };

        let out = await searchEasyBrokerProperties(
          ctx,
          toolId,
          primaryFilters,
          creds
        );
        recordAttempt("strict", "canonical_strict", primaryFilters, out);
        let appliedFallbackLevel: string | null = null;

        const shouldContinueFallback =
          out.ok !== false &&
          out.status !== "filter_not_applied" &&
          comparableResultCount(out) === 0;

        if (shouldContinueFallback) {
          for (const step of fallbackLadder) {
            if (JSON.stringify(step.filters) === JSON.stringify(primaryFilters)) {
              continue;
            }
            const retryOut = await searchEasyBrokerProperties(
              ctx,
              toolId,
              step.filters,
              creds
            );
            recordAttempt(step.level, step.reason, step.filters, retryOut);
            if (retryOut.status === "filter_not_applied") {
              out = retryOut;
              break;
            }
            if (retryOut.ok !== false) {
              out = retryOut;
            }
            if (retryOut.ok !== false && comparableResultCount(retryOut) > 0) {
              appliedFallbackLevel = step.level;
              break;
            }
          }
        }

        const attemptTrace = resolveComparableSearchAttemptTrace({
          strictFilters: normalizedInput.filters,
          attempts: searchAttempts,
          appliedFallbackLevel,
        });
        const filtersUsed = attemptTrace.filters_used as EasyBrokerSearchInput;
        const searchAttemptsPayload = attemptTrace.search_attempts;
        const exhausted = searchAttemptsPayload.exhausted;

        const outWithFilters = {
          ...out,
          filters_used: filtersUsed,
          filter_warnings:
            normalizedInput.warnings.length > 0 ||
            appliedFallbackLevel != null ||
            exhausted
              ? [
                  ...normalizedInput.warnings,
                  ...(appliedFallbackLevel != null
                    ? [
                        `Se aplico fallback de comparables en nivel ${appliedFallbackLevel} tras 0 resultados iniciales en banda estricta.`,
                      ]
                    : []),
                  ...(exhausted
                    ? [
                        `Se agoto fallback de comparables hasta ${searchAttemptsPayload.last_attempt_level} sin resultados usables.`,
                      ]
                    : []),
                ]
              : undefined,
          search_attempts:
            searchAttempts.length > 1 || exhausted
              ? searchAttemptsPayload
              : undefined,
        };
        if (out.ok !== false && out.status !== "filter_not_applied") {
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

export function evaluatePublishGateContext(params: {
  context: Record<string, unknown>;
  destination: PublishDestination;
  operationType: "create_draft" | "process_media" | "publish";
}):
  | { ok: true }
  | {
      ok: false;
      status:
        | "publication_shadow_no_side_effects"
        | "publication_workflow_off"
        | "publication_runner_required"
        | "publish_gate_blocked";
      missing?: string[];
    } {
  const publication = asRecord(params.context.publication) ?? {};
  const rolloutMode =
    params.context.publication_mode ?? publication.mode ?? "off";
  if (
    rolloutMode !== "active" ||
    params.context.publication_workflow_v1 === false ||
    publication.feature_enabled === false
  ) {
    return {
      ok: false,
      status:
        rolloutMode === "shadow"
          ? "publication_shadow_no_side_effects"
          : "publication_workflow_off",
    };
  }
  const pending = asRecord(params.context.publication_runner_pending_action);
  if (
    params.context.package_ready_machine_work_in_flight !== true ||
    !pending ||
    pending.destination !== params.destination ||
    pending.type !== params.operationType
  ) {
    return { ok: false, status: "publication_runner_required" };
  }
  const missing = collectPublishGateMissing(
    params.context,
    params.destination
  );
  if (missing.length > 0) {
    return { ok: false, status: "publish_gate_blocked", missing };
  }
  return { ok: true };
}

async function enforcePublishGateForCase(params: {
  ctx: ToolContext;
  caseId: string;
  destination: PublishDestination;
  operationType: "create_draft" | "process_media" | "publish";
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
  const evaluated = evaluatePublishGateContext({
    context,
    destination: params.destination,
    operationType: params.operationType,
  });
  if (!evaluated.ok) {
    return {
      ok: false,
      status: evaluated.status,
      case_id: opCase.id,
      destination: params.destination,
      operation_type: params.operationType,
      ...(evaluated.missing ? { missing: evaluated.missing } : {}),
      hint:
        evaluated.status === "publication_runner_required"
          ? "Las escrituras de publicación activas sólo pueden ejecutarse desde requestPublicationProgress."
          : evaluated.status === "publish_gate_blocked"
            ? "No se puede publicar aún. Completa preflight, aprueba descripción y registra aprobación del destino."
            : "Configura publication_mode=active y ejecuta requestPublicationProgress para escribir en el destino.",
    };
  }
  return { ok: true as const, opCase };
}

async function enforceUnggaPublishPhaseGate(
  ctx: ToolContext,
  caseId: string,
  requestedPropertyId?: string | null
): Promise<
  | { ok: true; canonical_property_id: string | null }
  | {
      ok: false;
      status: string;
      error: string;
      phase?: string | null;
      hint?: string;
    }
> {
  const opCase = await getOperationalCase(ctx.db, caseId).catch(() => null);
  if (!opCase || opCase.user_id !== ctx.userId) {
    return {
      ok: false,
      status: "case_not_found",
      error: "No encontré el caso para validar la fase Ungga.",
    };
  }
  const context = asRecord(opCase.context_jsonb) ?? {};
  if (context.publication_workflow_v1 === false) {
    return { ok: true, canonical_property_id: requestedPropertyId ?? null };
  }
  const { publicationFromContext } = await import(
    "../operational-cases/publication-workflow"
  );
  const publication = publicationFromContext(context);
  const phase = publication.destinations.ungga.phase;
  const artifactId =
    typeof publication.destinations.ungga.artifact.ungga_property_id === "string"
      ? publication.destinations.ungga.artifact.ungga_property_id.trim()
      : null;
  const published = asRecord(context.published) ?? {};
  const unggaPublished = asRecord(published.ungga) ?? {};
  const contextId =
    typeof unggaPublished.ungga_property_id === "string"
      ? unggaPublished.ungga_property_id.trim()
      : null;
  const canonicalId = artifactId || contextId || null;

  if (
    requestedPropertyId &&
    looksLikeEasyBrokerImportedUnggaId(requestedPropertyId)
  ) {
    return {
      ok: false,
      status: "ungga_imported_property_rejected",
      phase,
      error:
        "publish_draft rechazado: el GU-ID parece una propiedad importada desde EasyBroker. Usa el borrador CLI canónico.",
      hint: "No adoptar propiedades Tipo Importada / Origen EasyBroker.",
    };
  }

  if (
    requestedPropertyId &&
    canonicalId &&
    requestedPropertyId.trim() !== canonicalId
  ) {
    return {
      ok: false,
      status: "ungga_property_id_mismatch",
      phase,
      error: `publish_draft rechazado: GU-ID solicitado (${requestedPropertyId}) no coincide con el artifact CLI (${canonicalId}).`,
      hint: "Publica únicamente el borrador creado por prepare_draft vía CLI.",
    };
  }

  if (phase === "publish_pending" || phase === "publishing") {
    return { ok: true, canonical_property_id: canonicalId };
  }
  // Legacy cases without machine state may still publish when draft exists.
  if (!asRecord(context.publication)) {
    return { ok: true, canonical_property_id: canonicalId };
  }
  return {
    ok: false,
    status: "phase_blocked",
    phase,
    error: `publish_draft rechazado: fase Ungga actual es ${phase}; se requiere publish_pending tras preflight pass`,
    hint: "Espera preflight condicional o resolución de publication_review_required antes de publish_draft.",
  };
}

function looksLikeEasyBrokerImportedUnggaId(propertyId: string): boolean {
  const id = propertyId.trim();
  if (!id) return false;
  return /EB-[A-Z0-9]+/i.test(id);
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
  /** Owner closing commission → nested under operations[].commission. */
  commission?: { type: "percentage" | "amount" | "months"; value: number; currency?: string };
  construction_size?: number;
  lot_size?: number;
  area_m2?: number;
  lot_length?: number;
  lot_width?: number;
  covered_space?: number;
  uncovered_space?: number;
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
  images?: PhotoUploadPair[];
  /** @deprecated Use images pairs so path/title identity cannot drift. */
  image_paths?: string[];
  /** @deprecated Use images pairs so path/title identity cannot drift. */
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

function stripNullishProps(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === null || item === undefined) continue;
    next[key] = item;
  }
  return next;
}

/** Omits null/undefined/"" so optional Zod fields are absent, not invalid. */
function stripEmptyAndNullishProps(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === null || item === undefined) continue;
    if (typeof item === "string" && item.trim() === "") continue;
    if (Array.isArray(item)) {
      const cleaned = item.filter(
        (entry) => !(typeof entry === "string" && entry.trim() === "")
      );
      next[key] = cleaned;
      continue;
    }
    next[key] = item;
  }
  return next;
}

async function enrichUnggaPublishInputFromCaseContext(
  ctx: ToolContext,
  input: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const caseId =
    typeof input.case_id === "string" && input.case_id.trim()
      ? input.case_id.trim()
      : ctx.caseId ?? null;
  if (!caseId) return input;
  const opCase = await getOperationalCase(ctx.db, caseId).catch(() => null);
  if (!opCase || opCase.user_id !== ctx.userId) return input;
  const context = asRecord(opCase.context_jsonb) ?? {};
  const propertyData = asRecord(context.property_data) ?? {};
  const approved = asRecord(context.listing_description_approved) ?? {};
  const pricing = asRecord(context.pricing_proposal) ?? {};
  const published = asRecord(context.published) ?? {};
  const unggaPublished = asRecord(published.ungga) ?? {};
  const publication = asRecord(context.publication);
  const destinations = publication
    ? asRecord(publication.destinations)
    : null;
  const unggaDest = destinations ? asRecord(destinations.ungga) : null;
  const unggaArtifact = unggaDest ? asRecord(unggaDest.artifact) : null;

  const next = { ...input };
  const fillString = (key: string, ...candidates: unknown[]) => {
    const current = next[key];
    if (typeof current === "string" && current.trim()) return;
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim()) {
        next[key] = candidate.trim();
        return;
      }
    }
  };
  const fillNumber = (key: string, ...candidates: unknown[]) => {
    if (typeof next[key] === "number" && Number.isFinite(next[key])) return;
    for (const candidate of candidates) {
      const n = typeof candidate === "number" ? candidate : Number(candidate);
      if (Number.isFinite(n) && n > 0) {
        next[key] = n;
        return;
      }
    }
  };

  fillString(
    "title",
    approved.headline,
    propertyData.property_title,
    context.listing_title
  );
  fillString(
    "description",
    approved.description,
    context.listing_description_md
  );
  fillString(
    "operation",
    propertyData.operation,
    propertyData.operacion,
    "sale"
  );
  fillString(
    "property_type",
    propertyData.property_type,
    propertyData.tipo,
    "Casa"
  );
  fillNumber(
    "price",
    pricing.salida,
    propertyData.price,
    propertyData.asking_price
  );
  fillString("currency", propertyData.currency, "MXN");
  fillNumber(
    "construction_m2",
    propertyData.construction_m2,
    propertyData.area_construida_m2,
    propertyData.area_m2
  );
  fillNumber(
    "land_m2",
    propertyData.land_m2,
    propertyData.lot_size,
    propertyData.terreno_m2,
    propertyData.area_total_m2,
    propertyData.land_area_m2
  );
  fillNumber("bedrooms", propertyData.bedrooms, propertyData.recamaras);
  fillNumber(
    "bathrooms_full",
    propertyData.bathrooms,
    propertyData.full_bathrooms,
    propertyData.banos
  );
  fillString("address", resolveUnggaCanonicalAddress(propertyData));
  fillString(
    "ungga_property_id",
    unggaArtifact?.ungga_property_id,
    unggaPublished.ungga_property_id
  );
  fillString(
    "draft_url",
    unggaArtifact?.draft_url,
    unggaPublished.draft_url
  );

  // Always prefer photo_manifest.public_url when present. The model often
  // rewrites/corrupts asset UUIDs in image_urls (seen: …-490a-… → …-4900-…
  // from case_id …-4900-…), which yields HTTP 404 on /api/public/account-assets.
  {
    const manifest = Array.isArray(context.photo_manifest)
      ? context.photo_manifest
      : [];
    const urls = manifest
      .map((item) =>
        asRecord(item) && typeof item.public_url === "string"
          ? item.public_url.trim()
          : null
      )
      .filter((url): url is string => Boolean(url));
    if (urls.length > 0) next.image_urls = urls;
  }

  {
    const resolvedLocation = resolveUnggaLocationFromCaseSources({
      inputLocation: asRecord(next.location),
      propertyData,
      geocode: asRecord(context.geocode),
      zoneContext: asRecord(context.zone_context),
    });
    if (resolvedLocation) {
      next.location = {
        latitude: resolvedLocation.latitude,
        longitude: resolvedLocation.longitude,
        source: resolvedLocation.source,
      };
    }
  }

  next.case_id = caseId;

  const terms = parseCommissionTerms(context.commission_terms);
  const mapped = mapCollaborationToUngga(terms);
  const destinationsForOverride = asRecord(
    asRecord(context.publication)?.destinations
  );
  const unggaOverride = asRecord(
    asRecord(destinationsForOverride?.ungga)?.commercial_override
  );
  if (next.exclusive === undefined && mapped.exclusive !== undefined) {
    next.exclusive = mapped.exclusive;
  }
  if (
    next.collaboration_enabled === undefined &&
    mapped.collaboration_enabled !== undefined
  ) {
    next.collaboration_enabled = mapped.collaboration_enabled;
  }
  if (
    next.collaboration_notes === undefined &&
    mapped.collaboration_notes != null
  ) {
    next.collaboration_notes = mapped.collaboration_notes;
  }
  if (
    (typeof next.commission_pct !== "number" ||
      !Number.isFinite(next.commission_pct)) &&
    mapped.commission_pct != null
  ) {
    next.commission_pct = mapped.commission_pct;
  }
  if (unggaOverride) {
    if (typeof unggaOverride.exclusive === "boolean") {
      next.exclusive = unggaOverride.exclusive;
    }
    if (typeof unggaOverride.collaboration_enabled === "boolean") {
      next.collaboration_enabled = unggaOverride.collaboration_enabled;
    }
    const overridePct = safeNumber(unggaOverride.commission_pct);
    if (overridePct != null && overridePct > 0) {
      next.commission_pct = overridePct;
    }
  }
  if (mapped.warnings.length > 0) {
    next.mapping_warnings = mapped.warnings;
  }

  return normalizeUnggaUiFields(next);
}

/** Map agent/internal enums to Ungga Spanish UI labels before CLI/API writes. */
export function normalizeUnggaUiFields(
  input: Record<string, unknown>
): Record<string, unknown> {
  const next = { ...input };
  const mapOr = (
    value: unknown,
    map: Record<string, string | null>
  ): string | null => {
    if (typeof value !== "string" || !value.trim()) return null;
    const raw = value.trim();
    const key = raw
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
    if (Object.prototype.hasOwnProperty.call(map, key)) return map[key];
    if (Object.prototype.hasOwnProperty.call(map, raw.toLowerCase())) {
      return map[raw.toLowerCase()];
    }
    return raw;
  };

  const condition = mapOr(next.condition, {
    // Ungga ESTADO DE LA PROPIEDAD is condition/quality, not "new build".
    new: "Bueno",
    nuevo: "Bueno",
    very_good: "Muy bueno",
    muy_bueno: "Muy bueno",
    "muy bueno": "Muy bueno",
    excellent: "Excelente",
    excelente: "Excelente",
    good: "Bueno",
    bueno: "Bueno",
    regular: "Regular",
    fair: "Regular",
    bad: "Malo",
    malo: "Malo",
    poor: "Malo",
  });
  if (condition) next.condition = condition;
  else if (typeof next.condition === "string") delete next.condition;

  const age = mapOr(next.age_range, {
    unknown: null,
    new: "A estrenar",
    nuevo: "A estrenar",
    "a estrenar": "A estrenar",
    "0-1": "Menos de 1 año",
    "0-5": "1-5 años",
    "0-5 anos": "1-5 años",
    "0-5 años": "1-5 años",
    "menos de 5 anos": "1-5 años",
    "menos de 5 años": "1-5 años",
    "1-5": "1-5 años",
    "1-5 anos": "1-5 años",
    "1-5 años": "1-5 años",
    "5-10": "5-10 años",
    "5-10 anos": "5-10 años",
    "10-20": "10-20 años",
    "10-20 anos": "10-20 años",
    "20+": "Más de 20 años",
    "mas de 20 anos": "Más de 20 años",
  });
  // Ungga GENERAL requires antigüedad; default when agent/case has unknown/missing.
  next.age_range = age || "1-5 años";

  const country = mapOr(next.country, {
    mx: "México",
    mex: "México",
    mexico: "México",
  });
  if (country) next.country = country;

  const locationType = mapOr(next.location_type, {
    house: "Residencial",
    home: "Residencial",
    residential: "Residencial",
    residencial: "Residencial",
    apartment: "Residencial",
    departamento: "Residencial",
    commercial: "Comercial",
    comercial: "Comercial",
  });
  if (locationType) next.location_type = locationType;

  const currentStatus = mapOr(next.current_status, {
    existing: "Habitable",
    habitable: "Habitable",
    occupied: "Habitable",
    vacant: "Habitable",
    under_construction: "En construcción",
    "en construccion": "En construcción",
    remodel: "En remodelación",
    remodeling: "En remodelación",
    "en remodelacion": "En remodelación",
  });
  if (currentStatus) next.current_status = currentStatus;

  if (!next.condition) {
    next.condition = "Bueno";
  }

  const landUnit = mapOr(next.land_unit, {
    m2: "m²",
    "m^2": "m²",
    sqm: "m²",
    "m²": "m²",
  });
  next.land_unit = landUnit || "m²";

  return next;
}

function makeEasyBrokerCreateListingTool(ctx: ToolContext) {
  return tool(
    async (input: EasyBrokerCreateListingInput) => {
      const record = await createTrackedToolCall(ctx, "easybroker_create_listing",
        input as unknown as Record<string, unknown>,
        false);
      const caseId = input.case_id?.trim() || ctx.caseId?.trim() || null;
      if (!caseId) {
        const out = {
          ok: false,
          status: "case_id_required",
          hint:
            "easybroker_create_listing requiere case_id para validar el gate de publicación.",
        };
        await updateToolCallStatus(ctx.db, record.id, "failed", out);
        return JSON.stringify(out);
      }
      input = { ...input, case_id: caseId };
      const gate = await enforcePublishGateForCase({
        ctx,
        caseId,
        destination: "easybroker",
        operationType: "create_draft",
      });
      if (!gate.ok) {
        await updateToolCallStatus(ctx.db, record.id, "failed", gate);
        return JSON.stringify(gate);
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
      let droppedFields: EasyBrokerDroppedField[] | undefined;
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
        // Resuelve lat/lng, dirección y atributos del caso antes de armar el
        // payload allowlisted. El adapter es dueño del contrato EasyBroker.
        inputForExecution = await enrichEasyBrokerCreateInputFromCaseContext(
          ctx,
          inputForExecution
        );
        const mappingWarnings = (
          inputForExecution as EasyBrokerCreateListingInput & {
            mapping_warnings?: Array<{
              code: string;
              message: string;
              actual?: unknown;
            }>;
          }
        ).mapping_warnings;
        inputForExecution = await resolveEasyBrokerCreateLocationName(
          creds,
          inputForExecution
        );
        const catalogFeatureNames = await fetchEasyBrokerFeatureCatalogNames(creds);
        const built = buildEasyBrokerCreatePayload(inputForExecution, {
          catalogFeatureNames,
        });
        attemptedPayload = built.payload;
        droppedFields = built.dropped_fields;
        const out = await createEasyBrokerListing(
          ctx,
          inputForExecution,
          creds,
          built
        );
        if (mappingWarnings && mappingWarnings.length > 0) {
          (out as Record<string, unknown>).mapping_warnings = mappingWarnings;
          (out as Record<string, unknown>).share_commission =
            inputForExecution.share_commission;
        }
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
              kind: "easybroker_draft_created",
              destination: "easybroker",
              listing_id: out.listing_id ?? null,
              public_url: out.public_url ?? out.url ?? null,
              remote_status:
                typeof out.status === "string" ? out.status : "not_published",
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
          ...(attemptedPayload
            ? {
                attempted_payload: attemptedPayload,
                payload_keys: Object.keys(attemptedPayload),
              }
            : {}),
          ...(droppedFields?.length ? { dropped_fields: droppedFields } : {}),
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
        "Creates an EasyBroker property as not_published by default (write, HITL). case_id is required so the adapter enforces the publication gate and fills title/description/coords/attributes from the case. Do not invent custom_fields, free-form features, empty strings, or latitude/longitude=0; the adapter allowlists and sanitizes the EasyBroker payload.",
      schema: z.preprocess(
        stripNullishProps,
        z.object({
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
          commission: z
            .object({
              type: z.enum(["percentage", "amount", "months"]),
              value: z.number().positive(),
              currency: z.string().optional(),
            })
            .optional(),
          construction_size: z.number().nonnegative().optional(),
          lot_size: z.number().nonnegative().optional(),
          area_m2: z.number().nonnegative().optional(),
          lot_length: z.number().nonnegative().optional(),
          lot_width: z.number().nonnegative().optional(),
          covered_space: z.number().nonnegative().optional(),
          uncovered_space: z.number().nonnegative().optional(),
          exclusive: z.boolean().nullable().optional(),
          videos: z.array(z.string()).optional(),
          virtual_tour: z.string().optional(),
          show_exact_location: z.boolean().optional(),
          custom_fields: z
            .record(z.string(), z.any())
            .optional()
            .describe("Ignored. Do not use; the adapter owns the EasyBroker contract."),
          custom_fields_json: z
            .string()
            .optional()
            .describe("Ignored. Do not use; the adapter owns the EasyBroker contract."),
          case_id: z.string().min(1),
          dry_run: z.boolean().optional(),
        })
      ),
    }
  );
}

export type EnsureCasePhotosReadyResult =
  | {
      ok: true;
      requireWatermark: boolean;
      preferWatermarked: boolean;
      skippedWatermark: boolean;
      appliedWatermark: boolean;
      manifest: PhotoManifestEntry[];
    }
  | {
      ok: false;
      status:
        | "case_not_found"
        | "raw_photos_missing"
        | "watermark_apply_failed"
        | "watermark_persist_failed"
        | "watermark_precondition_missing";
      error: string;
      missing?: string[];
      side_effect_started: false;
      retryable: true;
    };

/**
 * Deterministic media precondition for EasyBroker upload.
 * - No brand watermark asset → upload originals (never block).
 * - Asset exists and watermarked_path missing → apply + persist before upload.
 * - Asset exists but apply/persist fails → structured failure (no EasyBroker side effect).
 */
export async function ensureCasePhotosReadyForUpload(
  ctx: ToolContext,
  caseId: string
): Promise<EnsureCasePhotosReadyResult> {
  const opCase = await getOperationalCase(ctx.db, caseId).catch(() => null);
  if (!opCase || opCase.user_id !== ctx.userId) {
    return {
      ok: false,
      status: "case_not_found",
      error: "No se encontró el caso para preparar fotos de publicación.",
      side_effect_started: false,
      retryable: true,
    };
  }

  let context = asRecord(opCase.context_jsonb) ?? {};
  let manifest = buildPhotoManifestFromRawPhotos(
    context.raw_photos,
    parsePhotoManifest(context.photo_manifest)
  );
  const rawPaths = resolveRawPhotoPaths(context.raw_photos);
  if (rawPaths.length === 0 && manifest.length === 0) {
    return {
      ok: false,
      status: "raw_photos_missing",
      error: "El caso no tiene raw_photos / photo_manifest para subir a EasyBroker.",
      side_effect_started: false,
      retryable: true,
    };
  }

  const resolved = await resolveRequireWatermark({
    db: ctx.db,
    userId: ctx.userId,
    context,
  });
  if (
    resolved.configured !== null &&
    context.watermark_configured !== resolved.configured
  ) {
    await persistCaseContextPatch(ctx, caseId, {
      watermark_configured: resolved.configured,
    });
    context = { ...context, watermark_configured: resolved.configured };
  }

  let requireWatermark =
    resolved.requireWatermark || contextRequiresWatermark(context);

  // Explicit no-asset always wins: originals are valid.
  if (resolved.configured === false || context.watermark_configured === false) {
    requireWatermark = false;
  }

  if (!requireWatermark) {
    if (context.watermark_configured !== false) {
      await persistCaseContextPatch(ctx, caseId, {
        watermark_configured: false,
        watermark_missing: [],
      });
    }
    return {
      ok: true,
      requireWatermark: false,
      preferWatermarked: false,
      skippedWatermark: true,
      appliedWatermark: false,
      manifest,
    };
  }

  const missing = manifest
    .filter((entry) => !entry.watermarked_path)
    .map((entry) => entry.source_path);
  if (missing.length === 0) {
    return {
      ok: true,
      requireWatermark: true,
      preferWatermarked: true,
      skippedWatermark: false,
      appliedWatermark: false,
      manifest,
    };
  }

  const inputPaths = rawPaths.length > 0 ? rawPaths : missing;
  const watermarkOut = await applyImageWatermark(ctx, {
    input_paths: inputPaths,
    case_id: caseId,
  });

  if (watermarkOut.status === "not_configured") {
    await persistCaseContextPatch(ctx, caseId, {
      watermark_configured: false,
      watermark_missing: [],
    });
    return {
      ok: true,
      requireWatermark: false,
      preferWatermarked: false,
      skippedWatermark: true,
      appliedWatermark: false,
      manifest,
    };
  }

  const persisted = await persistWatermarkedPhotosToCase(
    ctx,
    caseId,
    watermarkOut
  );
  if (!persisted) {
    return {
      ok: false,
      status: "watermark_persist_failed",
      error:
        "Las imágenes se marcaron en storage pero no se pudo persistir photo_manifest.watermarked_path.",
      missing,
      side_effect_started: false,
      retryable: true,
    };
  }

  const refreshed = await getOperationalCase(ctx.db, caseId).catch(() => null);
  const refreshedContext = asRecord(refreshed?.context_jsonb) ?? {};
  manifest = buildPhotoManifestFromRawPhotos(
    refreshedContext.raw_photos ?? context.raw_photos,
    parsePhotoManifest(refreshedContext.photo_manifest)
  );
  const stillMissing = manifest
    .filter((entry) => !entry.watermarked_path)
    .map((entry) => entry.source_path);

  if (
    watermarkOut.ok === false ||
    watermarkOut.status === "partial_failure" ||
    stillMissing.length > 0
  ) {
    return {
      ok: false,
      status: "watermark_apply_failed",
      error:
        stillMissing.length > 0
          ? `Watermark requerido pero faltan ${stillMissing.length} fotos: ${stillMissing.join(", ")}`
          : "image_watermark devolvió un fallo parcial al preparar fotos.",
      missing: stillMissing.length > 0 ? stillMissing : missing,
      side_effect_started: false,
      retryable: true,
    };
  }

  return {
    ok: true,
    requireWatermark: true,
    preferWatermarked: true,
    skippedWatermark: false,
    appliedWatermark: true,
    manifest,
  };
}

function makeEasyBrokerUploadImagesTool(ctx: ToolContext) {
  return tool(
    async (input: EasyBrokerUploadImagesInput) => {
      const record = await createTrackedToolCall(ctx, "easybroker_upload_images",
        input as unknown as Record<string, unknown>,
        false);
      const caseId = input.case_id?.trim() || ctx.caseId?.trim() || null;
      if (!caseId) {
        const out = {
          ok: false,
          status: "case_id_required",
          side_effect_started: false,
          retryable: true,
          hint:
            "easybroker_upload_images requiere case_id para validar el gate de publicación.",
        };
        await updateToolCallStatus(ctx.db, record.id, "failed", out);
        return JSON.stringify(out);
      }
      input = { ...input, case_id: caseId };
      const gate = await enforcePublishGateForCase({
        ctx,
        caseId,
        destination: "easybroker",
        operationType: "process_media",
      });
      if (!gate.ok) {
        await updateToolCallStatus(ctx.db, record.id, "failed", {
          ...gate,
          side_effect_started: false,
          retryable: true,
        });
        return JSON.stringify({
          ...gate,
          side_effect_started: false,
          retryable: true,
        });
      }
      const creds = await resolveEasyBrokerCredentials(ctx);
      if (!creds) {
        const out = {
          ok: false,
          status: "not_configured",
          side_effect_started: false,
          retryable: true,
          hint:
            "EasyBroker no está conectado para esta cuenta. Conéctalo desde Ajustes → Cuentas externas antes de publicar.",
        };
        await updateToolCallStatus(ctx.db, record.id, "failed", out);
        return JSON.stringify(out);
      }

      let sideEffectStarted = false;
      try {
        const ensure = await ensureCasePhotosReadyForUpload(ctx, caseId);
        if (!ensure.ok) {
          const out = {
            ok: false,
            status: ensure.status,
            error: ensure.error,
            missing: ensure.missing,
            side_effect_started: false as const,
            retryable: true as const,
            hint:
              "El upload no llegó a EasyBroker. Reintenta process_media; el adapter aplicará watermark si hay asset de marca.",
          };
          await updateToolCallStatus(ctx.db, record.id, "failed", out);
          return JSON.stringify(out);
        }

        // Always derive pairs from the authoritative manifest; ignore LLM-invented paths.
        const uploadInput: EasyBrokerUploadImagesInput = {
          ...input,
          images:
            ensure.manifest.length > 0
              ? photoUploadPairsFromManifest(
                  ensure.manifest,
                  ensure.preferWatermarked
                )
              : input.images,
          image_paths: undefined,
          image_titles: undefined,
        };

        sideEffectStarted = true;
        const out = await uploadEasyBrokerImages(ctx, uploadInput, creds);
        await markEasyBrokerCredentialResult(ctx, creds, out.ok !== false, out.status);
        const enrichedOut = {
          ...out,
          side_effect_started: true,
          watermark_applied: ensure.appliedWatermark,
          watermark_skipped: ensure.skippedWatermark,
        };
        await updateToolCallStatus(
          ctx.db,
          record.id,
          out.ok === false ? "failed" : "executed",
          enrichedOut
        );
        if (out.ok !== false) {
          const current = await getOperationalCase(ctx.db, caseId).catch(
            () => null
          );
          const currentContext = asRecord(current?.context_jsonb) ?? {};
          const currentManifest = buildPhotoManifestFromRawPhotos(
            currentContext.raw_photos,
            parsePhotoManifest(currentContext.photo_manifest)
          );
          const publishedImages = Array.isArray(out.images)
            ? out.images
                .map((item) => asRecord(item))
                .filter((item): item is Record<string, unknown> => Boolean(item))
                .flatMap((item) =>
                  typeof item.source_path === "string" &&
                  typeof item.url === "string"
                    ? [
                        {
                          source_path: item.source_path,
                          public_url: item.url,
                          title:
                            typeof item.title === "string" ? item.title : null,
                        },
                      ]
                    : []
                )
            : [];
          await persistCaseContextPatch(ctx, caseId, {
            photo_manifest: applyPublicUrlsToManifest(
              currentManifest,
              publishedImages,
              "easybroker"
            ),
          });
          await persistPublishedDestination(ctx, caseId, "easybroker", {
            images_uploaded: true,
            images_status:
              typeof out.images_status === "string"
                ? out.images_status
                : "submitted",
            image_count: typeof out.count === "number" ? out.count : null,
            listing_id: input.listing_id,
          });
          await insertOperationalCaseEvent(ctx.db, {
            caseId,
            eventType: "state_changed",
            actor: "agent",
            payload: {
              tool: "easybroker_upload_images",
              listing_id: input.listing_id,
              image_count: out.count,
              status: out.status,
              watermark_applied: ensure.appliedWatermark,
              watermark_skipped: ensure.skippedWatermark,
            },
          });
        }
        return JSON.stringify(enrichedOut);
      } catch (err) {
        const credentialFailure = isEasyBrokerCredentialFailure(err);
        const out = {
          ok: false,
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
          credential_failure: credentialFailure,
          side_effect_started: sideEffectStarted,
          retryable: !sideEffectStarted,
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
        "Uploads EasyBroker listing images from the case photo_manifest (write). Pass case_id + listing_id; the adapter applies brand watermark when configured and derives identity-safe pairs. Do not invent upload_path values.",
      schema: z.object({
        listing_id: z.string().min(1),
        images: z
          .array(
            z.object({
              source_path: z.string().min(1),
              upload_path: z.string().min(1),
              title: z.string().nullable(),
            })
          )
          .min(1)
          .max(50)
          .optional(),
        image_paths: z.array(z.string().min(1)).min(1).max(50).optional(),
        image_titles: z.array(z.string()).optional(),
        case_id: z.string().min(1),
        dry_run: z.boolean().optional(),
      }),
    }
  );
}

function makeEasyBrokerPublishListingTool(ctx: ToolContext) {
  return tool(
    async (input: {
      listing_id: string;
      case_id?: string;
      dry_run?: boolean;
    }) => {
      const record = await createTrackedToolCall(
        ctx,
        "easybroker_publish_listing",
        input as unknown as Record<string, unknown>,
        false
      );
      const caseId = input.case_id?.trim() || ctx.caseId?.trim() || null;
      if (!caseId) {
        const out = {
          ok: false,
          status: "case_id_required",
          hint:
            "easybroker_publish_listing requiere case_id para validar el gate de publicación.",
        };
        await updateToolCallStatus(ctx.db, record.id, "failed", out);
        return JSON.stringify(out);
      }
      input = { ...input, case_id: caseId };
      const gate = await enforcePublishGateForCase({
        ctx,
        caseId,
        destination: "easybroker",
        operationType: "publish",
      });
      if (!gate.ok) {
        await updateToolCallStatus(ctx.db, record.id, "failed", gate);
        return JSON.stringify(gate);
      }
      const creds = await resolveEasyBrokerCredentials(ctx);
      if (!creds) {
        const out = {
          ok: false,
          status: "not_configured",
          hint:
            "EasyBroker no está conectado para esta cuenta. Conéctalo desde Ajustes → Cuentas externas.",
        };
        await updateToolCallStatus(ctx.db, record.id, "failed", out);
        return JSON.stringify(out);
      }
      try {
        if (input.dry_run) {
          const out = {
            ok: true,
            status: "dry_run",
            listing_id: input.listing_id,
            payload: { status: "published" },
            hint: "Dry-run: no se envió PATCH a EasyBroker.",
          };
          await updateToolCallStatus(ctx.db, record.id, "executed", out);
          return JSON.stringify(out);
        }
        const response = await easyBrokerApiRequest(
          creds,
          `/v1/properties/${encodeURIComponent(input.listing_id)}`,
          {
            method: "PATCH",
            body: { status: "published" },
          }
        );
        const out = {
          ok: true,
          status: "published",
          listing_id: input.listing_id,
          remote_status: "published",
          raw: response,
          credential_source: creds.source,
        };
        await markEasyBrokerCredentialResult(ctx, creds, true, "published");
        await updateToolCallStatus(ctx.db, record.id, "executed", out);
        if (input.case_id) {
          await persistPublishedDestination(ctx, input.case_id, "easybroker", {
            listing_id: input.listing_id,
            status: "published",
            remote_status: "published",
          });
          await insertOperationalCaseEvent(ctx.db, {
            caseId: input.case_id,
            eventType: "step_completed",
            actor: "agent",
            stepKey: "package_ready",
            payload: {
              kind: "easybroker_status_published",
              destination: "easybroker",
              listing_id: input.listing_id,
            },
          });
        }
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
      name: "easybroker_publish_listing",
      description:
        "Sets an existing EasyBroker listing status to published after draft creation, image upload and conditional preflight pass. case_id is required to enforce the publication gate.",
      schema: z.object({
        listing_id: z.string().min(1),
        case_id: z.string().min(1),
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

function isEasyBrokerAgentEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

async function applyDefaultEasyBrokerAgent(
  ctx: ToolContext,
  input: EasyBrokerCreateListingInput
): Promise<EasyBrokerCreateListingInput> {
  const current = cleanString(input.agent);
  if (current && isEasyBrokerAgentEmail(current)) return input;
  const webCreds = await resolveEasyBrokerWebCredentials(ctx);
  const agentEmail = cleanString(webCreds?.email);
  if (agentEmail && isEasyBrokerAgentEmail(agentEmail)) {
    return { ...input, agent: agentEmail };
  }
  if (current && !isEasyBrokerAgentEmail(current)) {
    const { agent: _droppedAgent, ...rest } = input;
    return rest;
  }
  return input;
}

/**
 * Completa street/location (incl. lat/lng) desde property_data / zone_context
 * sin pisar valores usables que el caller ya mandó.
 */
export function mergeEasyBrokerCreateInputFromCaseSources(
  input: EasyBrokerCreateListingInput,
  sources: {
    propertyData?: Record<string, unknown> | null;
    zoneContext?: Record<string, unknown> | null;
  }
): EasyBrokerCreateListingInput {
  const propertyData = asRecord(sources.propertyData) ?? {};
  const address = asRecord(propertyData.address) ?? {};
  const zoneContext = asRecord(sources.zoneContext) ?? {};
  const zoneCoordinates = asRecord(zoneContext.coordinates) ?? {};
  const location: EasyBrokerListingLocationInput = {
    ...(asRecord(input.location) ?? {}),
  };

  const inputLat = safeNumber(location.latitude);
  const inputLon = safeNumber(location.longitude);
  if (isUsableLatLng(inputLat, inputLon)) {
    location.latitude = inputLat as number;
    location.longitude = inputLon as number;
  } else {
    const coordinateCandidates: Array<[unknown, unknown]> = [
      [address.latitude, address.longitude],
      [propertyData.latitude, propertyData.longitude],
      [propertyData.lat, propertyData.lng ?? propertyData.lon],
      [zoneContext.latitude, zoneContext.longitude],
      [zoneCoordinates.latitude, zoneCoordinates.longitude],
    ];
    for (const [latRaw, lonRaw] of coordinateCandidates) {
      const lat = safeNumber(latRaw);
      const lon = safeNumber(lonRaw);
      if (isUsableLatLng(lat, lon)) {
        location.latitude = lat as number;
        location.longitude = lon as number;
        break;
      }
    }
  }

  const stuffedStreet = cleanString(input.street);
  const stuffedLooksFull = Boolean(
    stuffedStreet && (stuffedStreet.match(/,/g)?.length ?? 0) >= 2
  );
  const parsedFromStreet = stuffedStreet
    ? parseMexicanAddressParts(stuffedStreet)
    : {};
  const parsedFromLocationAddress = cleanString(location.address)
    ? parseMexicanAddressParts(String(location.address))
    : {};
  const parsedFromTitle = cleanString(input.title)
    ? parseLocationHintFromListingTitle(input.title)
    : {};

  const fillLocationField = (key: string, ...values: unknown[]) => {
    if (cleanString(location[key])) return;
    const found = firstNonEmptyComparableString(...values);
    if (found) location[key] = found;
  };

  fillLocationField(
    "street",
    location.street,
    address.street,
    propertyData.street,
    propertyData.calle,
    stuffedLooksFull ? parsedFromStreet.street : stuffedStreet,
    parsedFromLocationAddress.street
  );
  fillLocationField(
    "exterior_number",
    location.exterior_number,
    address.exterior_number,
    address.numero_exterior,
    propertyData.exterior_number,
    parsedFromStreet.exterior_number,
    parsedFromLocationAddress.exterior_number
  );
  fillLocationField(
    "neighborhood",
    location.neighborhood,
    location.city_area,
    address.neighborhood,
    address.colonia,
    propertyData.neighborhood,
    propertyData.colonia,
    parsedFromStreet.neighborhood,
    parsedFromLocationAddress.neighborhood,
    parsedFromTitle.neighborhood
  );
  fillLocationField(
    "city",
    location.city,
    location.municipality,
    address.municipality,
    address.city,
    propertyData.municipality,
    propertyData.city,
    parsedFromStreet.city,
    parsedFromLocationAddress.city,
    parsedFromTitle.city
  );
  fillLocationField(
    "municipality",
    location.municipality,
    location.city,
    address.municipality,
    address.city,
    propertyData.municipality,
    propertyData.city,
    parsedFromStreet.city,
    parsedFromLocationAddress.city,
    parsedFromTitle.city
  );
  fillLocationField(
    "state",
    location.state,
    location.region,
    address.state,
    propertyData.state,
    parsedFromStreet.state,
    parsedFromLocationAddress.state
  );
  fillLocationField(
    "country",
    location.country,
    address.country,
    propertyData.country,
    "MX"
  );
  fillLocationField(
    "postal_code",
    location.postal_code,
    address.postal_code,
    address.geocoded_postal_code,
    propertyData.postal_code
  );
  fillLocationField(
    "name",
    location.name,
    location.full_name,
    buildEasyBrokerLocationName(location)
  );

  const street =
    cleanString(
      stuffedLooksFull
        ? address.street ?? parsedFromStreet.street ?? location.street
        : input.street
    ) ??
    cleanString(location.street) ??
    firstNonEmptyComparableString(
      address.street,
      propertyData.street,
      propertyData.calle,
      parsedFromStreet.street
    );

  let merged: EasyBrokerCreateListingInput = {
    ...input,
    ...(street ? { street } : {}),
    location: Object.keys(location).length > 0 ? location : input.location,
  };

  merged = fillEasyBrokerCreateInputFromPropertyData(merged, propertyData, zoneContext);
  return merged;
}

function fillEasyBrokerCreateInputFromPropertyData(
  input: EasyBrokerCreateListingInput,
  propertyData: Record<string, unknown>,
  zoneContext: Record<string, unknown> = {}
): EasyBrokerCreateListingInput {
  const next: EasyBrokerCreateListingInput = { ...input };
  const address = asRecord(propertyData.address) ?? {};
  const photoAnalysis = asRecord(propertyData.photo_analysis) ?? {};

  const fillNumber = (
    key:
      | "bedrooms"
      | "bathrooms"
      | "half_bathrooms"
      | "parking_spaces"
      | "floors"
      | "construction_size"
      | "lot_size"
      | "uncovered_space",
    ...values: unknown[]
  ) => {
    if (typeof next[key] === "number" && Number.isFinite(next[key])) return;
    for (const value of values) {
      const parsed = safeNumber(value);
      if (parsed != null && parsed >= 0) {
        next[key] = parsed;
        return;
      }
    }
  };

  fillNumber(
    "bedrooms",
    propertyData.bedrooms,
    propertyData.recamaras,
    propertyData.habitaciones
  );
  fillNumber(
    "bathrooms",
    propertyData.bathrooms,
    propertyData.banos,
    propertyData.baños
  );
  fillNumber("half_bathrooms", propertyData.half_bathrooms, propertyData.medios_banos);
  fillNumber(
    "parking_spaces",
    next.parking,
    propertyData.parking_spaces,
    propertyData.parking,
    propertyData.estacionamientos
  );
  fillNumber("floors", propertyData.floors, propertyData.niveles, propertyData.pisos);
  fillNumber(
    "construction_size",
    next.area_m2,
    propertyData.construction_size,
    propertyData.area_construida_m2,
    propertyData.construction_m2,
    propertyData.built_area_m2
  );
  fillNumber(
    "lot_size",
    propertyData.lot_size,
    propertyData.area_terreno_m2,
    propertyData.land_m2,
    propertyData.area_total_m2,
    propertyData.area_m2
  );
  fillNumber(
    "uncovered_space",
    propertyData.uncovered_space,
    propertyData.area_descubierta_m2
  );

  if (!nonEmptyStringArray(next.tags)) {
    const tagCandidates = [
      cleanString(asRecord(next.location)?.neighborhood),
      cleanString(asRecord(next.location)?.city),
      cleanString(asRecord(next.location)?.municipality),
      cleanString(address.neighborhood ?? address.colonia),
      cleanString(zoneContext.neighborhood),
      cleanString(propertyData.property_type),
    ].filter((value): value is string => Boolean(value));
    if (tagCandidates.length) next.tags = [...new Set(tagCandidates)];
  }

  const existingFeatures = nonEmptyStringArray(next.features) ?? [];
  const photoFeatures = [
    ...ensureStringArray(photoAnalysis.visible_features, 24),
    ...flattenFeaturesBySpace(parseFeaturesBySpace(photoAnalysis.features_by_space)),
  ];
  const mergedFeatures = [...new Set([...existingFeatures, ...photoFeatures])];
  if (mergedFeatures.length) next.features = mergedFeatures;

  return next;
}

async function enrichEasyBrokerCreateInputFromCaseContext(
  ctx: ToolContext,
  input: EasyBrokerCreateListingInput
): Promise<EasyBrokerCreateListingInput> {
  const caseId =
    (typeof input.case_id === "string" && input.case_id.trim()) ||
    (typeof ctx.caseId === "string" && ctx.caseId.trim()) ||
    "";
  if (!caseId) return input;

  const opCase = await getOperationalCase(ctx.db, caseId).catch(() => null);
  if (!opCase || opCase.user_id !== ctx.userId) return input;

  const context = asRecord(opCase.context_jsonb) ?? {};
  const propertyData = asRecord(context.property_data) ?? {};
  const address = asRecord(propertyData.address) ?? {};
  let enriched = mergeEasyBrokerCreateInputFromCaseSources(
    { ...input, case_id: caseId },
    {
      propertyData,
      zoneContext: asRecord(context.zone_context),
    }
  );

  // Deterministic internal_id for idempotent create/reconcile (max 15 chars).
  if (!sanitizeEasyBrokerInternalId(enriched.internal_id)) {
    const compact = caseId.replace(/[^A-Za-z0-9]/g, "").slice(0, 15);
    const derived = sanitizeEasyBrokerInternalId(compact);
    if (derived) enriched.internal_id = derived;
  }

  // Commercial mapping from neutral commission_terms (never mutates canon).
  const destinations = asRecord(asRecord(context.publication)?.destinations);
  const ebDest = asRecord(destinations?.easybroker);
  const commercialOverride = asRecord(ebDest?.commercial_override);
  const terms = parseCommissionTerms(context.commission_terms);
  const mapped = mapCollaborationToEasyBroker(terms);
  if (enriched.share_commission === undefined && mapped.share_commission !== undefined) {
    enriched.share_commission = mapped.share_commission;
  }
  if (
    enriched.shared_commission_percentage === undefined &&
    mapped.shared_commission_percentage !== undefined
  ) {
    enriched.shared_commission_percentage = mapped.shared_commission_percentage;
  }
  if (
    !cleanString(enriched.collaboration_notes) &&
    mapped.collaboration_notes
  ) {
    enriched.collaboration_notes = mapped.collaboration_notes;
  }
  if (enriched.commission === undefined && mapped.commission) {
    enriched.commission = mapped.commission;
  }
  if (enriched.exclusive === undefined && terms.exclusive != null) {
    enriched.exclusive = terms.exclusive;
  }
  // Explicit destination override (auditable); does not alter commission_terms.
  if (commercialOverride) {
    if (typeof commercialOverride.share_commission === "boolean") {
      enriched.share_commission = commercialOverride.share_commission;
    }
    if (
      commercialOverride.shared_commission_percentage === null ||
      commercialOverride.shared_commission_percentage === 50
    ) {
      enriched.shared_commission_percentage =
        commercialOverride.shared_commission_percentage as number | null;
    }
    const overrideCommission = asRecord(commercialOverride.commission);
    if (overrideCommission) {
      const type = cleanString(overrideCommission.type);
      const value = safeNumber(overrideCommission.value);
      if (
        (type === "percentage" || type === "amount" || type === "months") &&
        value != null &&
        value > 0
      ) {
        enriched.commission = {
          type,
          value,
          ...(typeof overrideCommission.currency === "string" &&
          overrideCommission.currency.trim()
            ? { currency: overrideCommission.currency.trim() }
            : {}),
        };
      }
    }
  }
  if (mapped.warnings.length > 0) {
    (enriched as EasyBrokerCreateListingInput & {
      mapping_warnings?: Array<{ code: string; message: string; actual?: unknown }>;
    }).mapping_warnings = mapped.warnings;
  }

  const location = asRecord(enriched.location) ?? {};
  if (
    isUsableLatLng(safeNumber(location.latitude), safeNumber(location.longitude))
  ) {
    return enriched;
  }

  const geocodeInput = {
    street:
      cleanString(enriched.street) ??
      cleanString(location.street) ??
      firstNonEmptyComparableString(address.street, propertyData.street),
    exterior_number:
      cleanString(location.exterior_number) ??
      firstNonEmptyComparableString(
        address.exterior_number,
        address.numero_exterior,
        propertyData.exterior_number
      ),
    neighborhood:
      cleanString(location.neighborhood) ??
      cleanString(location.city_area) ??
      firstNonEmptyComparableString(
        address.neighborhood,
        address.colonia,
        propertyData.neighborhood
      ),
    municipality:
      cleanString(location.city) ??
      cleanString(location.municipality) ??
      firstNonEmptyComparableString(
        address.municipality,
        address.city,
        propertyData.municipality,
        propertyData.city
      ),
    state:
      cleanString(location.state) ??
      cleanString(location.region) ??
      firstNonEmptyComparableString(address.state, propertyData.state),
    postal_code:
      cleanString(location.postal_code) ??
      firstNonEmptyComparableString(
        address.postal_code,
        address.geocoded_postal_code,
        propertyData.postal_code
      ),
    country:
      cleanString(location.country) ??
      firstNonEmptyComparableString(address.country, propertyData.country) ??
      "MX",
  };
  const filledComponents = [
    geocodeInput.street,
    geocodeInput.neighborhood,
    geocodeInput.municipality,
    geocodeInput.state,
    geocodeInput.postal_code,
  ].filter((item) => typeof item === "string" && item.trim().length > 0).length;
  if (filledComponents < 2) return enriched;

  try {
    const geocodeOut = await geocodePropertyAddress(geocodeInput);
    if (
      !geocodeOut.ok ||
      geocodeOut.status !== "ok" ||
      !isUnequivocalGeocodeForAvaclick(geocodeOut) ||
      typeof geocodeOut.latitude !== "number" ||
      typeof geocodeOut.longitude !== "number" ||
      !isUsableLatLng(geocodeOut.latitude, geocodeOut.longitude)
    ) {
      return enriched;
    }

    enriched = {
      ...enriched,
      location: {
        ...(asRecord(enriched.location) ?? {}),
        latitude: geocodeOut.latitude,
        longitude: geocodeOut.longitude,
      },
    };

    // Persist when we can attribute the case (ctx.caseId or input.case_id).
    if (geocodeOut.confidence === "high") {
      const persistCtx =
        ctx.caseId === caseId ? ctx : { ...ctx, caseId };
      await persistGeocodeResultToCaseContext(persistCtx, geocodeInput, {
        latitude: geocodeOut.latitude,
        longitude: geocodeOut.longitude,
        formatted_address: geocodeOut.formatted_address,
        provider: geocodeOut.provider,
        confidence: geocodeOut.confidence,
        candidates: geocodeOut.candidates,
      });
    }
  } catch (err) {
    console.warn(
      "[realestate] easybroker_create_listing: geocode enrichment failed:",
      err
    );
  }

  return enriched;
}

async function createEasyBrokerListing(
  ctx: ToolContext,
  input: EasyBrokerCreateListingInput,
  creds: EasyBrokerCredentials,
  prebuilt?: EasyBrokerCreatePayloadBuildResult
) {
  const built =
    prebuilt ??
    buildEasyBrokerCreatePayload(input, { catalogFeatureNames: null });
  const payload = built.payload;
  if (input.dry_run) {
    return {
      ok: true,
      status: "dry_run",
      credential_source: creds.source,
      payload,
      dropped_fields: built.dropped_fields,
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
    dropped_fields: built.dropped_fields,
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

  let remoteImageCount: number | null = images.length;
  let imagesStatus: "submitted" | "verified" = "submitted";
  try {
    const verified = await pollEasyBrokerRemoteImageCount(
      creds,
      input.listing_id,
      images.length
    );
    if (verified != null) {
      remoteImageCount = verified;
      if (verified >= images.length) imagesStatus = "verified";
    }
  } catch {
    // keep submitted; runner will wait_remote_media
  }

  return {
    ok: true,
    status: "images_submitted",
    credential_source: creds.source,
    listing_id: input.listing_id,
    count: images.length,
    remote_count: remoteImageCount,
    images_status: imagesStatus,
    images,
    caveat:
      "EasyBroker procesa imágenes de forma asíncrona. En PATCH, el arreglo images reemplaza las imágenes existentes de la propiedad.",
    raw: truncatePayload(response.payload),
  };
}

async function pollEasyBrokerRemoteImageCount(
  creds: EasyBrokerCredentials,
  listingId: string,
  expected: number
): Promise<number | null> {
  const delays = [0, 1500, 3000];
  let lastCount: number | null = null;
  for (const delay of delays) {
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    const response = await easyBrokerApiRequest(
      creds,
      `/v1/properties/${encodeURIComponent(listingId)}`,
      { method: "GET" }
    );
    const payload = asRecord(response.payload) ?? {};
    const images = Array.isArray(payload.images) ? payload.images : null;
    if (images) {
      lastCount = images.length;
      if (images.length >= expected) return images.length;
    }
  }
  return lastCount;
}

export type EasyBrokerDroppedField = {
  field: string;
  reason: string;
  value?: unknown;
};

export type EasyBrokerCreatePayloadBuildResult = {
  payload: Record<string, unknown>;
  dropped_fields: EasyBrokerDroppedField[];
};

/** OpenAPI PropertyBody top-level keys permitted on POST /v1/properties. */
export const EASYBROKER_CREATE_TOP_LEVEL_ALLOWLIST = [
  "property_type",
  "title",
  "description",
  "status",
  "private_description",
  "operations",
  "agent",
  "show_prices",
  "bedrooms",
  "bathrooms",
  "half_bathrooms",
  "parking_spaces",
  "age",
  "floor",
  "floors",
  "expenses",
  "internal_id",
  "location",
  "tags",
  "features",
  "share_commission",
  "collaboration_notes",
  "images",
  "videos",
  "virtual_tour",
  "show_exact_location",
  "construction_size",
  "lot_size",
  "lot_length",
  "lot_width",
  "covered_space",
  "uncovered_space",
  "exclusive",
  "shared_commission_percentage",
] as const;

/** OpenAPI PropertyLocationBody keys permitted on create. */
export const EASYBROKER_CREATE_LOCATION_ALLOWLIST = [
  "name",
  "street",
  "exterior_number",
  "interior_number",
  "cross_street",
  "postal_code",
  "latitude",
  "longitude",
] as const;

const EASYBROKER_FEATURE_CATALOG_TTL_MS = 10 * 60 * 1000;
const easyBrokerFeatureCatalogCache = new Map<
  string,
  { names: string[]; fetchedAt: number }
>();

/**
 * Builds an allowlisted EasyBroker create payload. Never spreads custom_fields.
 * Features are included only when they match the account catalog (exact/normalized).
 */
export function buildEasyBrokerCreatePayload(
  input: EasyBrokerCreateListingInput,
  options: { catalogFeatureNames?: string[] | null } = {}
): EasyBrokerCreatePayloadBuildResult {
  const dropped_fields: EasyBrokerDroppedField[] = [];
  const drop = (field: string, reason: string, value?: unknown) => {
    dropped_fields.push({ field, reason, ...(value !== undefined ? { value } : {}) });
  };

  const customFields = parseEasyBrokerCustomFields(input);
  for (const [key, value] of Object.entries(customFields)) {
    drop(`custom_fields.${key}`, "custom_fields_passthrough_disabled", value);
  }
  if (input.covered_space !== undefined) {
    drop("covered_space", "not_available_in_mexico", input.covered_space);
  }

  // Defensa en profundidad: aunque el enrich del caso no haya corrido, deriva
  // colonia/ciudad/estado desde street/title antes de exigir location.name.
  const normalized = mergeEasyBrokerCreateInputFromCaseSources(input, {});
  const location = normalized.location ?? {};
  const streetRaw =
    cleanString(normalized.street) ??
    cleanString(location.street) ??
    cleanString(location.address) ??
    cleanString(input.street);
  if (!streetRaw) {
    throw new Error(
      "easybroker_create_listing requiere `street` o `location.street` para crear la propiedad."
    );
  }
  if (!normalized.location || Object.keys(normalized.location).length === 0) {
    throw new Error(
      "easybroker_create_listing requiere `location` con la ubicación registrada/compatible con EasyBroker."
    );
  }
  const street = sanitizeEasyBrokerStreet(streetRaw, location);
  if (street !== streetRaw) {
    drop("street", "normalized_full_address_to_street", streetRaw);
  }

  const { payload: easyBrokerLocation, dropped: locationDropped } =
    buildEasyBrokerLocationPayload(location, street);
  dropped_fields.push(...locationDropped);
  if (
    easyBrokerLocation.latitude === undefined ||
    easyBrokerLocation.longitude === undefined
  ) {
    throw new Error(
      "easybroker_create_listing requiere `location.latitude` y `location.longitude` para que EasyBroker geolocalice la propiedad. Alternativa futura: integrar lookup de city_id/administrative_division_id vía /v1/locations."
    );
  }
  if (!cleanString(easyBrokerLocation.name)) {
    throw new Error(
      "easybroker_create_listing requiere `location.name` (p. ej. \"Colonia, Ciudad, Estado\") compatible con /v1/locations."
    );
  }

  const operationTypeMap: Record<string, string> = {
    sale: "sale",
    rent: "rental",
    rental: "rental",
    temporary_rental: "temporary_rental",
  };
  const operationType = operationTypeMap[input.operation] ?? input.operation;
  const title = sanitizeEasyBrokerTitle(input.title);
  if (title !== input.title) {
    drop("title", "truncated_to_easybroker_max_80", input.title);
  }

  const operation: Record<string, unknown> = {
    type: operationType,
    amount: input.price,
    currency: input.currency ?? "MXN",
    active: true,
    unit: "total",
  };
  const commission = sanitizeEasyBrokerCommission(input.commission);
  if (commission) {
    operation.commission = commission;
  } else if (input.commission !== undefined) {
    drop("commission", "invalid_commission_object", input.commission);
  }

  const payload: Record<string, unknown> = {
    property_type: input.property_type,
    title,
    description: input.description.slice(0, 4000),
    status: input.status ?? "not_published",
    location: easyBrokerLocation,
    operations: [operation],
  };

  setIfPresent(payload, "private_description", cleanString(normalized.private_description ?? input.private_description));
  const agent = cleanString(normalized.agent ?? input.agent);
  if (agent) {
    if (isEasyBrokerAgentEmail(agent)) {
      payload.agent = agent;
    } else {
      drop("agent", "must_be_easybroker_account_email", agent);
    }
  }
  setIfPresent(payload, "show_prices", input.show_prices);
  setIfPresent(payload, "bedrooms", integerOrUndefined(input.bedrooms));
  setIfPresent(payload, "bathrooms", integerOrUndefined(input.bathrooms));
  setIfPresent(payload, "half_bathrooms", integerOrUndefined(input.half_bathrooms));
  setIfPresent(
    payload,
    "parking_spaces",
    integerOrUndefined(input.parking_spaces ?? input.parking)
  );

  const age = sanitizeEasyBrokerAge(input.age);
  if (age) payload.age = age;
  else if (cleanString(input.age)) drop("age", "invalid_age_value", input.age);

  const floor = cleanEasyBrokerOptionalString(input.floor);
  if (floor) payload.floor = floor;
  else if (cleanString(input.floor)) drop("floor", "placeholder_or_empty", input.floor);

  setIfPresent(payload, "floors", positiveIntegerOrUndefined(input.floors));

  const expenses = cleanEasyBrokerOptionalString(input.expenses);
  if (expenses) payload.expenses = expenses;
  else if (cleanString(input.expenses)) {
    drop("expenses", "placeholder_or_empty", input.expenses);
  }

  const internalIdRaw = cleanString(input.internal_id);
  if (internalIdRaw) {
    const internalId = sanitizeEasyBrokerInternalId(internalIdRaw);
    if (internalId) payload.internal_id = internalId;
    else drop("internal_id", "invalid_or_exceeds_max_length_15", internalIdRaw);
  }
  setIfPresent(payload, "tags", nonEmptyStringArray(input.tags));

  const featureCandidates = nonEmptyStringArray(input.features) ?? [];
  const { matched: matchedFeatures, dropped: featureDropped } =
    filterFeaturesAgainstCatalog(featureCandidates, options.catalogFeatureNames ?? null);
  dropped_fields.push(...featureDropped);
  setIfPresent(payload, "features", matchedFeatures.length ? matchedFeatures : undefined);

  setIfPresent(payload, "share_commission", input.share_commission);
  setIfPresent(payload, "collaboration_notes", cleanString(input.collaboration_notes));

  if (input.shared_commission_percentage === null) {
    payload.shared_commission_percentage = null;
  } else if (input.shared_commission_percentage === 50) {
    payload.shared_commission_percentage = 50;
  } else if (input.shared_commission_percentage !== undefined) {
    drop(
      "shared_commission_percentage",
      "only_50_or_null_allowed",
      input.shared_commission_percentage
    );
  }

  setIfPresent(
    payload,
    "construction_size",
    positiveNumberOrUndefined(input.construction_size ?? input.area_m2)
  );
  setIfPresent(payload, "lot_size", positiveNumberOrUndefined(input.lot_size));
  setIfPresent(payload, "lot_length", positiveIntegerOrUndefined(input.lot_length));
  setIfPresent(payload, "lot_width", positiveIntegerOrUndefined(input.lot_width));
  setIfPresent(
    payload,
    "uncovered_space",
    positiveNumberOrUndefined(input.uncovered_space)
  );
  if (input.exclusive !== undefined) payload.exclusive = input.exclusive;
  setIfPresent(payload, "videos", nonEmptyStringArray(input.videos));
  setIfPresent(payload, "virtual_tour", cleanString(input.virtual_tour));
  setIfPresent(payload, "show_exact_location", input.show_exact_location ?? false);

  for (const key of Object.keys(payload)) {
    if (
      !(EASYBROKER_CREATE_TOP_LEVEL_ALLOWLIST as readonly string[]).includes(key)
    ) {
      drop(key, "not_in_top_level_allowlist", payload[key]);
      delete payload[key];
    }
  }

  return { payload, dropped_fields };
}

function sanitizeEasyBrokerAge(value: unknown): string | undefined {
  const age = cleanEasyBrokerOptionalString(value);
  if (!age) return undefined;
  if (age === "under_construction" || age === "new_construction") return age;
  if (/^\d{4}$/.test(age)) return age;
  return undefined;
}

/**
 * EasyBroker operations[].commission: type ∈ percentage|amount|months.
 * Percentage values must be in (0, 100]; amount/months require positive value.
 */
function sanitizeEasyBrokerCommission(
  value: unknown
): { type: "percentage" | "amount" | "months"; value: number; currency?: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const type = cleanString(record.type);
  const amount = safeNumber(record.value);
  if (
    (type !== "percentage" && type !== "amount" && type !== "months") ||
    amount == null ||
    amount <= 0
  ) {
    return undefined;
  }
  if (type === "percentage" && amount > 100) return undefined;
  const currency = cleanString(record.currency);
  return {
    type,
    value: amount,
    ...(type === "amount" && currency ? { currency } : {}),
  };
}

/** EasyBroker enforces max 15 chars and a restricted charset for internal_id. */
const EASYBROKER_INTERNAL_ID_MAX_LENGTH = 15;

function sanitizeEasyBrokerInternalId(value: unknown): string | undefined {
  const id = cleanString(value);
  if (!id) return undefined;
  if (!/^[A-Za-z0-9\-_.,&/]+$/.test(id)) return undefined;
  if (id.length > EASYBROKER_INTERNAL_ID_MAX_LENGTH) return undefined;
  return id;
}

/** Treat LLM placeholders like N/D as absent optional strings. */
function cleanEasyBrokerOptionalString(value: unknown): string | undefined {
  const cleaned = cleanString(value);
  if (!cleaned) return undefined;
  const normalized = cleaned
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  if (
    !normalized ||
    normalized === "nd" ||
    normalized === "na" ||
    normalized === "nainfo" ||
    normalized === "none" ||
    normalized === "null" ||
    normalized === "undefined" ||
    normalized === "unknown" ||
    normalized === "sdatos" ||
    normalized === "sindato" ||
    normalized === "sindatos"
  ) {
    return undefined;
  }
  return cleaned;
}

/**
 * LLM often stuffs the full address into `street`. Keep the street line only
 * and strip a trailing exterior number when it is already sent separately.
 */
function sanitizeEasyBrokerStreet(
  street: string,
  location: EasyBrokerListingLocationInput
): string {
  const parsed = parseMexicanAddressParts(street);
  let cleaned =
    cleanString(parsed.street) ??
    (street.includes(",") ? street.split(",")[0]!.trim() : street.trim());
  const exterior =
    cleanString(location.exterior_number) ?? cleanString(parsed.exterior_number);
  if (exterior) {
    const escaped = exterior.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    cleaned = cleaned.replace(new RegExp(`\\s+${escaped}$`, "i"), "").trim();
  }
  return cleaned || street.trim();
}

function buildEasyBrokerLocationName(
  location: EasyBrokerListingLocationInput
): string | undefined {
  const explicit =
    cleanString(location.full_name) ?? cleanString(location.name);
  if (explicit) return explicit;
  const city =
    cleanString(location.city) ?? cleanString(location.municipality);
  const composed = [
    location.city_area ?? location.neighborhood,
    city,
    location.region ?? location.state,
  ]
    .map(cleanString)
    .filter(Boolean)
    .join(", ");
  return composed || undefined;
}

const MEXICAN_STATE_NAMES = new Set(
  [
    "aguascalientes",
    "baja california",
    "baja california sur",
    "campeche",
    "chiapas",
    "chihuahua",
    "ciudad de mexico",
    "cdmx",
    "coahuila",
    "colima",
    "durango",
    "guanajuato",
    "guerrero",
    "hidalgo",
    "jalisco",
    "mexico",
    "estado de mexico",
    "michoacan",
    "morelos",
    "nayarit",
    "nuevo leon",
    "oaxaca",
    "puebla",
    "queretaro",
    "quintana roo",
    "san luis potosi",
    "sinaloa",
    "sonora",
    "tabasco",
    "tamaulipas",
    "tlaxcala",
    "veracruz",
    "yucatan",
    "zacatecas",
  ].map((value) => normalizeEasyBrokerFeatureKey(value))
);

function titleCaseWords(value: string): string {
  const words = value
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  return words
    .map((word, index) =>
      index === 0 || !/^(de|del|la|las|los|y|en)$/i.test(word)
        ? word.charAt(0).toUpperCase() + word.slice(1)
        : word.toLowerCase()
    )
    .join(" ");
}

/**
 * Best-effort parse of Mexican full-address strings the LLM often puts in
 * `street` (e.g. "CALLE X, NUMERO 3668, FRACCIONAMIENTO Y, ZAPOPAN, JALISCO").
 */
export function parseMexicanAddressParts(raw: string): {
  street?: string;
  exterior_number?: string;
  neighborhood?: string;
  city?: string;
  state?: string;
} {
  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) return {};
  if (parts.length === 1) {
    const only = parts[0]!;
    const withNumber = only.match(/^(.*?)[\s]+(\d+[A-Za-z]?)$/);
    if (withNumber?.[1] && withNumber[2]) {
      return {
        street: titleCaseWords(withNumber[1].replace(/^(calle|av\.?|avenida)\s+/i, "").trim() || withNumber[1]),
        exterior_number: withNumber[2],
      };
    }
    return { street: only };
  }

  const working = [...parts];
  let state: string | undefined;
  let city: string | undefined;
  let neighborhood: string | undefined;
  let exterior_number: string | undefined;

  const last = working[working.length - 1]!;
  if (MEXICAN_STATE_NAMES.has(normalizeEasyBrokerFeatureKey(last))) {
    state = titleCaseWords(last);
    working.pop();
  }
  if (working.length) {
    city = titleCaseWords(working.pop()!);
  }

  for (let i = working.length - 1; i >= 0; i -= 1) {
    const part = working[i]!;
    const numeroMatch = part.match(/^(?:numero|n[uú]mero|no\.?|#)\s*(.+)$/i);
    if (numeroMatch?.[1]) {
      exterior_number = numeroMatch[1].trim();
      working.splice(i, 1);
      continue;
    }
    if (/^\d+[A-Za-z]?$/.test(part)) {
      exterior_number = part;
      working.splice(i, 1);
      continue;
    }
    const neighborhoodMatch = part.match(
      /^(?:fraccionamiento|fracc\.?|colonia|col\.?|residencial|privada)\s+(.+)$/i
    );
    if (neighborhoodMatch?.[1]) {
      neighborhood = titleCaseWords(neighborhoodMatch[1]);
      working.splice(i, 1);
    }
  }

  if (!neighborhood && working.length > 1) {
    neighborhood = titleCaseWords(working.pop()!);
  }

  let street = working.join(" ").trim() || undefined;
  if (street) {
    street = street.replace(/^(calle|av\.?|avenida)\s+/i, "").trim() || street;
    if (!exterior_number) {
      const withNumber = street.match(/^(.*?)[\s]+(\d+[A-Za-z]?)$/);
      if (withNumber?.[1] && withNumber[2]) {
        street = withNumber[1].trim();
        exterior_number = withNumber[2];
      }
    }
    street = titleCaseWords(street);
  }

  return {
    ...(street ? { street } : {}),
    ...(exterior_number ? { exterior_number } : {}),
    ...(neighborhood ? { neighborhood } : {}),
    ...(city ? { city } : {}),
    ...(state ? { state } : {}),
  };
}

function parseLocationHintFromListingTitle(title: string): {
  neighborhood?: string;
  city?: string;
} {
  const match = title.match(
    /\ben\s+(?:fraccionamiento|fracc\.?|colonia|col\.?)?\s*([^,]+),\s*([A-Za-zÁÉÍÓÚÜáéíóúüñÑ\s]+?)(?:\s*$|\s*[.|-])/i
  );
  if (!match?.[1] || !match[2]) return {};
  return {
    neighborhood: titleCaseWords(match[1].trim()),
    city: titleCaseWords(match[2].trim()),
  };
}

function parseEasyBrokerCustomFields(input: EasyBrokerCreateListingInput) {
  const custom: Record<string, unknown> = { ...(input.custom_fields ?? {}) };
  if (input.custom_fields_json?.trim()) {
    try {
      const parsed = JSON.parse(input.custom_fields_json) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        Object.assign(custom, parsed as Record<string, unknown>);
      }
    } catch {
      // Ignore invalid JSON; create should not fail solely on ignored custom fields.
    }
  }
  return custom;
}

function buildEasyBrokerLocationPayload(
  location: EasyBrokerListingLocationInput,
  street?: string
): { payload: Record<string, unknown>; dropped: EasyBrokerDroppedField[] } {
  const dropped: EasyBrokerDroppedField[] = [];
  const payload: Record<string, unknown> = {};
  const enrichedLocation: EasyBrokerListingLocationInput = { ...location };
  if (!buildEasyBrokerLocationName(enrichedLocation)) {
    const parsed = parseMexicanAddressParts(
      cleanString(street) ??
        cleanString(location.street) ??
        cleanString(location.address) ??
        ""
    );
    if (!cleanString(enrichedLocation.neighborhood) && parsed.neighborhood) {
      enrichedLocation.neighborhood = parsed.neighborhood;
    }
    if (!cleanString(enrichedLocation.city) && parsed.city) {
      enrichedLocation.city = parsed.city;
    }
    if (!cleanString(enrichedLocation.municipality) && parsed.city) {
      enrichedLocation.municipality = parsed.city;
    }
    if (!cleanString(enrichedLocation.state) && parsed.state) {
      enrichedLocation.state = parsed.state;
    }
    if (!cleanString(enrichedLocation.exterior_number) && parsed.exterior_number) {
      enrichedLocation.exterior_number = parsed.exterior_number;
    }
  }
  const locationName = buildEasyBrokerLocationName(enrichedLocation);
  setIfPresent(payload, "name", locationName);
  setIfPresent(payload, "street", cleanString(street));
  setIfPresent(
    payload,
    "exterior_number",
    cleanString(enrichedLocation.exterior_number)
  );
  setIfPresent(payload, "interior_number", cleanString(enrichedLocation.interior_number));
  setIfPresent(payload, "cross_street", cleanString(enrichedLocation.cross_street));
  setIfPresent(payload, "postal_code", cleanString(enrichedLocation.postal_code));
  const latitude = safeNumber(enrichedLocation.latitude);
  const longitude = safeNumber(enrichedLocation.longitude);
  if (isUsableLatLng(latitude, longitude)) {
    payload.latitude = latitude;
    payload.longitude = longitude;
  }

  for (const [key, value] of Object.entries(location)) {
    if (
      (EASYBROKER_CREATE_LOCATION_ALLOWLIST as readonly string[]).includes(key)
    ) {
      continue;
    }
    // Helper aliases used only to build `name` / enrich — not sent to EasyBroker.
    if (
      [
        "neighborhood",
        "city",
        "municipality",
        "state",
        "region",
        "country",
        "city_area",
        "full_name",
        "type",
        "address",
      ].includes(key)
    ) {
      continue;
    }
    dropped.push({
      field: `location.${key}`,
      reason: "not_in_location_allowlist",
      value,
    });
  }

  return { payload, dropped };
}

function normalizeEasyBrokerFeatureKey(value: string) {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function sanitizeEasyBrokerTitle(value: string): string {
  const clean = value.trim().replace(/\s+/g, " ");
  if (clean.length <= 80) return clean;
  const sliced = clean.slice(0, 80);
  const lastSpace = sliced.lastIndexOf(" ");
  const shortened = lastSpace >= 56 ? sliced.slice(0, lastSpace) : sliced;
  return shortened.replace(/[\s,;:.-]+$/g, "");
}

function normalizedLocationToken(value: unknown): string {
  return normalizeEasyBrokerFeatureKey(cleanString(value) ?? "").replace(
    /^(?:venta\s+en\s+)?(?:(?:fraccionamiento|colonia|residencial)\s+)?/,
    ""
  );
}

function collectEasyBrokerLocationFullNames(
  value: unknown,
  output: Set<string>,
  depth = 0
): void {
  if (depth > 8 || value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      collectEasyBrokerLocationFullNames(item, output, depth + 1);
    }
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  const fullName = cleanString(record.full_name);
  if (fullName) output.add(fullName);
  for (const child of Object.values(record)) {
    if (child && typeof child === "object") {
      collectEasyBrokerLocationFullNames(child, output, depth + 1);
    }
  }
}

export function selectEasyBrokerLocationFullName(
  location: EasyBrokerListingLocationInput,
  catalogFullNames: string[]
): string | null {
  const nameNeighborhood =
    cleanString(location.name)?.split(",")[0]?.trim() ?? null;
  const neighborhood = normalizedLocationToken(
    location.neighborhood ?? location.city_area ?? nameNeighborhood
  );
  const city = normalizedLocationToken(location.city ?? location.municipality);
  const state = normalizedLocationToken(location.state);
  const explicit = normalizedLocationToken(
    location.full_name ?? location.name
  );
  const scored = catalogFullNames
    .map((fullName) => {
      const normalized = normalizedLocationToken(fullName);
      const firstSegment = normalizedLocationToken(fullName.split(",")[0]);
      if (!normalized) return null;
      if (neighborhood && !normalized.includes(neighborhood)) return null;
      let score = normalized.split(" ").length;
      if (explicit && normalized === explicit) score += 1000;
      if (neighborhood && firstSegment === neighborhood) score += 500;
      if (neighborhood && normalized.includes(neighborhood)) score += 200;
      if (city && normalized.includes(city)) score += 50;
      if (state && normalized.includes(state)) score += 20;
      return { fullName, score };
    })
    .filter(
      (entry): entry is { fullName: string; score: number } => entry != null
    )
    .sort((a, b) => b.score - a.score);
  return scored[0]?.fullName ?? null;
}

async function resolveEasyBrokerCreateLocationName(
  creds: EasyBrokerCredentials,
  input: EasyBrokerCreateListingInput
): Promise<EasyBrokerCreateListingInput> {
  const location = input.location ?? {};
  const searchTerms = [
    cleanString(location.full_name),
    buildEasyBrokerLocationName(location),
    cleanString(location.neighborhood ?? location.city_area),
    cleanString(location.city ?? location.municipality),
    cleanString(location.state),
  ].filter((value): value is string => Boolean(value));
  const catalogFullNames = new Set<string>();
  for (const query of [...new Set(searchTerms)]) {
    try {
      const response = await easyBrokerApiRequest(creds, "/v1/locations", {
        method: "GET",
        query: { query },
      });
      collectEasyBrokerLocationFullNames(
        response.payload,
        catalogFullNames
      );
    } catch {
      // Try the next, broader location term.
    }
  }
  const city = normalizedLocationToken(location.city ?? location.municipality);
  const state = normalizedLocationToken(location.state);
  const cityFullName = [...catalogFullNames].find((fullName) => {
    const firstSegment = normalizedLocationToken(fullName.split(",")[0]);
    const normalized = normalizedLocationToken(fullName);
    return firstSegment === city && (!state || normalized.includes(state));
  });
  if (cityFullName) {
    try {
      const response = await easyBrokerApiRequest(creds, "/v1/locations", {
        method: "GET",
        query: { query: cityFullName },
      });
      collectEasyBrokerLocationFullNames(
        response.payload,
        catalogFullNames
      );
    } catch {
      // Keep the already discovered parent locations as a fallback.
    }
  }
  const resolved = selectEasyBrokerLocationFullName(location, [
    ...catalogFullNames,
  ]);
  if (!resolved) return input;
  return {
    ...input,
    location: {
      ...location,
      name: resolved,
      full_name: resolved,
    },
  };
}

export function filterFeaturesAgainstCatalog(
  candidates: string[],
  catalogNames: string[] | null
): { matched: string[]; dropped: EasyBrokerDroppedField[] } {
  const uniqueCandidates = [
    ...new Set(
      candidates
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean)
    ),
  ];
  if (!uniqueCandidates.length) return { matched: [], dropped: [] };
  if (!catalogNames) {
    return {
      matched: [],
      dropped: uniqueCandidates.map((value) => ({
        field: "features",
        reason: "feature_catalog_unavailable",
        value,
      })),
    };
  }
  const byNorm = new Map(
    catalogNames.map((name) => [normalizeEasyBrokerFeatureKey(name), name] as const)
  );
  const matched: string[] = [];
  const dropped: EasyBrokerDroppedField[] = [];
  const seen = new Set<string>();
  for (const candidate of uniqueCandidates) {
    const catalogName = byNorm.get(normalizeEasyBrokerFeatureKey(candidate));
    if (!catalogName) {
      dropped.push({
        field: "features",
        reason: "not_in_easybroker_feature_catalog",
        value: candidate,
      });
      continue;
    }
    if (seen.has(catalogName)) continue;
    seen.add(catalogName);
    matched.push(catalogName);
  }
  return { matched, dropped };
}

async function fetchEasyBrokerFeatureCatalogNames(
  creds: EasyBrokerCredentials
): Promise<string[] | null> {
  const cacheKey = creds.apiKey.slice(0, 12);
  const cached = easyBrokerFeatureCatalogCache.get(cacheKey);
  if (
    cached &&
    Date.now() - cached.fetchedAt < EASYBROKER_FEATURE_CATALOG_TTL_MS
  ) {
    return cached.names;
  }
  try {
    const names: string[] = [];
    let page = 1;
    for (let i = 0; i < 20; i += 1) {
      const response = await easyBrokerApiRequest(creds, "/v1/features", {
        method: "GET",
        query: { page, limit: 100, locale: "es" },
      });
      const content = Array.isArray(response.payload.content)
        ? response.payload.content
        : [];
      for (const item of content) {
        const name =
          item && typeof item === "object" && !Array.isArray(item)
            ? cleanString((item as Record<string, unknown>).name)
            : undefined;
        if (name) names.push(name);
      }
      const pagination = asRecord(response.payload.pagination);
      const nextPage = pagination?.next_page;
      if (nextPage == null || nextPage === "") break;
      const nextPageNum =
        typeof nextPage === "number"
          ? nextPage
          : typeof nextPage === "string"
            ? Number(nextPage)
            : NaN;
      if (!Number.isFinite(nextPageNum) || nextPageNum <= page) break;
      page = nextPageNum;
    }
    const unique = [...new Set(names)];
    easyBrokerFeatureCatalogCache.set(cacheKey, {
      names: unique,
      fetchedAt: Date.now(),
    });
    return unique;
  } catch (err) {
    console.warn(
      "[realestate] easybroker_create_listing: feature catalog fetch failed; omitting features:",
      err
    );
    return null;
  }
}

async function resolveEasyBrokerImagePayloads(
  ctx: ToolContext,
  input: EasyBrokerUploadImagesInput
): Promise<EasyBrokerImagePayload[]> {
  const pairs = normalizeEasyBrokerUploadPairs(input);
  if (pairs.length === 0) {
    throw new Error(
      "Se requiere images con pares {source_path, upload_path, title} o case_id con photo_manifest."
    );
  }
  if (pairs.length > 50) {
    throw new Error("EasyBroker permite máximo 50 imágenes por propiedad.");
  }
  const images = await Promise.all(
    pairs.map(async (pair) => {
      const imagePath = pair.upload_path;
      const title = pair.title?.trim() || null;
      if (/^https?:\/\//i.test(imagePath)) {
        return { url: imagePath, title, source_path: pair.source_path };
      }
      const parsed = parseStoragePath(imagePath);
      const shortUrl = await publicAccountAssetUrlForEasyBroker(ctx, parsed);
      if (shortUrl) {
        return {
          url: shortUrl,
          title,
          source_path: pair.source_path,
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
        source_path: pair.source_path,
        expires_in_seconds: EASYBROKER_SIGNED_URL_TTL_SECONDS,
      };
    })
  );
  return images;
}

export function normalizeEasyBrokerUploadPairs(
  input: {
    images?: PhotoUploadPair[];
    image_paths?: string[];
    image_titles?: string[];
  }
): PhotoUploadPair[] {
  return (
    input.images && input.images.length > 0
      ? input.images
      : (input.image_paths ?? []).map((uploadPath, index) => ({
          source_path: normalizePhotoSourcePath(uploadPath),
          upload_path: uploadPath,
          title: input.image_titles?.[index]?.trim() || null,
        }))
  );
}

async function publicAccountAssetUrlForEasyBroker(
  ctx: ToolContext,
  parsed: { bucket: string; path: string }
) {
  const siteUrl = publicSiteUrl();
  if (!siteUrl) return null;
  let asset = await getAccountAssetByStoragePath(ctx.db, {
    storageBucket: parsed.bucket,
    storagePath: parsed.path,
  });
  // Case photos live in case-documents and usually have no account_assets row.
  // Upsert a lightweight pointer so EasyBroker gets a short public redirect URL
  // (≤255 chars) instead of a long Supabase signed URL.
  if (!asset) {
    const digest = createHash("sha256")
      .update(`${parsed.bucket}:${parsed.path}`)
      .digest("hex")
      .slice(0, 24);
    const basename = path.basename(parsed.path) || "image";
    asset = await upsertAccountAsset(ctx.db, {
      userId: ctx.userId,
      assetKey: `easybroker_image__${digest}`,
      displayName: basename.slice(0, 120),
      storageBucket: parsed.bucket,
      storagePath: parsed.path,
      sourceToolId: "easybroker_upload_images",
      metadata: {
        purpose: "easybroker_public_image",
        source_bucket: parsed.bucket,
      },
    });
  }
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
  options: {
    method: "GET" | "POST" | "PATCH";
    body?: Record<string, unknown>;
    query?: Record<string, string | number | undefined>;
  }
) {
  const base = process.env.EASYBROKER_API_BASE?.trim() || "https://api.easybroker.com";
  const url = new URL(pathname, base.replace(/\/$/, ""));
  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, String(value));
    }
  }
  const headers: Record<string, string> = {
    accept: "application/json",
    "Country-Code": "MX",
    "X-Authorization": creds.apiKey,
  };
  if (options.body) {
    headers["content-type"] = "application/json";
  }
  const res = await fetch(url, {
    method: options.method,
    headers,
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
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

function positiveIntegerOrUndefined(value: unknown) {
  const parsed = integerOrUndefined(value);
  return parsed != null && parsed > 0 ? parsed : undefined;
}

function numberOrUndefined(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function positiveNumberOrUndefined(value: unknown) {
  const parsed = numberOrUndefined(value);
  return parsed != null && parsed > 0 ? parsed : undefined;
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
  // Keep the browser revision outside ephemeral Cursor/TEMP caches. The same
  // path is used by `npm run setup:pocs`; Cloud Run images may override it
  // with their baked browser directory.
  childEnv.PLAYWRIGHT_BROWSERS_PATH =
    process.env.POC_PLAYWRIGHT_BROWSERS_PATH ??
    path.resolve(pocDir, "..", "..", ".cache", "ms-playwright");
  if (cliCreds) {
    childEnv.UNGGA_STAGING_URL = cliCreds.loginUrl;
    childEnv.UNGGA_STAGING_EMAIL = cliCreds.email;
    childEnv.UNGGA_STAGING_PASSWORD = cliCreds.password;
    childEnv.UNGGA_CLI_ENABLED = "true";
  }
  // Real writes unless explicitly testing dry-run.
  if (envFlagEnabled("UNGGA_TOOL_TEST_DRY_RUN")) {
    childEnv.UNGGA_CLI_DRY_RUN = "true";
  } else if (envFlagEnabled("UNGGA_CLI_DRY_RUN") == null) {
    childEnv.UNGGA_CLI_DRY_RUN = "false";
  }

  const tempDir = await mkdtemp(path.join(tmpdir(), "ungga-cli-"));
  const inputPath = path.join(tempDir, "listing.json");
  await writeFile(inputPath, JSON.stringify(input), "utf8");

  try {
    const timeout = Number(
      process.env.UNGGA_CLI_TOTAL_TIMEOUT_MS ??
        process.env.UNGGA_CLI_TIMEOUT_MS ??
        "300000"
    );
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["src/publish-listing.mjs", inputPath],
      {
        cwd: pocDir,
        timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : 300_000,
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
      signal?: string;
      killed?: boolean;
    };
    return buildUnggaCliFailureResponse({
      message: error.message ?? String(err),
      stdout: error.stdout,
      stderr: error.stderr,
      code: error.code,
      signal: error.signal,
      killed: error.killed,
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Normalize a non-zero Ungga CLI exit into a structured tool failure.
 * Elevates root-cause fields from JSON stdout; keeps exit/stdout as secondary.
 */
export function buildUnggaCliFailureResponse(error: {
  message?: string;
  stdout?: string;
  stderr?: string;
  code?: number | string;
  signal?: string;
  killed?: boolean;
}): Record<string, unknown> {
  const parsed = error.stdout ? parseCliJson(error.stdout) : null;
  const nestedResult =
    parsed?.result &&
    typeof parsed.result === "object" &&
    !Array.isArray(parsed.result)
      ? (parsed.result as Record<string, unknown>)
      : parsed && typeof parsed === "object"
        ? parsed
        : {};
  const parsedError =
    (typeof nestedResult.error === "string" && nestedResult.error.trim()
      ? nestedResult.error.trim()
      : null) ||
    (parsed && typeof parsed.error === "string" && parsed.error.trim()
      ? parsed.error.trim()
      : null);
  const commissionVerify =
    nestedResult.commission_verify &&
    typeof nestedResult.commission_verify === "object" &&
    !Array.isArray(nestedResult.commission_verify)
      ? (nestedResult.commission_verify as Record<string, unknown>)
      : null;
  const lastStep =
    nestedResult.last_step &&
    typeof nestedResult.last_step === "object" &&
    !Array.isArray(nestedResult.last_step)
      ? nestedResult.last_step
      : parsed?.last_step &&
          typeof parsed.last_step === "object" &&
          !Array.isArray(parsed.last_step)
        ? parsed.last_step
        : null;
  const timeoutLikely =
    error.killed === true ||
    error.signal === "SIGTERM" ||
    String(error.message ?? "").includes("TIMEOUT");
  const commandFailedFallback =
    !parsedError &&
    typeof error.message === "string" &&
    /^Command failed:/i.test(error.message);
  return {
    ok: false,
    status: timeoutLikely ? "unknown_outcome" : "failed",
    mode: "cli",
    phase: "prepare_draft",
    exit_code: error.code ?? null,
    signal: error.signal ?? null,
    error:
      parsedError ||
      (timeoutLikely
        ? `Ungga CLI timed out or was killed: ${error.message ?? "timeout"}`
        : commandFailedFallback
          ? "Ungga CLI failed before saving the draft; see cli_result / last_step."
          : error.message ?? "Ungga CLI failed"),
    ...(typeof nestedResult.commission_expected === "number"
      ? { commission_expected: nestedResult.commission_expected }
      : {}),
    ...(typeof nestedResult.commission_actual === "number" ||
    nestedResult.commission_actual === null
      ? { commission_actual: nestedResult.commission_actual }
      : {}),
    ...(typeof nestedResult.commission_verified === "boolean"
      ? { commission_verified: nestedResult.commission_verified }
      : {}),
    ...(commissionVerify ? { commission_verify: commissionVerify } : {}),
    ...(typeof nestedResult.expected_image_count === "number"
      ? { expected_image_count: nestedResult.expected_image_count }
      : {}),
    ...(typeof nestedResult.uploaded_image_count === "number"
      ? {
          uploaded_image_count: nestedResult.uploaded_image_count,
          image_count: nestedResult.uploaded_image_count,
        }
      : {}),
    ...(lastStep ? { last_step: lastStep } : {}),
    ...(parsed ? { cli_result: parsed } : {}),
    ...(error.stdout?.trim()
      ? { stdout: error.stdout.trim().slice(0, 4000) }
      : {}),
    ...(error.stderr?.trim()
      ? { stderr: error.stderr.trim().slice(0, 2000) }
      : {}),
    hint: timeoutLikely
      ? "Resultado desconocido: no reintentes prepare_draft automáticamente; revisa si quedó un borrador en Ungga."
      : parsedError
        ? "Fallo conocido de prepare_draft (pre-save). Puedes reintentar la preparación tras revisar la causa raíz."
        : "Revisa cli_result.error / stdout para el fallo real del POC Playwright.",
  };
}

export function buildUnggaCliToolResponse(
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
  let ok = parsed.ok === true;
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
  const nestedResult =
    parsed.result && typeof parsed.result === "object" && !Array.isArray(parsed.result)
      ? (parsed.result as Record<string, unknown>)
      : {};
  const lastStep =
    nestedResult.last_step && typeof nestedResult.last_step === "object"
      ? nestedResult.last_step
      : parsed.last_step && typeof parsed.last_step === "object"
        ? parsed.last_step
        : null;

  if (action === "publish_draft") {
    const publishedUrl =
      typeof links.published_url === "string"
        ? links.published_url
        : propertyId
          ? buildUnggaPropertyUrl(propertyId)
          : null;
    const publishCommissionExpected =
      typeof input.commission_pct === "number" &&
      Number.isFinite(input.commission_pct) &&
      input.commission_pct > 0
        ? input.commission_pct
        : typeof nestedResult.commission_expected === "number" &&
            Number.isFinite(nestedResult.commission_expected) &&
            nestedResult.commission_expected > 0
          ? nestedResult.commission_expected
          : null;
    const publishCommissionVerified =
      publishCommissionExpected == null
        ? true
        : nestedResult.commission_verified === true;
    if (ok && publishCommissionExpected != null && !publishCommissionVerified) {
      ok = false;
    }
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
      commission_expected: publishCommissionExpected,
      commission_actual:
        typeof nestedResult.commission_actual === "number"
          ? nestedResult.commission_actual
          : null,
      commission_verified: publishCommissionVerified && ok,
      ...(lastStep ? { last_step: lastStep } : {}),
      cli_result: parsed,
      ...(stderr.trim() ? { stderr: stderr.trim().slice(0, 2000) } : {}),
      ...(!ok && publishCommissionExpected != null && !publishCommissionVerified
        ? {
            error: `Commission not verified before publish: expected ${publishCommissionExpected}%`,
          }
        : {}),
    };
  }

  const expectedImageCount = Array.isArray(input.image_urls)
    ? input.image_urls.filter((u) => typeof u === "string" && u.trim()).length
    : typeof nestedResult.expected_image_count === "number"
      ? nestedResult.expected_image_count
      : 0;
  const uploadedImageCount =
    typeof nestedResult.uploaded_image_count === "number"
      ? nestedResult.uploaded_image_count
      : typeof nestedResult.image_count === "number"
        ? nestedResult.image_count
        : null;
  const draftUrl =
    typeof links.draft_url === "string" && links.draft_url.trim()
      ? links.draft_url.trim()
      : null;
  const imagesSubmitted =
    nestedResult.images_submitted === true ||
    (expectedImageCount > 0 &&
      uploadedImageCount != null &&
      uploadedImageCount >= expectedImageCount);
  const imagesVerified =
    nestedResult.images_verified === true ||
    (expectedImageCount > 0 &&
      uploadedImageCount != null &&
      uploadedImageCount >= expectedImageCount);

  let contractError: string | null = null;
  const expectedCommissionPct =
    typeof input.commission_pct === "number" &&
    Number.isFinite(input.commission_pct) &&
    input.commission_pct > 0
      ? input.commission_pct
      : typeof nestedResult.commission_expected === "number" &&
          Number.isFinite(nestedResult.commission_expected) &&
          nestedResult.commission_expected > 0
        ? nestedResult.commission_expected
        : null;
  const commissionActual =
    typeof nestedResult.commission_actual === "number" &&
    Number.isFinite(nestedResult.commission_actual)
      ? nestedResult.commission_actual
      : null;
  const commissionVerified =
    expectedCommissionPct == null
      ? true
      : nestedResult.commission_verified === true;

  if (cliMode === "dry_run") {
    if (
      expectedImageCount > 0 &&
      (uploadedImageCount == null || uploadedImageCount < expectedImageCount)
    ) {
      ok = false;
      contractError = `Media incomplete in dry-run: expected ${expectedImageCount}, got ${uploadedImageCount ?? 0}`;
    }
  } else if (ok) {
    if (!propertyId || !draftUrl) {
      ok = false;
      contractError =
        "CLI reported success without ungga_property_id/draft_url; treating as failed.";
    } else if (
      expectedImageCount > 0 &&
      (uploadedImageCount == null || uploadedImageCount < expectedImageCount)
    ) {
      ok = false;
      contractError = `Media incomplete: expected ${expectedImageCount} photos, observed ${uploadedImageCount ?? 0}`;
    } else if (expectedCommissionPct != null && !commissionVerified) {
      ok = false;
      contractError = `Commission not verified: expected ${expectedCommissionPct}%, got ${commissionActual ?? "null"}`;
    }
  }

  const draftReady =
    ok && cliMode === "save_draft" && Boolean(propertyId) && Boolean(draftUrl);
  const locationAccuracyWarning =
    asRecord(nestedResult.location_accuracy_warning) ??
    asRecord(parsed.location_accuracy_warning);
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
    ...(propertyId ? { ungga_property_id: propertyId } : {}),
    expected_image_count: expectedImageCount,
    uploaded_image_count: uploadedImageCount,
    image_count: uploadedImageCount,
    images_submitted: imagesSubmitted && ok,
    images_verified: imagesVerified && ok,
    commission_expected: expectedCommissionPct,
    commission_actual: commissionActual,
    commission_verified: expectedCommissionPct == null ? true : commissionVerified && ok,
    ...(lastStep ? { last_step: lastStep } : {}),
    ...(contractError ? { error: contractError } : {}),
    ...(locationAccuracyWarning
      ? { location_accuracy_warning: locationAccuracyWarning }
      : {}),
    ...(draftReady
      ? {
          next_action: {
            action: "publish_draft",
            ungga_property_id: propertyId,
            draft_url: draftUrl,
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
