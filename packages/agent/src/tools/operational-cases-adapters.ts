/**
 * LangChain adapters para las tools del subsistema de casos operacionales:
 *   - operational_case_update_intake
 *   - operational_case_update_state
 *   - operational_case_add_event
 *   - notify_user
 *
 * Estas tools sólo son visibles cuando hay un caso activo (canal
 * `case_runner` o cuando el agente lo invoca desde un turno web/Telegram
 * con `case_id` en contexto). El agente las usa para mover el estado del
 * caso y avisar al humano interno.
 */
import { tool } from "@langchain/core/tools";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { PDFParse } from "pdf-parse";
import { z } from "zod";
import {
  updateToolCallStatus,
  createOperationalCaseDocument,
  createOperationalCase,
  findExtractedOperationalCaseDocumentByHash,
  getOperationalCaseDocument,
  getOperationalCase,
  getOperationalCaseTypeById,
  getOperationalCaseTypeForUser,
  getRecentOperationalCaseEvents,
  insertOperationalCaseEvent,
  listOperationalCaseDocuments,
  updateOperationalCaseDocumentExtraction,
  updateOperationalCase,
  type DbClient,
} from "@agents/db";
import {
  buildComparablesAnalysisFromToolCalls,
  comparablesHasDefensibleSample,
  normalizeComparablesAnalysisForInsufficientN4Test,
  resolveSubjectAreaM2FromPropertyData,
  validateComparablesAnalysisArtifact,
} from "../operational-cases/comparables-analysis";
import {
  buildContractCommercialMinimumsSummaryMessage,
  evaluateContractCommercialMinimums,
} from "../operational-cases/contract-commercial-terms";
import { tryAdvanceComparablesAfterPersist } from "../operational-cases/comparables-advance";
import {
  formatPriceApprovalNotifyText,
  type PricingProposal,
} from "../operational-cases/pricing-proposal";
import { formatListingDescriptionReviewNotifyText } from "../operational-cases/listing-description-review";
import {
  isEasybrokerEffectivelyPublished,
  publicationFromContext,
} from "../operational-cases/publication-workflow";
import {
  canCompleteListingPublishedSummaryFromContext,
  formatListingPublishedSummaryNotifyText,
} from "../operational-cases/listing-published-summary";
import { requiresAvaclick } from "../operational-cases/comparable-search-contract";
import type {
  OperationalCaseActivationPolicy,
  OperationalCaseDocument,
  OperationalCaseExternalContact,
  OperationalCaseFlowStep,
  OperationalCaseIntakeField,
} from "@agents/types";
import type { ToolContext } from "./tool-context";
import { createTrackedToolCall } from "./tool-call-audit";

const STATUS_VALUES = [
  "active",
  "waiting_internal",
  "waiting_external",
  "paused",
  "completed",
  "failed",
] as const;

const ACTOR_VALUES = ["system", "agent", "user", "external"] as const;
const EVENT_TYPE_VALUES = [
  "step_completed",
  "reminder_sent",
  "escalated",
  "human_decision",
  "external_response",
  "error",
] as const;

type PersistedToolCallRow = {
  tool_name: string;
  status: string;
  arguments_json?: Record<string, unknown> | null;
  result_json?: Record<string, unknown> | null;
  created_at?: string | null;
};

function positiveNumberFromUnknown(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value.replace(/,/g, ""));
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function avaclickAttemptedNonRecoverable(call: PersistedToolCallRow): boolean {
  if (call.tool_name !== "get_avaclick_valuation") return false;
  const result = isRecord(call.result_json) ? call.result_json : null;
  if (!result) return false;
  if (call.status === "executed") return true;
  const status = typeof result.status === "string" ? result.status : null;
  const retryable = result.retryable;
  const explicitNoRetry = retryable === false;
  return (
    status === "quota_error" ||
    status === "not_configured" ||
    status === "not_connected" ||
    (status === "validation_error" && explicitNoRetry) ||
    explicitNoRetry
  );
}

/**
 * Kinds de notify_user que están ligados a un caso operativo y por tanto deben
 * cargar el `opCase` para evaluar sus guards (HITL real vs. informativo).
 */
const CASE_BOUND_NOTIFY_KINDS = new Set([
  "property_data_review",
  "property_data_quality_review",
  "comparables_insufficient_data",
  "comparables_analysis",
  "comparables_search_expansion_decision",
  "price_approval",
  "contract_pending",
  "contract_review",
  "contract_data_review",
  "listing_description_review",
  "easybroker_publish_approval",
  "ungga_publish_approval",
  "manual_publish_package_approval",
  "listing_published_summary",
  "titularidad_review",
]);

function normalizeNotifyKindKey(kind: string | undefined): string {
  return (kind ?? "general").trim().toLowerCase().replace(/\s+/g, "_");
}

/**
 * Canonicaliza el `kind` recibido en notify_user antes de evaluar guards y de
 * persistir la notificación. Las variantes de forma libre que significan
 * "comparables listo" se mapean a `comparables_analysis` (informativo) para que
 * el guard correspondiente las detecte y redirija al flujo de precio, en vez de
 * convertirlas en un pendiente humano que detiene el caso. Las decisiones reales
 * de comparables se preservan.
 */
function canonicalizeNotifyKind(rawKind: string | undefined): string {
  const key = normalizeNotifyKindKey(rawKind);
  if (
    key === "price_proposal" ||
    key === "priceproposal" ||
    key === "pricing_proposal" ||
    key === "proposal_price"
  ) {
    return "price_approval";
  }
  if (key === "price_approval") return key;
  if (key === "contract_generation_error") return "contract_data_review";
  if (
    key === "comparables_insufficient_data" ||
    key === "comparables_search_expansion_decision"
  ) {
    return key;
  }
  if (key === "property_comparables") return "comparables_analysis";
  if (
    key.startsWith("comparable") &&
    /(ready|analysis|analisis|complete|completo|completado|done|summary|resumen|listo)/.test(
      key
    )
  ) {
    return "comparables_analysis";
  }
  // Batch legado → pedir EasyBroker primero (flujo canónico por destino).
  if (
    key === "publish_destination_approvals" ||
    key === "publish_destination_approval" ||
    (key.startsWith("publish_destination") && !key.includes("decision"))
  ) {
    return "easybroker_publish_approval";
  }
  return key;
}

export function canonicalizeNotifyKindForTest(rawKind: string | undefined): string {
  return canonicalizeNotifyKind(rawKind);
}

function extractMissingContractFieldsFromText(text: string): string[] {
  const match = text.match(/campos?\s+faltantes?\s*:\s*([^)\n.]+)/i);
  if (!match?.[1]) return [];
  return match[1]
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function canonicalizeContractDataReviewText(text: string): string {
  const missing = extractMissingContractFieldsFromText(text);
  const hasOwnerEmail =
    missing.includes("owner_email") ||
    /\bowner_email\b|correo electr[oó]nico|correo del propietario|correo del due[nñ]o/i.test(
      text
    );
  if (hasOwnerEmail) {
    const missingLabel =
      missing.length > 0 ? missing.join(", ") : "owner_email";
    return `Falta correo electrónico del propietario para generar el contrato de comisión. Captura el correo del comitente (campos faltantes: ${missingLabel}).`;
  }
  if (missing.length > 0) {
    return `No pude generar el borrador de contrato porque faltan datos obligatorios: ${missing.join(", ")}. Completa esos campos para continuar.`;
  }
  return "No pude generar el borrador de contrato porque faltan datos obligatorios. Completa los campos contractuales requeridos para continuar.";
}

/**
 * Texto canónico de `contract_data_review` a partir de campos faltantes
 * detectados por generate (remediación owned, no copy libre del LLM).
 */
export function buildContractDataReviewNotifyText(
  missingRequiredFields: string[]
): string {
  const missing = missingRequiredFields
    .map((field) => field.trim())
    .filter((field) => field.length > 0);
  if (missing.includes("owner_email")) {
    return `Falta correo electrónico del propietario para generar el contrato de comisión. Captura el correo del comitente (campos faltantes: ${missing.join(", ")}).`;
  }
  if (missing.length > 0) {
    return `No pude generar el borrador de contrato porque faltan datos obligatorios: ${missing.join(", ")}. Completa esos campos para continuar.`;
  }
  return "No pude generar el borrador de contrato porque faltan datos obligatorios. Completa los campos contractuales requeridos para continuar.";
}

function normalizedStringSet(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
    ),
  ].sort();
}

/**
 * Detecta la notificación que ya pertenece a la remediación owned de
 * generate_document_from_template. El modelo puede intentar llamar notify_user
 * después de recibir el resultado bloqueado; ese segundo push debe ser un no-op.
 */
export function matchesOwnedContractDataReviewForTest(
  metadata: unknown,
  missingRequiredFields: string[]
): boolean {
  if (!isRecord(metadata)) return false;
  if (metadata.source !== "generate_document_from_template") return false;
  const existing = normalizedStringSet(metadata.missing_required_fields);
  const requested = normalizedStringSet(missingRequiredFields);
  return (
    existing.length > 0 &&
    existing.length === requested.length &&
    existing.every((field, index) => field === requested[index])
  );
}

async function activeOwnedContractDataReviewNotificationId(
  db: DbClient,
  userId: string,
  caseId: string,
  missingRequiredFields: string[]
): Promise<string | null> {
  if (normalizedStringSet(missingRequiredFields).length === 0) return null;
  const { data, error } = await db
    .from("internal_user_notifications")
    .select("id,metadata_jsonb")
    .eq("user_id", userId)
    .eq("case_id", caseId)
    .eq("kind", "contract_data_review")
    .eq("status", "unread")
    .order("created_at", { ascending: false })
    .limit(5);
  if (error || !Array.isArray(data)) return null;
  const match = data.find((row) =>
    matchesOwnedContractDataReviewForTest(
      (row as { metadata_jsonb?: unknown }).metadata_jsonb,
      missingRequiredFields
    )
  ) as { id?: unknown } | undefined;
  return typeof match?.id === "string" ? match.id : null;
}

export function contractDraftOutputPathFromContext(
  context: unknown
): string | null {
  if (!isRecord(context)) return null;
  const draft = isRecord(context.contract_draft) ? context.contract_draft : null;
  if (!draft) return null;
  const outputPath =
    typeof draft.output_path === "string" ? draft.output_path.trim() : "";
  return outputPath.length > 0 ? outputPath : null;
}

/**
 * Gate de `notify_user(kind=contract_review)`: sin borrador renderizado no
 * se inventa “Borrador listo” ni se crea un pendiente contradictorio con
 * `contract_data_review` (PATTERN_GATED_TRANSITION_WITH_OWNED_REMEDIATION).
 */
export function evaluateContractReviewNotifyGate(context: unknown):
  | { ok: true; output_path: string }
  | {
      ok: false;
      error: "contract_draft_required_before_review_notify";
      hint: string;
    } {
  const outputPath = contractDraftOutputPathFromContext(context);
  if (!outputPath) {
    return {
      ok: false,
      error: "contract_draft_required_before_review_notify",
      hint:
        "No notifiques contract_review sin borrador renderizado (contract_draft.output_path). Si generate_document_from_template falló por datos faltantes, el sistema ya pide contract_data_review; completa esos campos y regenera antes de pedir revisión del contrato.",
    };
  }
  return { ok: true, output_path: outputPath };
}

/**
 * Contenido usable de `listing_description_draft` (headline/description).
 * Sin esto no se debe crear un pendiente accionable de revisión.
 */
export function listingDescriptionDraftContentFromContext(context: unknown): {
  headline: string;
  description: string;
} | null {
  if (!isRecord(context)) return null;
  const draft = isRecord(context.listing_description_draft)
    ? context.listing_description_draft
    : null;
  if (!draft) return null;
  const headline =
    typeof draft.headline === "string" ? draft.headline.trim() : "";
  const description =
    typeof draft.description === "string" ? draft.description.trim() : "";
  if (!description) return null;
  return { headline, description };
}

/**
 * Gate de `notify_user(kind=listing_description_review)`: sin borrador real
 * no se crean botones “Aprobar descripción” / “Pedir cambios”.
 */
export function evaluateListingDescriptionReviewNotifyGate(context: unknown):
  | { ok: true; draft: { headline: string; description: string } }
  | {
      ok: false;
      error: "listing_description_draft_required_before_review_notify";
      hint: string;
    } {
  const draft = listingDescriptionDraftContentFromContext(context);
  if (!draft) {
    return {
      ok: false,
      error: "listing_description_draft_required_before_review_notify",
      hint:
        "No notifiques listing_description_review sin listing_description_draft.description. Si faltan photo_analysis o zone_context, ejecuta analyze_property_images(case_id=...) y lookup_property_surroundings(case_id=...) y luego prepare_listing_description_draft antes de pedir revisión.",
    };
  }
  return { ok: true, draft };
}

/**
 * Gate de `notify_user(kind=ungga_publish_approval)`: EasyBroker debe estar
 * publicado remotamente (o skipped/rejected) y, si hay fotos, ya subidas.
 */
export function evaluateUnggaPublishApprovalNotifyGate(context: unknown):
  | { ok: true }
  | {
      ok: false;
      error:
        | "easybroker_images_required_before_ungga_approval"
        | "easybroker_images_upload_failed_before_ungga_approval"
        | "easybroker_not_publicly_published_before_ungga_approval";
      hint: string;
    } {
  if (!isRecord(context)) return { ok: true };
  const approvals = isRecord(context.publish_approvals)
    ? context.publish_approvals
    : {};
  const easybrokerDecision =
    typeof approvals.easybroker === "string" ? approvals.easybroker : null;
  const easybrokerSkippedOrRejected =
    easybrokerDecision === "skipped" || easybrokerDecision === "rejected";
  if (
    !easybrokerSkippedOrRejected &&
    !isEasybrokerEffectivelyPublished(publicationFromContext(context))
  ) {
    return {
      ok: false,
      error: "easybroker_not_publicly_published_before_ungga_approval",
      hint:
        "EasyBroker debe estar publicado remotamente (phase=published) o skipped/rejected antes de notify_user(kind=ungga_publish_approval). Un borrador con listing_id no basta.",
    };
  }

  const published = isRecord(context.published) ? context.published : {};
  const easybroker = isRecord(published.easybroker) ? published.easybroker : null;
  if (!easybroker) return { ok: true };

  const hasPhotos =
    (Array.isArray(context.raw_photos) && context.raw_photos.length > 0) ||
    (Array.isArray(context.watermarked_photos) &&
      context.watermarked_photos.length > 0) ||
    (Array.isArray(context.watermarked_image_paths) &&
      context.watermarked_image_paths.length > 0);
  if (!hasPhotos) return { ok: true };

  const imagesUploaded =
    easybroker.images_uploaded === true ||
    easybroker.images_status === "submitted" ||
    (typeof easybroker.image_count === "number" &&
      Number.isFinite(easybroker.image_count) &&
      easybroker.image_count > 0);
  if (imagesUploaded) return { ok: true };

  if (easybroker.images_status === "failed") {
    return {
      ok: false,
      error: "easybroker_images_upload_failed_before_ungga_approval",
      hint:
        "easybroker_upload_images falló. No pidas Ungga todavía: corrige la URL pública de imágenes (EASYBROKER_PUBLIC_ASSET_BASE_URL / account-assets) y reintenta el upload.",
    };
  }

  return {
    ok: false,
    error: "easybroker_images_required_before_ungga_approval",
    hint:
      "Hay fotos del caso y EasyBroker aún no tiene images_uploaded. Llama easybroker_upload_images antes de notify_user(kind=ungga_publish_approval).",
  };
}

function canonicalContractReviewNotifyText(opCase: { id: string }): string {
  const stableUrl = `/api/operational-cases/${opCase.id}/documents/contract_draft/download`;
  return `Borrador de contrato listo para revisión.\n\nDescargar borrador del contrato: ${stableUrl}\n\nResponde “mándalo al dueño” o “pedir cambios”, o usa los botones.`;
}

function canonicalPublishDestinationApprovalText(kind: string): string {
  const destination =
    kind === "easybroker_publish_approval"
      ? "EasyBroker"
      : kind === "ungga_publish_approval"
        ? "Ungga"
        : "este destino";
  return [
    `Aprobación de publicación en ${destination}`,
    "",
    `La descripción ya quedó aprobada. ¿Quieres publicar esta propiedad en ${destination}?`,
    "",
    "Usa los botones:",
    `- Publicar en ${destination}`,
    `- No publicar en ${destination}`,
    "- Detener y revisar",
  ].join("\n");
}

function listingPublishedSummaryAlreadySent(
  recentEvents: Awaited<ReturnType<typeof getRecentOperationalCaseEvents>>
): boolean {
  return recentEvents.some((event) => {
    const payload =
      event.payload_jsonb &&
      typeof event.payload_jsonb === "object" &&
      !Array.isArray(event.payload_jsonb)
        ? (event.payload_jsonb as Record<string, unknown>)
        : null;
    return payload?.kind === "listing_published_summary_sent";
  });
}

function normalizeNotificationText(value: string | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function looksLikeComparablesSummaryNotification(
  canonicalKind: string,
  text: string | undefined
): boolean {
  if (
    canonicalKind === "price_approval" ||
    canonicalKind === "comparables_insufficient_data" ||
    canonicalKind === "comparables_search_expansion_decision"
  ) {
    return false;
  }
  if (canonicalKind === "comparables_analysis") return true;
  const normalizedText = normalizeNotificationText(text);
  return (
    /\bcomparables?\b/.test(normalizedText) &&
    /(analisis|completad|list[ao]|resumen|easybroker|bigquery|avaclick|propuesta de precio|avanzo a la propuesta)/.test(
      normalizedText
    )
  );
}

export function looksLikeComparablesSummaryNotificationForTest(params: {
  kind?: string;
  text?: string;
}): boolean {
  return looksLikeComparablesSummaryNotification(
    canonicalizeNotifyKind(params.kind),
    params.text
  );
}

function looksLikeCanonicalPriceApprovalNotifyText(text: string | undefined): boolean {
  return normalizeNotificationText(text)
    .trim()
    .startsWith("propuesta de precio lista para revision");
}

/** Resumen narrativo post-comparables (p. ej. tras persist), distinto del copy canónico. */
function looksLikeComparablesCompletionProse(text: string | undefined): boolean {
  if (looksLikeCanonicalPriceApprovalNotifyText(text)) return false;
  const normalizedText = normalizeNotificationText(text);
  return (
    /\bcomparables?\b/.test(normalizedText) &&
    /(analisis|completad|list[ao]|resumen|easybroker|bigquery|avaclick|propuesta de precio|avanzo a la propuesta|comparables usables|se encontraron)/.test(
      normalizedText
    )
  );
}

export function looksLikeComparablesCompletionProseForTest(text?: string): boolean {
  return looksLikeComparablesCompletionProse(text);
}

function priceApprovalNotificationAlreadyDelivered(
  recentEvents: Awaited<ReturnType<typeof getRecentOperationalCaseEvents>>
): boolean {
  return recentEvents.some((event) => {
    const payload =
      event.payload_jsonb &&
      typeof event.payload_jsonb === "object" &&
      !Array.isArray(event.payload_jsonb)
        ? (event.payload_jsonb as Record<string, unknown>)
        : null;
    if (payload?.kind !== "price_approval_requested") return false;
    const delivered = payload.notify_delivered;
    if (!Array.isArray(delivered)) return false;
    return delivered.some(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        (entry as { ok?: boolean }).ok === true
    );
  });
}

function priceApprovalRequestEventExists(
  recentEvents: Awaited<ReturnType<typeof getRecentOperationalCaseEvents>>
): boolean {
  return recentEvents.some((event) => {
    const payload =
      event.payload_jsonb &&
      typeof event.payload_jsonb === "object" &&
      !Array.isArray(event.payload_jsonb)
        ? (event.payload_jsonb as Record<string, unknown>)
        : null;
    return payload?.kind === "price_approval_requested";
  });
}

export function priceApprovalNotificationAlreadyDeliveredForTest(
  events: Array<{ payload_jsonb?: unknown }>
): boolean {
  return priceApprovalNotificationAlreadyDelivered(
    events as Awaited<ReturnType<typeof getRecentOperationalCaseEvents>>
  );
}

function comparablesSearchExpansionDecisionAlreadyRequested(
  recentEvents: Awaited<ReturnType<typeof getRecentOperationalCaseEvents>>
): boolean {
  return recentEvents.some((event) => {
    const payload =
      event.payload_jsonb &&
      typeof event.payload_jsonb === "object" &&
      !Array.isArray(event.payload_jsonb)
        ? (event.payload_jsonb as Record<string, unknown>)
        : null;
    return payload?.kind === "comparables_search_expansion_decision_requested";
  });
}

export function comparablesSearchExpansionDecisionAlreadyRequestedForTest(
  events: Array<{ payload_jsonb?: unknown }>
): boolean {
  return comparablesSearchExpansionDecisionAlreadyRequested(
    events as Awaited<ReturnType<typeof getRecentOperationalCaseEvents>>
  );
}

function normalizeExternalContactPatch(
  value: Record<string, unknown> | undefined
): OperationalCaseExternalContact | undefined {
  if (!value || Object.keys(value).length === 0) return undefined;
  return value as OperationalCaseExternalContact;
}

function mergeExternalContactPatch(
  existing: unknown,
  patch: Record<string, unknown> | undefined
): OperationalCaseExternalContact | undefined {
  const normalizedPatch = normalizeExternalContactPatch(patch);
  if (!normalizedPatch) return undefined;
  const existingContact =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  return {
    ...existingContact,
    ...normalizedPatch,
  } as OperationalCaseExternalContact;
}

function contextString(
  context: Record<string, unknown> | null | undefined,
  key: string
): string | null {
  const value = context?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizePropertyDataValue(value: unknown) {
  return typeof value === "string"
    ? value
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .toLowerCase()
        .trim()
    : "";
}

function normalizePersonName(value: unknown) {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function propertyDataRecord(context: Record<string, unknown>) {
  const value = context.property_data;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function resolveParkingSpacesForDisplay(
  source: Record<string, unknown> | null | undefined
): number | null {
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  const keys = [
    "parking_spots",
    "parking_spaces",
    "parking",
    "cajones",
    "estacionamientos",
  ] as const;
  for (const key of keys) {
    const raw = source[key];
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
      return Math.trunc(raw);
    }
    if (typeof raw === "string" && raw.trim().length > 0) {
      const parsed = Number(raw.replace(/,/g, "").trim());
      if (Number.isFinite(parsed) && parsed >= 0) return Math.trunc(parsed);
    }
  }
  return null;
}

function firstMeaningfulValue(...values: unknown[]) {
  return values.find((value) => hasMeaningfulValue(value));
}

function hasMeaningfulValue(
  value: unknown,
  options?: { allowZero?: boolean }
): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number") {
    return Number.isFinite(value) && (options?.allowZero ? value >= 0 : value > 0);
  }
  if (typeof value === "boolean") return true;
  if (Array.isArray(value)) {
    return value.some((item) => hasMeaningfulValue(item, options));
  }
  if (typeof value === "object") {
    return Object.values(value).some((item) => hasMeaningfulValue(item, options));
  }
  return false;
}

function valueAtPath(source: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((current, part) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    return (current as Record<string, unknown>)[part];
  }, source);
}

function hasAnyPath(
  source: Record<string, unknown>,
  paths: string[],
  options?: { allowZero?: boolean }
): boolean {
  return paths.some((path) =>
    hasMeaningfulValue(valueAtPath(source, path), options)
  );
}

type PropertyDataRequirement = {
  key: string;
  label: string;
  paths: string[];
  question: string;
  allowZero?: boolean;
};

type PropertyDataMinimumsResult = {
  ok: boolean;
  propertyType: string;
  missing: Array<Pick<PropertyDataRequirement, "key" | "label" | "question">>;
};

type OwnerConsistencyStatus =
  | "match"
  | "partial_mismatch"
  | "mismatch"
  | "insufficient";

type OwnerCorroborationEntry = {
  name: string;
  source: string;
};

function displayValue(value: unknown): string | null {
  if (!hasMeaningfulValue(value, { allowZero: true })) return null;
  if (Array.isArray(value)) {
    const values = value.map((item) => displayValue(item)).filter(Boolean);
    return values.length > 0 ? values.join("; ") : null;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return (
      displayValue(record.full) ??
      displayValue(record.formatted) ??
      displayValue(record.street) ??
      null
    );
  }
  return String(value).trim();
}

function extractionOwnerNames(extraction: Record<string, unknown>) {
  const names: string[] = [];
  if (Array.isArray(extraction.owner_names)) {
    for (const value of extraction.owner_names) {
      if (typeof value === "string" && value.trim()) names.push(value.trim());
    }
  } else if (typeof extraction.owner_name === "string" && extraction.owner_name.trim()) {
    names.push(extraction.owner_name.trim());
  }
  for (const key of [
    "holder_name",
    "titular_name",
    "titular",
    "full_name",
    "name",
    "contributor_name",
    "contribuyente",
  ] as const) {
    const value = extraction[key];
    if (typeof value === "string" && value.trim()) names.push(value.trim());
  }
  return names;
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function uniqueByNormalizedName(values: string[]) {
  const byNormalized = new Map<string, string>();
  for (const value of values) {
    const normalized = normalizePersonName(value);
    if (!normalized) continue;
    if (!byNormalized.has(normalized)) {
      byNormalized.set(normalized, value.trim());
    }
  }
  return {
    values: [...byNormalized.values()],
    normalizedSet: new Set(byNormalized.keys()),
  };
}

function nameTokenSet(value: string) {
  const normalized = normalizePersonName(value);
  return new Set(
    normalized
      .split(" ")
      .map((token) => token.trim())
      .filter((token) => token.length >= 2)
  );
}

function namesMatchFuzzy(a: string, b: string) {
  const aTokens = nameTokenSet(a);
  const bTokens = nameTokenSet(b);
  if (aTokens.size === 0 || bTokens.size === 0) return false;
  const boundedLevenshtein = (left: string, right: string, maxDistance = 1) => {
    if (left === right) return 0;
    if (Math.abs(left.length - right.length) > maxDistance) return maxDistance + 1;
    const prev = new Array(right.length + 1)
      .fill(0)
      .map((_, idx) => idx);
    for (let i = 1; i <= left.length; i += 1) {
      let current = i;
      let diagonal = i - 1;
      for (let j = 1; j <= right.length; j += 1) {
        const insert = current + 1;
        const remove = prev[j] + 1;
        const replace = diagonal + (left[i - 1] === right[j - 1] ? 0 : 1);
        diagonal = prev[j];
        current = Math.min(insert, remove, replace);
        prev[j] = current;
      }
      if (Math.min(...prev) > maxDistance) return maxDistance + 1;
      prev[0] = i;
    }
    return prev[right.length];
  };
  const tokensEquivalent = (left: string, right: string) =>
    left === right ||
    boundedLevenshtein(left, right, left.length >= 7 && right.length >= 7 ? 2 : 1) <=
      (left.length >= 7 && right.length >= 7 ? 2 : 1);
  const common = [...aTokens].filter((token) =>
    [...bTokens].some((other) => tokensEquivalent(token, other))
  ).length;
  const recallA = common / aTokens.size;
  const recallB = common / bTokens.size;
  return recallA >= 0.8 && recallB >= 0.5;
}

function isLikelyNameFragmentOfBoleta(
  candidate: string,
  boletaNames: string[]
) {
  const candidateTokens = [...nameTokenSet(candidate)];
  if (candidateTokens.length === 0) return false;
  const informativeTokens = candidateTokens.filter((token) => token.length >= 4);
  if (informativeTokens.length === 0) return true;
  if (candidateTokens.length <= 2) {
    for (const boletaName of boletaNames) {
      const boletaTokens = [...nameTokenSet(boletaName)];
      const isSubset = informativeTokens.every((token) =>
        boletaTokens.some(
          (boletaToken) =>
            boletaToken === token ||
            boletaToken.startsWith(token) ||
            token.startsWith(boletaToken)
        )
      );
      if (isSubset && boletaTokens.length > informativeTokens.length) return true;
    }
  }
  return false;
}

function buildOwnerConsistency(params: {
  boletaOwners: string[];
  otherOwners: string[];
  otherOwnerSources?: OwnerCorroborationEntry[];
}): {
  status: OwnerConsistencyStatus;
  note?: string;
  warning?: string;
  matchedSources?: string[];
} {
  if (params.boletaOwners.length === 0) {
    return { status: "insufficient" };
  }
  if (params.otherOwners.length === 0) {
    return {
      status: "insufficient",
      note:
        "Titularidad tomada de boleta registral; no hay documentos de corroboración con nombres para cotejar.",
    };
  }

  const boleta = uniqueByNormalizedName(params.boletaOwners).values;
  const otherAll = uniqueByNormalizedName(params.otherOwners).values;
  const ignoredFragments = new Set<string>();
  const other = otherAll.filter((name) => {
    const fragment = isLikelyNameFragmentOfBoleta(name, boleta);
    if (fragment) ignoredFragments.add(name);
    return !fragment;
  });
  if (other.length === 0) {
    return {
      status: "insufficient",
      note:
        ignoredFragments.size > 0
          ? "Titularidad tomada de boleta registral; los nombres de apoyo disponibles parecen fragmentos OCR del titular y se ignoraron para evitar falsos positivos."
          : "Titularidad tomada de boleta registral; no hay documentos de corroboración con nombres para cotejar.",
    };
  }
  const matchedBoleta = new Set<string>();
  const matchedOther = new Set<string>();
  const matchedSources = new Set<string>();
  for (const boletaName of boleta) {
    for (const otherName of other) {
      if (namesMatchFuzzy(boletaName, otherName)) {
        matchedBoleta.add(boletaName);
        matchedOther.add(otherName);
        for (const entry of params.otherOwnerSources ?? []) {
          if (namesMatchFuzzy(otherName, entry.name) && entry.source.trim()) {
            matchedSources.add(entry.source.trim());
          }
        }
      }
    }
  }
  if (matchedBoleta.size === 0) {
    return {
      status: "mismatch",
      warning:
        "Los nombres detectados en documentos de apoyo no coinciden con los titulares de la boleta registral.",
      note:
        "No hubo coincidencias de titularidad entre boleta registral y documentos de corroboración.",
    };
  }
  const missingInOther = boleta.filter((name) => !matchedBoleta.has(name));
  const extraInOther = other.filter((name) => !matchedOther.has(name));
  if (missingInOther.length > 0 || extraInOther.length > 0) {
    const unmatchedEntryDetails = (params.otherOwnerSources ?? [])
      .filter((entry) =>
        extraInOther.some((name) => namesMatchFuzzy(name, entry.name))
      )
      .map((entry) => `${entry.name} (${entry.source})`);
    const uniqueUnmatchedEntryDetails = uniqueStrings(unmatchedEntryDetails).slice(0, 3);
    const extraDetailsText =
      uniqueUnmatchedEntryDetails.length > 0
        ? ` Nombres adicionales detectados: ${uniqueUnmatchedEntryDetails.join("; ")}.`
        : "";
    const details = [
      missingInOther.length > 0
        ? "Hay titulares de boleta sin corroboración en documentos de apoyo."
        : null,
      extraInOther.length > 0
        ? "Hay nombres adicionales en documentos de apoyo que no coinciden con boleta."
        : null,
      ignoredFragments.size > 0
        ? "Se ignoraron fragmentos de nombre que parecen cortes OCR del titular."
        : null,
    ].filter(Boolean);
    return {
      status: "partial_mismatch",
      warning:
        "La titularidad de boleta registral coincide parcialmente con otros documentos; revisar antes de contrato.",
      note:
        `${details.join(" ")}${extraDetailsText}`.trim() ||
        "Coincidencia parcial de titulares entre boleta y documentos de corroboración.",
      matchedSources: [...matchedSources],
    };
  }
  return {
    status: "match",
    note:
      "Los titulares de boleta registral coinciden con los nombres detectados en documentos de corroboración.",
    matchedSources: [...matchedSources],
  };
}

function ownerConsistencyPublicSummary(
  status: unknown,
  note: unknown,
  matchedSources: unknown
): string | null {
  const normalizedStatus = typeof status === "string" ? status : "";
  const sourceList = Array.isArray(matchedSources)
    ? uniqueStrings(matchedSources.filter((source): source is string => typeof source === "string"))
    : [];
  const sourceText =
    sourceList.length > 0 ? sourceList.join("; ") : "documentos de corroboración";
  if (normalizedStatus === "match") {
    return sourceList.length > 0
      ? `Coincidencia encontrada en: ${sourceText}.`
      : `Coincide boleta registral con: ${sourceText}.`;
  }
  if (normalizedStatus === "insufficient") {
    return typeof note === "string" && note.trim()
      ? note.trim()
      : "Titularidad tomada de boleta registral; falta corroboración en otros documentos.";
  }
  if (normalizedStatus === "partial_mismatch") {
    const noteText = typeof note === "string" ? note.trim() : "";
    if (sourceList.length > 0) {
      if (noteText.includes("nombres adicionales")) {
        return `Coincidencia encontrada en: ${sourceText}. ${noteText}`;
      }
      if (noteText.includes("sin corroboración")) {
        return `Coincidencia encontrada en: ${sourceText}. Falta corroborar a todos los titulares de boleta en los documentos de apoyo.`;
      }
      return `Coincidencia encontrada en: ${sourceText}. Hay detalles de titularidad que requieren validación adicional.`;
    }
    return "Hay coincidencia parcial de titularidad y se detectaron diferencias adicionales.";
  }
  if (normalizedStatus === "mismatch") {
    if (sourceList.length > 0) {
      return `No hubo coincidencia clara entre boleta registral y: ${sourceText}.`;
    }
    return "Se detectaron diferencias de titularidad en la corroboración documental.";
  }
  return null;
}

function ownerCorroborationSourceLabel(signals: DocumentSignals) {
  if (signals.predial) return "predial";
  if (signals.identificacion) return "identificacion oficial";
  if (signals.comprobante) return "comprobante de domicilio";
  return "documento de apoyo";
}

function sanitizeAddressCandidates(values: string[]) {
  const unique = uniqueStrings(values);
  if (unique.length <= 1) return unique;
  const maxLength = Math.max(...unique.map((value) => value.length));
  return unique.filter((value) => {
    const normalized = normalizePropertyDataValue(value);
    if (!normalized) return false;
    const hasDigits = /\d/.test(normalized);
    const tokenCount = normalized.split(/\s+/).filter(Boolean).length;
    if (maxLength >= 28 && value.length < 18 && !hasDigits && tokenCount < 3) {
      return false;
    }
    return true;
  });
}

function extractionAddressCandidates(extraction: Record<string, unknown>) {
  const candidates: string[] = [];
  if (isRecord(extraction.address)) {
    for (const key of ["full", "formatted", "street"] as const) {
      const value = extraction.address[key];
      if (typeof value === "string" && value.trim()) candidates.push(value.trim());
    }
  }
  for (const value of [
    extraction.legal_address,
    extraction.property_address,
    extraction.address_text,
    extraction.property_description,
  ]) {
    if (typeof value === "string" && value.trim()) candidates.push(value.trim());
  }
  return sanitizeAddressCandidates(candidates);
}

const COMMON_PROPERTY_DATA_REQUIREMENTS: PropertyDataRequirement[] = [
  {
    key: "owner_names",
    label: "Nombre(s) de dueño",
    paths: ["owner_names", "owner_name", "owners", "owner.name"],
    question: "Nombre(s) de dueño o titulares de la propiedad.",
  },
  {
    key: "property_address",
    label: "Dirección de la propiedad",
    paths: [
      "address.full",
      "address.street",
      "legal_address",
      "legal_addresses",
      "property_address",
      "location.address",
    ],
    question: "Dirección completa de la propiedad.",
  },
  {
    key: "area_total_m2",
    label: "Superficie / metros cuadrados",
    paths: [
      "area_total_m2",
      "area_m2",
      "surface_m2",
      "superficie_m2",
      "land_area_m2",
      "lot_area_m2",
    ],
    question: "Superficie o metraje total en metros cuadrados.",
  },
];

const PROPERTY_TYPE_REQUIREMENTS: Record<string, PropertyDataRequirement[]> = {
  casa: [
    {
      key: "area_construida_m2",
      label: "Metros cuadrados de construcción",
      paths: ["area_construida_m2", "construction_area_m2", "built_area_m2"],
      question: "Metros cuadrados de construcción.",
    },
    {
      key: "floors",
      label: "Número de plantas/pisos",
      paths: ["floors", "floor_count", "levels", "stories"],
      question: "Número de plantas o pisos.",
    },
    {
      key: "bedrooms",
      label: "Recámaras",
      paths: ["bedrooms", "recamaras", "habitaciones"],
      question: "Número de recámaras.",
    },
    {
      key: "bathrooms",
      label: "Baños completos",
      paths: ["bathrooms", "full_bathrooms", "banos_completos"],
      question: "Número de baños completos.",
    },
    {
      key: "half_bathrooms",
      label: "Medios baños",
      paths: ["half_bathrooms", "half_baths", "medios_banos"],
      question: "Número de medios baños.",
      allowZero: true,
    },
    {
      key: "integral_kitchen",
      label: "Cocina integral",
      paths: ["integral_kitchen", "has_integral_kitchen", "cocina_integral"],
      question: "Si tiene cocina integral (sí/no).",
    },
    {
      key: "parking_spaces",
      label: "Cajones de estacionamiento",
      paths: [
        "parking_spaces",
        "parking_spots",
        "parking",
        "cajones",
        "estacionamientos",
      ],
      question: "Número de cajones de estacionamiento.",
      allowZero: true,
    },
  ],
  departamento: [
    {
      key: "bedrooms",
      label: "Recámaras",
      paths: ["bedrooms", "recamaras", "habitaciones"],
      question: "Número de recámaras.",
    },
    {
      key: "bathrooms",
      label: "Baños completos",
      paths: ["bathrooms", "full_bathrooms", "banos_completos"],
      question: "Número de baños completos.",
    },
    {
      key: "half_bathrooms",
      label: "Medios baños",
      paths: ["half_bathrooms", "half_baths", "medios_banos"],
      question: "Número de medios baños.",
      allowZero: true,
    },
    {
      key: "parking_spaces",
      label: "Cajones de estacionamiento",
      paths: [
        "parking_spaces",
        "parking_spots",
        "parking",
        "cajones",
        "estacionamientos",
      ],
      question: "Número de cajones de estacionamiento.",
      allowZero: true,
    },
    {
      key: "floor_number",
      label: "Piso del departamento",
      paths: ["floor_number", "apartment_floor", "piso"],
      question: "En qué piso está el departamento.",
    },
    {
      key: "has_elevator",
      label: "Elevador",
      paths: ["has_elevator", "elevator", "elevador"],
      question: "Si el edificio tiene elevador (sí/no).",
    },
    {
      key: "amenities",
      label: "Amenidades",
      paths: ["amenities", "amenidades"],
      question: "Amenidades del edificio, si tiene.",
    },
  ],
  terreno: [
    {
      key: "land_context",
      label: "Coto / condominio / parque industrial",
      paths: [
        "land_context",
        "is_in_gated_community",
        "in_gated_community",
        "gated_community",
        "coto",
        "condominio",
        "industrial_park",
        "in_industrial_park",
      ],
      question:
        "Si el terreno está en coto/condominio/parque industrial o es independiente.",
    },
  ],
  bodega: [
    {
      key: "warehouse_area_m2",
      label: "Metros cuadrados de bodega",
      paths: ["warehouse_area_m2", "bodega_area_m2", "area_total_m2"],
      question: "Metros cuadrados de la bodega/nave.",
    },
    {
      key: "warehouse_height_m",
      label: "Altura",
      paths: ["warehouse_height_m", "height_m", "altura_m"],
      question: "Altura de la bodega/nave.",
    },
    {
      key: "office_area_m2",
      label: "Espacio de oficinas",
      paths: ["office_area_m2", "office_space_m2", "has_office_space"],
      question: "Metros cuadrados de oficinas, o confirmar si no aplica.",
    },
    {
      key: "bathrooms",
      label: "Baños",
      paths: ["bathrooms", "full_bathrooms", "banos"],
      question: "Número de baños.",
    },
    {
      key: "parking_spaces",
      label: "Cajones de estacionamiento",
      paths: [
        "parking_spaces",
        "parking_spots",
        "parking",
        "cajones",
        "estacionamientos",
      ],
      question: "Número de cajones/estacionamientos.",
      allowZero: true,
    },
    {
      key: "kva",
      label: "KVA",
      paths: ["kva", "power_kva", "electric_capacity_kva"],
      question: "Capacidad eléctrica en KVA.",
    },
    {
      key: "has_transformer",
      label: "Transformador",
      paths: ["has_transformer", "transformer", "transformador"],
      question: "Si tiene transformador (sí/no).",
    },
  ],
};

PROPERTY_TYPE_REQUIREMENTS["nave industrial"] = PROPERTY_TYPE_REQUIREMENTS.bodega;
PROPERTY_TYPE_REQUIREMENTS["nave"] = PROPERTY_TYPE_REQUIREMENTS.bodega;

function propertyTypeRequirementKey(value: unknown) {
  const normalized = normalizePropertyDataValue(value);
  if (/\b(casa|residencia)\b/.test(normalized)) return "casa";
  if (/\b(departamento|depto|apartment)\b/.test(normalized)) return "departamento";
  if (/\b(terreno|lote|land)\b/.test(normalized)) return "terreno";
  if (/\b(bodega|nave industrial|nave)\b/.test(normalized)) return "bodega";
  return normalized;
}

export function evaluatePropertyDataMinimumsForReview(
  context: Record<string, unknown> | null | undefined,
  supplement: Record<string, unknown> = {}
): PropertyDataMinimumsResult {
  const safeContext = context ?? {};
  const propertyData = propertyDataRecord(safeContext);
  const merged = { ...safeContext, ...propertyData, ...supplement };
  const propertyType =
    propertyTypeRequirementKey(
      propertyData.property_type ?? safeContext.property_type
    ) || "desconocido";
  const requirements = [
    ...COMMON_PROPERTY_DATA_REQUIREMENTS,
    ...(PROPERTY_TYPE_REQUIREMENTS[propertyType] ?? []),
  ];
  const missing = requirements
    .filter(
      (requirement) =>
        !hasAnyPath(merged, requirement.paths, {
          allowZero: requirement.allowZero,
        })
    )
    .map(({ key, label, question }) => ({ key, label, question }));
  return { ok: missing.length === 0, propertyType, missing };
}

export function buildPropertyDataMinimumsSummaryMessage(params: {
  context: Record<string, unknown> | null | undefined;
  supplement?: Record<string, unknown>;
  missing: Array<Pick<PropertyDataRequirement, "key" | "label" | "question">>;
}) {
  const safeContext = params.context ?? {};
  const propertyData = propertyDataRecord(safeContext);
  const merged = { ...safeContext, ...propertyData, ...(params.supplement ?? {}) };
  const ownerLabel =
    merged.owner_names_source === "boleta_registral"
      ? "Dueño/titular (boleta registral)"
      : "Dueño/titular";
  const ownerConsistencySummary = ownerConsistencyPublicSummary(
    merged.owner_consistency_status,
    merged.owner_consistency_note,
    merged.owner_consistency_matched_sources
  );
  const knownLines = [
    displayValue(safeContext.property_title)
      ? `- Título / propiedad: ${displayValue(safeContext.property_title)}`
      : null,
    displayValue(safeContext.property_zone)
      ? `- Zona / colonia: ${displayValue(safeContext.property_zone)}`
      : null,
    displayValue(safeContext.operation_type)
      ? `- Operación: ${displayValue(safeContext.operation_type)}`
      : null,
    displayValue(safeContext.property_type ?? propertyData.property_type)
      ? `- Tipo de propiedad: ${displayValue(
          safeContext.property_type ?? propertyData.property_type
        )}`
      : null,
    displayValue(merged.owner_names)
      ? `- ${ownerLabel}: ${displayValue(merged.owner_names)}`
      : null,
    displayValue(merged.legal_addresses ?? merged.legal_address ?? merged.property_address ?? merged.address)
      ? `- Dirección encontrada: ${displayValue(
          merged.legal_addresses ??
            merged.legal_address ??
            merged.property_address ??
            merged.address
        )}`
      : null,
    displayValue(merged.area_total_m2)
      ? `- Superficie de terreno encontrada: ${displayValue(merged.area_total_m2)} m²`
      : null,
    displayValue(merged.area_construida_m2)
      ? `- Superficie de construcción encontrada: ${displayValue(
          merged.area_construida_m2
        )} m²`
      : null,
    ownerConsistencySummary
      ? `- Verificación de titularidad: ${ownerConsistencySummary}`
      : null,
    displayValue(merged.area_total_m2_source)
      ? `- Fuente principal de superficie: ${displayValue(merged.area_total_m2_source)}`
      : null,
  ].filter((line): line is string => Boolean(line));
  const missingLines = params.missing.map(
    (item, index) => `${index + 1}. ${item.question}`
  );

  return [
    "Ya tengo estos datos del caso:",
    "",
    ...(knownLines.length > 0 ? knownLines : ["- Sin datos consolidados todavía."]),
    "",
    "Para completar los datos mínimos antes de la revisión, por favor confirma:",
    "",
    ...missingLines,
  ].join("\n");
}

function isPropertyDocumentForMinimums(document: OperationalCaseDocument) {
  const normalized = normalizePropertyDataValue(
    [
      document.kind,
      document.display_name,
      document.original_name,
      document.extraction_jsonb?.document_kind,
    ]
      .filter(Boolean)
      .join(" ")
  );
  return (
    /escritura|descripcion|descriptiva|testimonio|(?:^|[^a-z])esc(?:[^a-z]|$)|desdeesc|predial|boleta|registral|folio real/.test(
      normalized
    )
  );
}

type DocumentSignals = {
  boleta: boolean;
  predial: boolean;
  escritura: boolean;
  identificacion: boolean;
  comprobante: boolean;
  property: boolean;
};

function documentSignalsForMinimums(
  document: OperationalCaseDocument,
  extraction: Record<string, unknown>
): DocumentSignals {
  const normalized = normalizePropertyDataValue(
    [
      document.kind,
      document.display_name,
      document.original_name,
      extraction.document_kind,
      extraction.raw_text,
      extraction.text,
      extraction.property_description,
      extraction.legal_address,
      extraction.property_address,
    ]
      .filter(Boolean)
      .join(" ")
      .slice(0, 6000)
  );
  const boleta = /\bboleta\b|\bboleta registral\b|folio real|registro publico|registral/.test(
    normalized
  );
  const predial =
    /\bpredial\b|impuesto predial|cuenta predial|clave catastral|sup\.?\s*terr|sup\.?\s*const/.test(
      normalized
    );
  const escritura =
    /escritura|testimonio|notaria|notario|instrumento|descripcion|descriptiva|desdeesc/.test(
      normalized
    );
  const identificacion =
    /\bine\b|instituto nacional electoral|credencial para votar|pasaporte|identificacion oficial|identidad/.test(
      normalized
    );
  const comprobante =
    /comprobante|domicilio|estado de cuenta|banco|bancario|cfe|telmex|internet|luz|gas/.test(
      normalized
    );
  const property = boleta || predial || escritura || isPropertyDocumentForMinimums(document);
  return {
    boleta,
    predial,
    escritura,
    identificacion,
    comprobante,
    property,
  };
}

function isPredialDocumentCandidate(document: OperationalCaseDocument) {
  const normalized = normalizePropertyDataValue(
    [document.kind, document.display_name, document.original_name].filter(Boolean).join(" ")
  );
  return /\bpredial\b|impuesto predial|cuenta predial|clave catastral/.test(normalized);
}

function isBoletaDocumentCandidate(document: OperationalCaseDocument) {
  const normalized = normalizePropertyDataValue(
    [document.kind, document.display_name, document.original_name].filter(Boolean).join(" ")
  );
  return /\bboleta\b|\bboleta registral\b|folio real|registro publico|registral/.test(
    normalized
  );
}

export function documentExtractionMinimumsContext(
  documents: OperationalCaseDocument[]
): Record<string, unknown> {
  const extracted: Record<string, unknown> = {};
  const ownerNamesAll: string[] = [];
  const ownerNamesBoleta: string[] = [];
  const ownerNamesCorroborationDocs: string[] = [];
  const ownerNameCorroborationSources: OwnerCorroborationEntry[] = [];
  const ownerNamesIgnoredForConsistency: string[] = [];
  const legalAddressesBoleta: string[] = [];
  const legalAddressesEscritura: string[] = [];
  const legalAddressesOther: string[] = [];
  const hasBoletaDocument = documents.some(
    (document) => document.status !== "superseded" && isBoletaDocumentCandidate(document)
  );
  const hasPredialDocument = documents.some(
    (document) => document.status !== "superseded" && isPredialDocumentCandidate(document)
  );
  let predialAreaTotalFound = false;
  let predialAreaConstruidaFound = false;
  let areaTotalPriority = Number.POSITIVE_INFINITY;
  let areaConstruidaPriority = Number.POSITIVE_INFINITY;

  for (const document of documents) {
    if (
      document.status === "superseded" ||
      !["ok", "low_confidence"].includes(document.extraction_status)
    ) {
      continue;
    }
    const extraction = document.extraction_jsonb ?? {};
    if (!hasMeaningfulValue(extraction)) continue;
    const signals = documentSignalsForMinimums(document, extraction);
    const propertyDocument = signals.property;
    const areaPriority = signals.predial ? 1 : signals.boleta ? 2 : signals.escritura ? 3 : 4;

    if (propertyDocument) {
      const area = firstMeaningfulValue(
        extraction.area_total_m2,
        extraction.area_m2,
        extraction.surface_m2,
        extraction.superficie_m2,
        extraction.sup_terr,
        extraction.superficie_terreno_m2
      );
      if (signals.predial && area != null) predialAreaTotalFound = true;
      const blockedByPendingPredialTotal =
        hasPredialDocument && !signals.predial && !predialAreaTotalFound;
      if (
        area != null &&
        areaPriority <= areaTotalPriority &&
        !blockedByPendingPredialTotal
      ) {
        extracted.area_total_m2 = area;
        extracted.area_total_m2_source = signals.predial
          ? "predial"
          : signals.boleta
            ? "boleta_registral"
            : signals.escritura
              ? "escritura"
              : "documento_propiedad";
        areaTotalPriority = areaPriority;
      }
    }
    if (propertyDocument) {
      const builtArea = firstMeaningfulValue(
        extraction.area_construida_m2,
        extraction.construction_area_m2,
        extraction.built_area_m2,
        extraction.sup_const,
        extraction.superficie_construccion_m2
      );
      if (signals.predial && builtArea != null) predialAreaConstruidaFound = true;
      const blockedByPendingPredialBuilt =
        hasPredialDocument && !signals.predial && !predialAreaConstruidaFound;
      if (
        builtArea != null &&
        areaPriority <= areaConstruidaPriority &&
        !blockedByPendingPredialBuilt
      ) {
        extracted.area_construida_m2 = builtArea;
        extracted.area_construida_m2_source = signals.predial
          ? "predial"
          : signals.boleta
            ? "boleta_registral"
            : signals.escritura
              ? "escritura"
              : "documento_propiedad";
        areaConstruidaPriority = areaPriority;
      }
    }

    const names = extractionOwnerNames(extraction);
    if (names.length > 0) {
      ownerNamesAll.push(...names);
      if (signals.boleta) {
        ownerNamesBoleta.push(...names);
      } else if (signals.predial || signals.identificacion || signals.comprobante) {
        ownerNamesCorroborationDocs.push(...names);
        for (const name of names) {
          ownerNameCorroborationSources.push({
            name,
            source: ownerCorroborationSourceLabel(signals),
          });
        }
      } else if (signals.escritura || propertyDocument) {
        // Escrituras complejas (p. ej. sucesion testamentaria) suelen listar
        // varias personas no titulares del inmueble del caso; se excluyen del
        // cotejo de titularidad para evitar falsos desajustes.
        ownerNamesIgnoredForConsistency.push(...names);
      }
    }

    // Una escritura multi-inmueble cuyo match con el inmueble del caso fue
    // ambiguo o de baja confianza NO debe contaminar la direccion canonica:
    // su "principal" suele ser otro inmueble. Preferimos quedarnos sin
    // calle/numero (geocode_unresolved seguro) antes que adoptar la direccion
    // equivocada de otra propiedad de la sucesion.
    const ambiguousDeed =
      signals.escritura === true &&
      (extraction.multi_property_ambiguous === true ||
        extraction.deed_property_match_low_confidence === true);
    if (propertyDocument && isRecord(extraction.address)) {
      if (ambiguousDeed) {
        const { street: _s, exterior_number: _e, numero_exterior: _n, number: _num, ...safeAddress } =
          extraction.address as Record<string, unknown>;
        extracted.address = {
          ...(isRecord(extracted.address) ? extracted.address : {}),
          ...safeAddress,
        };
        extracted.address_from_ambiguous_deed = { ...extraction.address };
        extracted.address_needs_review = true;
      } else {
        extracted.address = {
          ...(isRecord(extracted.address) ? extracted.address : {}),
          ...extraction.address,
        };
      }
    }
    if (propertyDocument) {
      const addressCandidates = extractionAddressCandidates(extraction);
      if (signals.boleta) {
        legalAddressesBoleta.push(...addressCandidates);
      } else if (signals.escritura) {
        if (!ambiguousDeed) {
          legalAddressesEscritura.push(...addressCandidates);
        }
      } else {
        legalAddressesOther.push(...addressCandidates);
      }
    }
  }

  const uniqueOwnersAll = uniqueStrings(ownerNamesAll);
  const uniqueOwnersBoleta = uniqueStrings(ownerNamesBoleta);
  const uniqueOwnersOther = uniqueStrings(ownerNamesCorroborationDocs);
  const uniqueOwnersIgnored = uniqueStrings(ownerNamesIgnoredForConsistency);
  const canonicalOwners =
    uniqueOwnersBoleta.length > 0
      ? uniqueOwnersBoleta
      : hasBoletaDocument
        ? uniqueOwnersOther
        : uniqueOwnersAll;
  const uniqueAddressesBoleta = sanitizeAddressCandidates(legalAddressesBoleta);
  const uniqueAddressesEscritura = sanitizeAddressCandidates(legalAddressesEscritura);
  const uniqueAddressesOther = sanitizeAddressCandidates(legalAddressesOther);
  const canonicalAddresses =
    uniqueAddressesBoleta.length > 0
      ? uniqueAddressesBoleta
      : hasBoletaDocument
        ? uniqueAddressesOther
      : uniqueAddressesEscritura.length > 0
        ? uniqueAddressesEscritura
        : uniqueAddressesOther;
  if (canonicalOwners.length > 0) extracted.owner_names = canonicalOwners;
  if (uniqueOwnersBoleta.length > 0) {
    extracted.owner_names_from_boleta = uniqueOwnersBoleta;
    extracted.owner_names_source = "boleta_registral";
  } else if (uniqueOwnersAll.length > 0) {
    extracted.owner_names_source = "documentos_compartidos";
  }
  if (uniqueOwnersOther.length > 0) {
    extracted.owner_names_other_documents = uniqueOwnersOther;
  }
  if (uniqueOwnersIgnored.length > 0) {
    extracted.owner_names_excluded_from_consistency = uniqueOwnersIgnored;
  }
  const ownerConsistency = buildOwnerConsistency({
    boletaOwners: uniqueOwnersBoleta,
    otherOwners: uniqueOwnersOther,
    otherOwnerSources: ownerNameCorroborationSources,
  });
  extracted.owner_consistency_status = ownerConsistency.status;
  if (ownerConsistency.note) extracted.owner_consistency_note = ownerConsistency.note;
  if (ownerConsistency.matchedSources && ownerConsistency.matchedSources.length > 0) {
    extracted.owner_consistency_matched_sources = ownerConsistency.matchedSources;
  }
  if (ownerConsistency.warning) {
    extracted.owner_consistency_warning = ownerConsistency.warning;
  }
  if (canonicalAddresses.length > 0) extracted.legal_addresses = canonicalAddresses;
  if (uniqueAddressesBoleta.length > 0) {
    extracted.legal_addresses_source = "boleta_registral";
  } else if (uniqueAddressesEscritura.length > 0) {
    extracted.legal_addresses_source = "escritura";
  } else if (uniqueAddressesOther.length > 0) {
    extracted.legal_addresses_source = "documentos_compartidos";
  }
  const nonCanonicalAddressPool = [
    ...uniqueAddressesBoleta,
    ...uniqueAddressesEscritura,
    ...uniqueAddressesOther,
  ].filter((value) => !canonicalAddresses.includes(value));
  if (nonCanonicalAddressPool.length > 0) {
    extracted.legal_addresses_other_documents = nonCanonicalAddressPool;
  }
  return extracted;
}

function sanitizeExtractedReviewDetails(text: string) {
  const cleaned = text
    .replace(/\*\*/g, "")
    .replace(/^\s*datos extra[ií]dos(?: de documentos)?:\s*/gim, "")
    .split("\n")
    .filter((line) => {
      const normalized = normalizePropertyDataValue(line);
      return !/^[-•]?\s*(tipo|operacion|operación|zona)\s*:/.test(normalized);
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned;
}

export function canonicalizePropertyDataReviewText(
  opCase: Awaited<ReturnType<typeof getOperationalCase>> | null,
  text: string
) {
  if (!opCase) return text;
  const context = opCase.context_jsonb ?? {};
  const title = contextString(context, "property_title");
  const zone = contextString(context, "property_zone");
  const operation = contextString(context, "operation_type");
  const propertyType = contextString(context, "property_type");
  if (!title && !zone && !operation && !propertyType) return text;

  const cleaned = text.replace(/\*\*/g, "").trim();
  const extractedStart = cleaned.search(/Direcci[oó]n Legal:|Datos extra[ií]dos/i);
  const extractedDetails =
    extractedStart >= 0
      ? sanitizeExtractedReviewDetails(cleaned.slice(extractedStart))
      : sanitizeExtractedReviewDetails(cleaned);

  const propertyData = propertyDataRecord(context);
  const parking = resolveParkingSpacesForDisplay({
    ...context,
    ...propertyData,
  });
  const parkingAlreadyPresent =
    /cajones?\s+de\s+estacionamiento|estacionamientos?/i.test(cleaned);
  const parkingLine =
    parking != null && !parkingAlreadyPresent
      ? `- Número de cajones de estacionamiento: ${parking}`
      : null;

  return [
    `Revisión de datos extraídos para el caso ${opCase.id}:`,
    "",
    "Datos confirmados por intake:",
    title ? `- Título / propiedad: ${title}` : null,
    zone ? `- Zona / colonia: ${zone}` : null,
    operation ? `- Operación: ${operation}` : null,
    propertyType ? `- Tipo de propiedad: ${propertyType}` : null,
    "",
    "Datos encontrados en documentos:",
    extractedDetails ||
      "- No se incluyeron datos documentales específicos en el mensaje del agente.",
    parkingLine,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

const VISION_EXTRACTION_MODEL = "openai/gpt-4o-mini";
const PDF_TEXT_EXTRACTION_MODEL = "openai/gpt-4o-mini";
const DOCUMENT_EXTRACTION_JSON_SHAPE =
  '{"document_kind":string,"property_description":string|null,"legal_address":string|null,"address":object|null,"area_total_m2":number|null,"area_construida_m2":number|null,"owner_names":string[],"folio_real":string|null,"predial_account":string|null,"confidence":"high"|"medium"|"low","warnings":string[]}';
const PREDIAL_VISION_EXTRACTION_JSON_SHAPE =
  `${DOCUMENT_EXTRACTION_JSON_SHAPE.slice(0, -1)},"predial_contribuyente_row_values":string[],"sup_terr_raw":string|null,"sup_const_raw":string|null}`;
const PREDIAL_VISION_ROW_ONLY_JSON_SHAPE =
  '{"predial_contribuyente_row_values":string[],"sup_terr_raw":string|null,"sup_const_raw":string|null}';
const DEED_EXTRACTION_JSON_SHAPE = `${DOCUMENT_EXTRACTION_JSON_SHAPE.slice(0, -1)},"properties":[{"property_description":string|null,"address":{"street":string|null,"exterior_number":string|null,"neighborhood":string|null,"municipality":string|null,"state":string|null,"postal_code":string|null}|null,"area_total_m2":number|null,"area_construida_m2":number|null}]}`;
const DEED_MULTI_PROPERTY_GUIDANCE =
  " Si la escritura describe MÁS DE UN inmueble (p. ej. escritura de sucesión/adjudicación o que enlista varias fincas), devuelve además un arreglo `properties` con un elemento por inmueble, cada uno con su dirección (calle, número exterior, colonia/fraccionamiento, municipio, estado, código postal) y superficies. Captura el número exterior/finca de cada inmueble (p. ej. 'Finca marcada con el número 3668'). Llena los campos planos (address, area_total_m2, area_construida_m2) con el inmueble principal. Si solo hay un inmueble, incluye ese único elemento en `properties`.";
const PROPERTY_AREA_EXTRACTION_GUIDANCE =
  "En escrituras mexicanas, area_total_m2 debe capturar la superficie total/privativa del inmueble cuando aparezca como 'superficie total de X metros cuadrados', 'superficie privativa', 'area privativa' o 'superficie del terreno'. No uses medidas de linderos/colindancias como area_total_m2. area_construida_m2 debe llenarse cuando el texto diga construccion/superficie construida. En recibos prediales mexicanos (p. ej. Jalisco/Zapopan), mapea SUP. TERR o superficie de terreno a area_total_m2 y SUP. CONST o superficie construida a area_construida_m2 cuando aparezcan en tabla o renglón de valores.";
const BOLETA_LEGAL_ADDRESS_GUIDANCE =
  " En boleta registral extrae la direccion legal completa en `legal_address` sin truncar: incluye numero/finca, calle, colonia/fraccionamiento, municipio y estado cuando aparezcan en el texto.";
const PREDIAL_VISION_TABLE_GUIDANCE =
  " En recibos prediales, localiza la seccion DATOS DEL CONTRIBUYENTE. Copia literalmente la fila de valores bajo las columnas TIPO, SUP. TERR, SUP. CONST (y columnas vecinas visibles) en predial_contribuyente_row_values en orden izquierda a derecha (ej. [\"U\",\"138.00\",\"146.00\",\"0.00\",\"0.00\"]). Llena sup_terr_raw y sup_const_raw con el texto exacto visible bajo SUP. TERR y SUP. CONST. Importante: 146.00 significa 146 metros cuadrados, no 14.6; conserva todos los digitos antes del punto decimal.";
const requireFromHere = createRequire(import.meta.url);
const requireFromCwd = createRequire(`${process.cwd()}/__pdf-resolver.js`);
let pdfWorkerConfigured = false;

/**
 * Resuelve la ruta del worker de pdfjs-dist y la registra vía
 * `PDFParse.setWorker`. Construimos los specs de forma dinámica (joins en
 * arreglo) para que Turbopack/webpack no los analicen estáticamente y
 * traten de bundlear el .mjs (lo cual rompe el resolver en runtime). Como
 * `pdf-parse` se marca como `serverExternalPackages`, pdf.js suele encontrar
 * el worker por sí mismo (adyacente a `pdf.mjs`); esta función es defensa en
 * profundidad para entornos donde la resolución por defecto falla.
 */
function ensurePdfWorkerConfigured() {
  if (pdfWorkerConfigured) return;
  pdfWorkerConfigured = true;
  const pkg = ["pdfjs-dist"].join("");
  const specs = [
    [pkg, "legacy", "build", "pdf.worker.mjs"].join("/"),
    [pkg, "build", "pdf.worker.mjs"].join("/"),
  ];
  const candidates: string[] = [];
  for (const resolver of [requireFromHere, requireFromCwd]) {
    for (const spec of specs) {
      try {
        candidates.push(resolver.resolve(spec));
      } catch {
        // resolver no puede; continuamos con el siguiente intento
      }
    }
  }
  for (const candidate of candidates) {
    try {
      PDFParse.setWorker(pathToFileURL(candidate).toString());
      return;
    } catch {
      // intentamos con el siguiente candidato
    }
  }
}

function parseModelJson(content: string, documentKind: string): Record<string, unknown> {
  try {
    return JSON.parse(content.replace(/^```json\s*|\s*```$/g, ""));
  } catch {
    return {
      document_kind: documentKind,
      confidence: "low",
      raw_text: content,
      warnings: ["El modelo no devolvió JSON parseable."],
    };
  }
}

function parseLocalizedNumber(value: string) {
  const normalized = value.replace(/\s+/g, "").replace(",", ".");
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

const SPANISH_SMALL_NUMBERS: Record<string, number> = {
  cero: 0,
  un: 1,
  uno: 1,
  una: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
  once: 11,
  doce: 12,
  trece: 13,
  catorce: 14,
  quince: 15,
  dieciseis: 16,
  dieciséis: 16,
  diecisiete: 17,
  dieciocho: 18,
  diecinueve: 19,
  veinte: 20,
  veintiuno: 21,
  veintiuna: 21,
  veintidos: 22,
  veintidós: 22,
  veintitres: 23,
  veintitrés: 23,
  veinticuatro: 24,
  veinticinco: 25,
  veintiseis: 26,
  veintiséis: 26,
  veintisiete: 27,
  veintiocho: 28,
  veintinueve: 29,
  treinta: 30,
  cuarenta: 40,
  cincuenta: 50,
  sesenta: 60,
  setenta: 70,
  ochenta: 80,
  noventa: 90,
  cien: 100,
  ciento: 100,
};

function parseSpanishNumberBelow200(value: string) {
  const words = value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/\s+/)
    .filter((word) => word !== "y")
    .filter(Boolean);
  let total = 0;
  for (const word of words) {
    const number = SPANISH_SMALL_NUMBERS[word];
    if (typeof number !== "number") return null;
    total += number;
  }
  return total > 0 ? total : null;
}

function spanishNumberWordsBeforePunto(value: string) {
  const words = value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/\s+/)
    .filter(Boolean);
  const selected: string[] = [];
  for (let index = words.length - 1; index >= 0; index -= 1) {
    const word = words[index];
    if (word === "y" || SPANISH_SMALL_NUMBERS[word] !== undefined) {
      selected.unshift(word);
      continue;
    }
    if (selected.length > 0) break;
  }
  return selected.join(" ");
}

function spanishNumberWordsAfterPunto(value: string) {
  const words = value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/\s+/)
    .filter(Boolean);
  const selected: string[] = [];
  for (const word of words) {
    if (word === "y" || SPANISH_SMALL_NUMBERS[word] !== undefined) {
      selected.push(word);
      continue;
    }
    if (selected.length > 0) break;
  }
  return selected.join(" ");
}

function parseSpanishDecimalSurface(value: string) {
  const match = value.match(/\bpunto\b/i);
  if (!match || match.index === undefined) return null;
  const integerText = spanishNumberWordsBeforePunto(value.slice(0, match.index));
  const decimalText = spanishNumberWordsAfterPunto(
    value.slice(match.index + match[0].length)
  );
  const integer = parseSpanishNumberBelow200(integerText);
  const decimal = parseSpanishNumberBelow200(decimalText);
  if (integer === null || decimal === null) return null;
  return Number(`${integer}.${String(decimal).padStart(2, "0")}`);
}

function normalizeOcrDigits(value: string) {
  return value
    .replace(/(?<=\b)[iíl|](?=\d)/gi, "1")
    .replace(/(?<=\d)[iíl|](?=\d|\b)/gi, "1")
    .replace(/(?<=\d)[oO](?=\d|\b)/g, "0")
    .replace(/(?<=\d)[sS](?=\d|\b)/g, "5");
}

export function extractSurfaceTotalM2FromTextForTest(text: string) {
  const normalized = normalizeOcrDigits(text.replace(/\s+/g, " "));
  const numberPattern = "([0-9]{1,5}(?:\\s*[.,]\\s*[0-9]{1,3})?)";
  const patterns = [
    new RegExp(
      `(?:superficie|area|área)\\s+(?:total|privativa|del\\s+terreno|de\\s+terreno|de\\s+la\\s+unidad|del\\s+inmueble)[^0-9]{0,140}${numberPattern}[^\\n]{0,160}(?:m2|m²|metros?\\s+cuadrados?)`,
      "i"
    ),
    new RegExp(
      `cuenta\\s+con\\s+una\\s+(?:superficie|area|área)\\s+total\\s+de[^0-9]{0,140}${numberPattern}[^\\n]{0,160}(?:m2|m²|metros?\\s+cuadrados?)`,
      "i"
    ),
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    const parsed = match?.[1] ? parseLocalizedNumber(match[1]) : null;
    if (parsed && parsed > 5 && parsed < 100000) return parsed;
  }
  const surfaceWindow = normalized.match(
    /(?:superficie|area|área)\s+(?:total|privativa|del\s+terreno|de\s+terreno|de\s+la\s+unidad|del\s+inmueble)[\s\S]{0,260}(?:m2|m²|metros?\s+cuadrados?)/i
  )?.[0];
  const spelledSurface = surfaceWindow ? parseSpanishDecimalSurface(surfaceWindow) : null;
  if (spelledSurface && spelledSurface > 5 && spelledSurface < 100000) {
    return spelledSurface;
  }
  return null;
}

function extractNumberNearLabel(input: {
  text: string;
  labelPattern: RegExp;
  min?: number;
  max?: number;
  windowChars?: number;
  rejectYearLike?: boolean;
}) {
  const min = typeof input.min === "number" ? input.min : 0;
  const max = typeof input.max === "number" ? input.max : 200000;
  const windowChars = typeof input.windowChars === "number" ? input.windowChars : 140;
  const normalized = normalizeOcrDigits(
    input.text
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
  );
  const regex = new RegExp(input.labelPattern.source, input.labelPattern.flags);
  const numberPattern = /([0-9]{1,6}(?:\s*[.,]\s*[0-9]{1,3})?)/g;
  let labelMatch: RegExpExecArray | null;
  while ((labelMatch = regex.exec(normalized))) {
    const start = labelMatch.index + labelMatch[0].length;
    const window = normalized.slice(
      start,
      Math.min(normalized.length, start + Math.max(30, windowChars))
    );
    let numberMatch: RegExpExecArray | null;
    while ((numberMatch = numberPattern.exec(window))) {
      const parsed = parseLocalizedNumber(numberMatch[1] ?? "");
      if (
        input.rejectYearLike &&
        parsed != null &&
        Number.isInteger(parsed) &&
        parsed >= 1900 &&
        parsed <= 2100
      ) {
        continue;
      }
      if (parsed != null && parsed >= min && parsed <= max) return parsed;
    }
  }
  return null;
}

const PREDIAL_TERR_LABEL_PATTERN =
  /sup\.?\s*terr\b|superficie\s+terreno|superficie\s+del\s+terreno|s\.?\s*terr\b/;
const PREDIAL_CONST_LABEL_PATTERN =
  /sup\.?\s*(?:const|constr)\b|superficie\s+constru(?:ccion|ccion)\b|superficie\s+de\s+constru(?:ccion|ccion)\b|s\.?\s*(?:const|constr)\b/;

function isPlausiblePredialSurfaceValue(value: number) {
  if (value < 0 || value > 5000) return false;
  if (Number.isInteger(value) && value >= 1900 && value <= 2100) return false;
  return true;
}

function parsePredialSurfaceNumbers(value: string) {
  const numberPattern = /([0-9]{1,6}(?:\s*[.,]\s*[0-9]{1,3})?)/g;
  const values: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = numberPattern.exec(value))) {
    const parsed = parseLocalizedNumber(match[1] ?? "");
    if (parsed != null && isPlausiblePredialSurfaceValue(parsed)) {
      values.push(parsed);
    }
  }
  return values;
}

function predialSurfacePairFromValues(values: number[]) {
  const surfaces = values.filter((value) => value >= 1 && value <= 5000);
  if (surfaces.length < 2) return null;
  return {
    area_total_m2: surfaces[0] ?? null,
    area_construida_m2: surfaces[1] ?? null,
  };
}

function predialSurfacePairFromDecimalWindow(window: string) {
  const decimalPair = window.match(/\b(\d{1,4}[.,]\d{1,3})\s+(\d{1,4}[.,]\d{1,3})\b/);
  if (!decimalPair) return null;
  const areaTotalM2 = parseLocalizedNumber(decimalPair[1] ?? "");
  const areaConstruidaM2 = parseLocalizedNumber(decimalPair[2] ?? "");
  if (
    areaTotalM2 == null ||
    areaConstruidaM2 == null ||
    !isPlausiblePredialSurfaceValue(areaTotalM2) ||
    !isPlausiblePredialSurfaceValue(areaConstruidaM2) ||
    areaTotalM2 < 1 ||
    areaConstruidaM2 < 1
  ) {
    return null;
  }
  return {
    area_total_m2: areaTotalM2,
    area_construida_m2: areaConstruidaM2,
  };
}

const PREDIAL_BUILT_AREA_MISREAD_MAX = 30;
const PREDIAL_BUILT_AREA_MIN_PLAUSIBLE = 10;
const PREDIAL_BUILT_AREA_MAX_PLAUSIBLE = 5000;
const PREDIAL_MISREAD_MAX_TOTAL_RATIO = 8;

function parsePredialRawSurfaceValue(value: unknown) {
  if (typeof value === "number") {
    return isPlausiblePredialSurfaceValue(value) ? value : null;
  }
  if (typeof value !== "string") return null;
  const cleaned = value.trim().replace(/\s+/g, "");
  if (!cleaned) return null;
  const parsed = Number.parseFloat(cleaned.replace(/,/g, ""));
  if (!Number.isFinite(parsed) || !isPlausiblePredialSurfaceValue(parsed)) return null;
  return parsed;
}

function isPredialTipoToken(value: unknown) {
  return typeof value === "string" && /^[A-Za-zÁÉÍÓÚÜÑ]{1,3}$/.test(value.trim());
}

export function predialSurfacesFromContribuyenteRowValuesForTest(values: unknown[]) {
  if (!Array.isArray(values) || values.length < 2) return null;
  const orderedSurfaces: number[] = [];
  let tipoSkipped = false;
  for (const item of values) {
    if (!tipoSkipped && isPredialTipoToken(item)) {
      tipoSkipped = true;
      continue;
    }
    const parsed = parsePredialRawSurfaceValue(item);
    if (parsed != null) orderedSurfaces.push(parsed);
  }
  if (orderedSurfaces.length >= 2) {
    const areaTotalM2 = orderedSurfaces[0];
    const areaConstruidaM2 = orderedSurfaces[1];
    if (
      areaTotalM2 != null &&
      areaTotalM2 >= 1 &&
      isPlausiblePredialSurfaceValue(areaTotalM2) &&
      areaConstruidaM2 != null &&
      isPlausiblePredialSurfaceValue(areaConstruidaM2)
    ) {
      return {
        area_total_m2: areaTotalM2,
        area_construida_m2: areaConstruidaM2 >= 1 ? areaConstruidaM2 : null,
      };
    }
  }
  return predialSurfacePairFromValues(orderedSurfaces.filter((value) => value >= 1));
}

function looksLikePredialBuiltAreaDecimalMisread(
  areaTotalM2: number | null,
  areaConstruidaM2: number | null
) {
  if (areaConstruidaM2 == null || areaTotalM2 == null) return false;
  if (areaConstruidaM2 >= PREDIAL_BUILT_AREA_MISREAD_MAX) return false;
  const scaled = areaConstruidaM2 * 10;
  if (scaled < PREDIAL_BUILT_AREA_MIN_PLAUSIBLE || scaled > PREDIAL_BUILT_AREA_MAX_PLAUSIBLE) {
    return false;
  }
  if (!isPlausiblePredialSurfaceValue(scaled)) return false;
  if (scaled > areaTotalM2 * PREDIAL_MISREAD_MAX_TOTAL_RATIO) return false;
  if (scaled <= areaConstruidaM2 * 5) return false;
  return true;
}

type PredialBuiltAreaQuality = {
  implausible: boolean;
  observed_m2: number | null;
  suggested_m2: number | null;
  corroborated_m2: number | null;
  corroboration_source: "predial_table_row_vision" | "predial_raw_column_vision" | null;
};

function listPredialCorroboratedBuiltAreas(
  extraction: Record<string, unknown>
): Array<{
  value: number;
  source: "predial_table_row_vision" | "predial_raw_column_vision";
}> {
  const candidates: Array<{
    value: number;
    source: "predial_table_row_vision" | "predial_raw_column_vision";
  }> = [];
  const rowValues =
    extraction.predial_contribuyente_row_values ?? extraction.predial_table_values;
  const fromRow = Array.isArray(rowValues)
    ? predialSurfacesFromContribuyenteRowValuesForTest(rowValues)?.area_construida_m2 ?? null
    : null;
  if (fromRow != null && fromRow >= 1) {
    candidates.push({ value: fromRow, source: "predial_table_row_vision" });
  }
  const fromRaw = parsePredialRawSurfaceValue(extraction.sup_const_raw) ?? null;
  if (fromRaw != null && fromRaw >= 1) {
    candidates.push({ value: fromRaw, source: "predial_raw_column_vision" });
  }
  return candidates;
}

export function evaluatePredialBuiltAreaQualityForTest(
  extraction: Record<string, unknown>
): PredialBuiltAreaQuality {
  const areaTotalM2 = firstMeaningfulValue(
    extraction.area_total_m2,
    extraction.area_m2,
    extraction.surface_m2,
    extraction.superficie_m2,
    extraction.sup_terr,
    extraction.superficie_terreno_m2
  );
  const areaConstruidaM2 = firstMeaningfulValue(
    extraction.area_construida_m2,
    extraction.construction_area_m2,
    extraction.built_area_m2,
    extraction.sup_const,
    extraction.superficie_construccion_m2
  );
  const observed_m2 = typeof areaConstruidaM2 === "number" ? areaConstruidaM2 : null;
  const total_m2 = typeof areaTotalM2 === "number" ? areaTotalM2 : null;
  if (!looksLikePredialBuiltAreaDecimalMisread(total_m2, observed_m2)) {
    return {
      implausible: false,
      observed_m2,
      suggested_m2: null,
      corroborated_m2: null,
      corroboration_source: null,
    };
  }
  const suggested_m2 = observed_m2 != null ? observed_m2 * 10 : null;
  const corroborated = listPredialCorroboratedBuiltAreas(extraction).find(
    (candidate) =>
      suggested_m2 != null && Math.abs(candidate.value - suggested_m2) <= 0.2
  );
  const corroboratesSuggestion = corroborated != null;
  return {
    implausible: !corroboratesSuggestion,
    observed_m2,
    suggested_m2,
    corroborated_m2: corroborated?.value ?? null,
    corroboration_source: corroborated?.source ?? null,
  };
}

export function normalizePredialExtractionSurfacesForTest(
  extraction: Record<string, unknown>,
  documentKind: string
) {
  if (!isPredialKind(documentKind) && !isPredialKind(extraction.document_kind)) {
    return extraction;
  }
  const enriched: Record<string, unknown> = { ...extraction };
  const warnings = [
    ...(Array.isArray(enriched.warnings)
      ? enriched.warnings.filter((item): item is string => typeof item === "string")
      : []),
  ];

  const rowValues =
    enriched.predial_contribuyente_row_values ?? enriched.predial_table_values;
  let rowHasCompleteSurfacePair = false;
  if (Array.isArray(rowValues)) {
    const fromRow = predialSurfacesFromContribuyenteRowValuesForTest(rowValues);
    rowHasCompleteSurfacePair =
      fromRow?.area_total_m2 != null && fromRow?.area_construida_m2 != null;
    if (fromRow?.area_total_m2 != null) {
      enriched.area_total_m2 = fromRow.area_total_m2;
      enriched.area_total_m2_source = "predial_table_row_vision";
      enriched.sup_terr = fromRow.area_total_m2;
    }
    if (fromRow?.area_construida_m2 != null) {
      enriched.area_construida_m2 = fromRow.area_construida_m2;
      enriched.area_construida_m2_source = "predial_table_row_vision";
      enriched.sup_const = fromRow.area_construida_m2;
    }
  }

  const terrRaw = parsePredialRawSurfaceValue(enriched.sup_terr_raw);
  const constRaw = parsePredialRawSurfaceValue(enriched.sup_const_raw);
  if (terrRaw != null && terrRaw >= 1) {
    const currentTotal =
      typeof enriched.area_total_m2 === "number" ? enriched.area_total_m2 : null;
    if (rowHasCompleteSurfacePair) {
      if (currentTotal != null && terrRaw !== currentTotal) {
        warnings.push(
          "Se ignoró SUP. TERR extraída por columna porque contradice la fila tabular del predial."
        );
      }
    } else {
      enriched.area_total_m2 = terrRaw;
      enriched.area_total_m2_source =
        enriched.area_total_m2_source ?? "predial_raw_column_vision";
      enriched.sup_terr = terrRaw;
    }
  }
  if (constRaw != null && constRaw >= 1) {
    const currentBuilt =
      typeof enriched.area_construida_m2 === "number" ? enriched.area_construida_m2 : null;
    if (rowHasCompleteSurfacePair) {
      if (currentBuilt != null && constRaw !== currentBuilt) {
        warnings.push(
          "Se ignoró SUP. CONST extraída por columna porque contradice la fila tabular del predial."
        );
      }
    } else {
      enriched.area_construida_m2 = constRaw;
      enriched.area_construida_m2_source = "predial_raw_column_vision";
      enriched.sup_const = constRaw;
    }
  }

  const quality = evaluatePredialBuiltAreaQualityForTest(enriched);
  if (!quality.implausible && quality.suggested_m2 != null) {
    const currentBuilt =
      typeof enriched.area_construida_m2 === "number" ? enriched.area_construida_m2 : null;
    if (
      currentBuilt != null &&
      quality.corroborated_m2 != null &&
      Math.abs(currentBuilt - quality.suggested_m2) <= 0.2 &&
      Math.abs(quality.corroborated_m2 - quality.suggested_m2) <= 0.2
    ) {
      enriched.area_construida_m2 = quality.corroborated_m2;
      enriched.area_construida_m2_source =
        quality.corroboration_source === "predial_table_row_vision"
          ? "predial_table_row_reconciled"
          : "predial_raw_column_reconciled";
      enriched.sup_const = quality.corroborated_m2;
      warnings.push(
        `Se corrigió SUP. CONST de ${currentBuilt} m² a ${quality.corroborated_m2} m² por corroboración tabular/raw del predial.`
      );
      enriched.predial_area_construida_quality = {
        status: "reconciled_decimal_misread",
        observed_m2: currentBuilt,
        corrected_m2: quality.corroborated_m2,
        source: quality.corroboration_source,
      };
    }
  } else if (
    quality.implausible &&
    quality.suggested_m2 != null &&
    quality.observed_m2 != null
  ) {
    warnings.push(
      `SUP. CONST implausible (${quality.observed_m2} m²). Posible corrimiento decimal; revisar contra documento fuente (sugerido: ${quality.suggested_m2} m²).`
    );
    enriched.predial_area_construida_quality = {
      status: "implausible_decimal_misread_suspected",
      observed_m2: quality.observed_m2,
      suggested_m2: quality.suggested_m2,
    };
  }

  if (warnings.length > 0) {
    enriched.warnings = warnings.filter((item, index, items) => items.indexOf(item) === index);
  }
  return enriched;
}

function predialNeedsContribuyenteRowRetry(extraction: Record<string, unknown>) {
  const rowValues =
    extraction.predial_contribuyente_row_values ?? extraction.predial_table_values;
  const rowBuilt =
    Array.isArray(rowValues) &&
    predialSurfacesFromContribuyenteRowValuesForTest(rowValues)?.area_construida_m2 != null;
  const rawBuilt = parsePredialRawSurfaceValue(extraction.sup_const_raw) ?? null;
  const areaTotalM2 =
    typeof extraction.area_total_m2 === "number" ? extraction.area_total_m2 : null;
  const areaConstruidaM2 =
    typeof extraction.area_construida_m2 === "number" ? extraction.area_construida_m2 : null;
  if (areaConstruidaM2 == null) return true;
  if (looksLikePredialBuiltAreaDecimalMisread(areaTotalM2, areaConstruidaM2)) return true;
  if (!rowBuilt && (rawBuilt == null || rawBuilt < 1)) return true;
  return false;
}

function extractPredialSurfacePairFromTableText(text: string): {
  area_total_m2: number | null;
  area_construida_m2: number | null;
} {
  const normalized = normalizeOcrDigits(
    text
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
  );
  const flat = normalized.replace(/\s+/g, " ");
  const headerThenValues = new RegExp(
    `${PREDIAL_TERR_LABEL_PATTERN.source}[\\s\\S]{0,240}${PREDIAL_CONST_LABEL_PATTERN.source}([\\s\\S]{0,720})`,
    "i"
  ).exec(flat);
  if (headerThenValues?.[1]) {
    const decimalPair = predialSurfacePairFromDecimalWindow(headerThenValues[1]);
    if (decimalPair) return decimalPair;
    const values = parsePredialSurfaceNumbers(headerThenValues[1]);
    const pair = predialSurfacePairFromValues(values);
    if (pair) return pair;
  }
  const lines = normalized
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const hasTerr = PREDIAL_TERR_LABEL_PATTERN.test(line);
    const hasConst = PREDIAL_CONST_LABEL_PATTERN.test(line);
    if (!hasTerr || !hasConst) continue;
    const candidateWindow = [lines[index + 1], lines[index + 2], lines[index + 3], lines[index + 4]]
      .filter((part): part is string => Boolean(part))
      .join(" ");
    if (!candidateWindow) continue;
    const decimalPair = predialSurfacePairFromDecimalWindow(candidateWindow);
    if (decimalPair) return decimalPair;
    const values = parsePredialSurfaceNumbers(candidateWindow);
    const pair = predialSurfacePairFromValues(values);
    if (pair) return pair;
  }
  return { area_total_m2: null, area_construida_m2: null };
}

export function extractPredialSurfacesFromTextForTest(text: string) {
  const total = extractNumberNearLabel({
    text,
    labelPattern:
      /sup\.?\s*terr\b|superficie\s+(?:del\s+)?terreno\b|superficie\s+terreno\b|s\.?\s*terr\b/gi,
    min: 1,
    max: 5000,
    windowChars: 320,
    rejectYearLike: true,
  });
  const built = extractNumberNearLabel({
    text,
    labelPattern:
      /sup\.?\s*(?:const|constr)\b|superficie\s+constru(?:ccion|ccion)\b|superficie\s+de\s+constru(?:ccion|ccion)\b|s\.?\s*(?:const|constr)\b/gi,
    min: 0,
    max: 5000,
    windowChars: 320,
    rejectYearLike: true,
  });
  const tablePair = extractPredialSurfacePairFromTableText(text);
  return {
    area_total_m2: tablePair.area_total_m2 ?? total,
    area_construida_m2: tablePair.area_construida_m2 ?? built,
  };
}

function enrichExtractionFromText(
  extraction: Record<string, unknown>,
  documentKind: string,
  text: string
) {
  const enriched: Record<string, unknown> = {
    ...extraction,
    document_kind: documentKind,
  };
  if (typeof enriched.area_total_m2 !== "number") {
    const areaTotalM2 = extractSurfaceTotalM2FromTextForTest(text);
    if (areaTotalM2 !== null) {
      enriched.area_total_m2 = areaTotalM2;
      enriched.area_total_m2_source = "pdf_text_surface_phrase";
    }
  }
  if (
    documentKind.toLowerCase().includes("predial") ||
    normalizePropertyDataValue(String(enriched.document_kind ?? "")).includes("predial")
  ) {
    const predialSurfaces = extractPredialSurfacesFromTextForTest(text);
    if (
      typeof enriched.area_total_m2 !== "number" &&
      predialSurfaces.area_total_m2 != null
    ) {
      enriched.area_total_m2 = predialSurfaces.area_total_m2;
      enriched.area_total_m2_source = "predial_label_parser";
      enriched.sup_terr = predialSurfaces.area_total_m2;
    }
    if (
      typeof enriched.area_construida_m2 !== "number" &&
      predialSurfaces.area_construida_m2 != null
    ) {
      enriched.area_construida_m2 = predialSurfaces.area_construida_m2;
      enriched.area_construida_m2_source = "predial_label_parser";
      enriched.sup_const = predialSurfaces.area_construida_m2;
    }
  }
  return normalizePredialExtractionSurfacesForTest(enriched, documentKind);
}

function isPropertyDeedKind(value: unknown) {
  return typeof value === "string" && value.toLowerCase().includes("escritura");
}

type DeedPropertyHint = {
  zone?: string | null;
  exterior_number?: string | null;
  municipality?: string | null;
  street?: string | null;
};

const DEED_MIN_CONFIDENT_MATCH_SCORE = 4;

function firstHintString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function normalizeForMatch(value: unknown): string {
  return typeof value === "string"
    ? value
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9 ]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    : "";
}

async function deedTargetHintFromCase(
  db: DbClient,
  caseId: string | null | undefined
): Promise<DeedPropertyHint> {
  if (!caseId) return {};
  const opCase = await getOperationalCase(db, caseId).catch(() => null);
  const context = isRecord(opCase?.context_jsonb) ? opCase.context_jsonb : {};
  const propertyData = isRecord(context.property_data)
    ? context.property_data
    : context;
  const address = isRecord(propertyData.address) ? propertyData.address : {};
  return {
    zone: firstHintString(
      propertyData.property_zone,
      propertyData.zona,
      address.neighborhood,
      address.colonia,
      propertyData.colonia,
      propertyData.neighborhood,
      context.property_zone
    ),
    exterior_number: firstHintString(
      address.exterior_number,
      address.numero_exterior,
      propertyData.exterior_number,
      propertyData.numero_exterior
    ),
    municipality: firstHintString(
      address.municipality,
      address.municipio,
      propertyData.municipality,
      propertyData.municipio,
      propertyData.city
    ),
    street: firstHintString(address.street, propertyData.street, propertyData.calle),
  };
}

function scoreDeedProperty(property: Record<string, unknown>, hint: DeedPropertyHint): number {
  const addr = isRecord(property.address) ? property.address : {};
  const haystack = [
    property.property_description,
    addr.street,
    addr.neighborhood,
    addr.colonia,
    addr.municipality,
    addr.state,
  ]
    .map(normalizeForMatch)
    .filter(Boolean)
    .join(" ");
  let score = 0;
  if (hint.exterior_number) {
    const n = normalizeForMatch(hint.exterior_number);
    const propNum = normalizeForMatch(addr.exterior_number);
    if (n) {
      if (propNum && propNum === n) score += 5;
      else if (haystack.includes(` ${n} `) || haystack.includes(`numero ${n}`)) {
        score += 4;
      }
    }
  }
  if (hint.zone) {
    const z = normalizeForMatch(hint.zone);
    if (z) {
      if (haystack.includes(z)) score += 3;
      else {
        const tokens = z.split(" ").filter((t) => t.length >= 4);
        if (tokens.length > 0 && tokens.every((t) => haystack.includes(t))) score += 2;
      }
    }
  }
  if (hint.street) {
    const s = normalizeForMatch(hint.street);
    if (s && haystack.includes(s)) score += 2;
  }
  if (hint.municipality) {
    const m = normalizeForMatch(hint.municipality);
    if (m && (normalizeForMatch(addr.municipality).includes(m) || haystack.includes(m))) {
      score += 1;
    }
  }
  return score;
}

function applyDeedProperty(
  target: Record<string, unknown>,
  property: Record<string, unknown>
) {
  if (isRecord(property.address)) {
    target.address = {
      ...(isRecord(target.address) ? target.address : {}),
      ...property.address,
    };
  }
  if (typeof property.area_total_m2 === "number") {
    target.area_total_m2 = property.area_total_m2;
  }
  if (typeof property.area_construida_m2 === "number") {
    target.area_construida_m2 = property.area_construida_m2;
  }
  if (
    typeof property.property_description === "string" &&
    property.property_description.trim().length > 0
  ) {
    target.property_description = property.property_description;
  }
}

function dedupeStrings(values: string[]): string[] {
  return values.filter((item, index, items) => items.indexOf(item) === index);
}

/**
 * Para escrituras que describen múltiples inmuebles (p. ej. sucesión), elige
 * deterministamente el inmueble que coincide con el del caso usando un hint de
 * dirección (número exterior/finca, zona/colonia, calle, municipio) y sobre-
 * escribe los campos planos con ese inmueble. Preserva `all_properties` para
 * auditoría y agrega warnings cuando hay ambigüedad o falta de coincidencia.
 */
function selectDeedPropertyFromExtraction(
  extraction: Record<string, unknown>,
  hint: DeedPropertyHint
): Record<string, unknown> {
  if (!isPropertyDeedKind(extraction.document_kind)) return extraction;
  const properties = Array.isArray(extraction.properties)
    ? extraction.properties.filter(isRecord)
    : [];
  if (properties.length === 0) return extraction;

  const result: Record<string, unknown> = { ...extraction, all_properties: properties };
  const warnings = Array.isArray(extraction.warnings)
    ? extraction.warnings.filter((item): item is string => typeof item === "string")
    : [];

  if (properties.length === 1) {
    applyDeedProperty(result, properties[0]);
    result.selected_property_index = 0;
    if (warnings.length > 0) result.warnings = dedupeStrings(warnings);
    return result;
  }

  const hasHint = Boolean(hint.exterior_number || hint.zone || hint.street);
  if (!hasHint) {
    warnings.push(
      "La escritura describe múltiples inmuebles y no hay datos del inmueble objetivo para desambiguar; se usó el principal. Verifica que corresponda al inmueble del caso."
    );
    result.multi_property_ambiguous = true;
    result.warnings = dedupeStrings(warnings);
    return result;
  }

  const scored = properties
    .map((property, index) => ({ index, property, score: scoreDeedProperty(property, hint) }))
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.score <= 0) {
    warnings.push(
      "La escritura describe múltiples inmuebles y ninguno coincide claramente con el inmueble del caso; se mantuvo el principal. Revisión humana recomendada."
    );
    result.multi_property_ambiguous = true;
    result.deed_property_match_low_confidence = true;
    result.selected_property_match_score = best?.score ?? 0;
    result.warnings = dedupeStrings(warnings);
    return result;
  }
  if (best.score < DEED_MIN_CONFIDENT_MATCH_SCORE) {
    warnings.push(
      "La escritura describe múltiples inmuebles pero la coincidencia con el inmueble objetivo no fue suficientemente confiable; se mantuvo el principal. Revisión humana recomendada."
    );
    result.multi_property_ambiguous = true;
    result.deed_property_match_low_confidence = true;
    result.selected_property_match_score = best.score;
    result.warnings = dedupeStrings(warnings);
    return result;
  }

  applyDeedProperty(result, best.property);
  result.selected_property_index = best.index;
  result.selected_property_match_score = best.score;
  const hintLabel = [
    hint.exterior_number ? `no. ext. ${hint.exterior_number}` : null,
    hint.zone ?? null,
  ]
    .filter(Boolean)
    .join(", ");
  warnings.push(
    `La escritura describe ${properties.length} inmuebles; se seleccionó el que coincide con el inmueble del caso${hintLabel ? ` (${hintLabel})` : ""}.`
  );
  const tie = scored.length > 1 && scored[1].score === best.score;
  if (tie) {
    warnings.push(
      "Hubo empate al desambiguar inmuebles de la escritura; revisión humana recomendada."
    );
    result.multi_property_ambiguous = true;
  }
  result.warnings = dedupeStrings(warnings);
  return result;
}

function isPredialKind(value: unknown) {
  return typeof value === "string" && value.toLowerCase().includes("predial");
}

function isBoletaRegistralKind(value: unknown) {
  if (typeof value !== "string") return false;
  const normalized = value.toLowerCase();
  return normalized.includes("boleta") || normalized.includes("registral");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function needsPdfVisionSupplement(input: {
  documentKind: string;
  extraction: Record<string, unknown>;
}) {
  if (isPropertyDeedKind(input.documentKind)) {
    return typeof input.extraction.area_total_m2 !== "number";
  }
  if (isPredialKind(input.documentKind)) {
    if (typeof input.extraction.area_construida_m2 !== "number") return true;
    const quality = evaluatePredialBuiltAreaQualityForTest(input.extraction);
    return quality.implausible;
  }
  return false;
}

function pdfVisionSupplementWarning(documentKind: string) {
  if (isPredialKind(documentKind)) {
    return "La capa de texto del PDF no trajo superficie de construcción; se complementó con visión sobre la primera página.";
  }
  return "La capa de texto del PDF no trajo superficie; se complementó con visión sobre la primera página.";
}

function mergeDocumentExtractions(
  primary: Record<string, unknown>,
  supplement: Record<string, unknown>,
  extractionSource: string
) {
  const merged: Record<string, unknown> = { ...primary };
  for (const key of [
    "area_total_m2",
    "area_construida_m2",
    "property_description",
    "folio_real",
    "predial_account",
    "area_total_m2_source",
    "area_construida_m2_source",
  ] as const) {
    const primaryValue = merged[key];
    const supplementValue = supplement[key];
    if (
      (primaryValue == null || primaryValue === "") &&
      supplementValue != null &&
      supplementValue !== ""
    ) {
      merged[key] = supplementValue;
    }
  }
  const primaryOwners = Array.isArray(merged.owner_names) ? merged.owner_names : [];
  const supplementOwners = Array.isArray(supplement.owner_names)
    ? supplement.owner_names
    : [];
  if (primaryOwners.length === 0 && supplementOwners.length > 0) {
    merged.owner_names = supplementOwners;
  }
  if (isRecord(supplement.address)) {
    merged.address = {
      ...(isRecord(merged.address) ? merged.address : {}),
      ...supplement.address,
    };
  }
  const warnings = [
    ...(Array.isArray(merged.warnings) ? merged.warnings : []),
    ...(Array.isArray(supplement.warnings) ? supplement.warnings : []),
  ].filter((item, index, items) => items.indexOf(item) === index);
  if (warnings.length > 0) merged.warnings = warnings;
  merged.extraction_source = extractionSource;
  return merged;
}

async function renderPdfFirstPageDataUrl(
  parser: PDFParse,
  options?: { desiredWidth?: number }
) {
  const screenshot = await parser.getScreenshot({
    first: 1,
    desiredWidth: options?.desiredWidth ?? 1800,
    imageDataUrl: true,
    imageBuffer: false,
  });
  return screenshot.pages[0]?.dataUrl ?? null;
}

function extractionStatusFor(extraction: Record<string, unknown>) {
  const confidence =
    typeof extraction.confidence === "string" ? extraction.confidence : "low";
  return confidence === "high" || confidence === "medium" ? "ok" : "low_confidence";
}

async function callOpenRouterForJson(input: {
  apiKey: string;
  model: string;
  messages: Array<Record<string, unknown>>;
}) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${input.apiKey}`,
      "HTTP-Referer": "https://agents.local",
    },
    body: JSON.stringify({
      model: input.model,
      temperature: 0,
      max_tokens: 900,
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
  return content;
}

async function extractPredialContribuyenteRowFromImage(input: {
  apiKey: string;
  documentKind: string;
  dataUrl: string;
}) {
  const content = await callOpenRouterForJson({
    apiKey: input.apiKey,
    model: VISION_EXTRACTION_MODEL,
    messages: [
      {
        role: "system",
        content:
          "Extrae datos tabulares de recibos prediales mexicanos. Devuelve exclusivamente JSON válido sin markdown. " +
          PREDIAL_VISION_TABLE_GUIDANCE,
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              `Documento tipo ${input.documentKind}. Devuelve sólo este shape: ` +
              `${PREDIAL_VISION_ROW_ONLY_JSON_SHAPE}. ${PREDIAL_VISION_TABLE_GUIDANCE} No inventes datos.`,
          },
          { type: "image_url", image_url: { url: input.dataUrl } },
        ],
      },
    ],
  });
  return parseModelJson(content, input.documentKind);
}

async function extractDocumentFieldsFromImage(input: {
  apiKey: string;
  documentKind: string;
  dataUrl: string;
}) {
  const isPredial = isPredialKind(input.documentKind);
  const isDeed = isPropertyDeedKind(input.documentKind);
  const isBoleta = isBoletaRegistralKind(input.documentKind);
  const jsonShape = isPredial
    ? PREDIAL_VISION_EXTRACTION_JSON_SHAPE
    : isDeed
      ? DEED_EXTRACTION_JSON_SHAPE
      : DOCUMENT_EXTRACTION_JSON_SHAPE;
  const predialGuidance = isPredial ? PREDIAL_VISION_TABLE_GUIDANCE : "";
  const deedGuidance = isDeed ? DEED_MULTI_PROPERTY_GUIDANCE : "";
  const boletaGuidance = isBoleta ? BOLETA_LEGAL_ADDRESS_GUIDANCE : "";
  const content = await callOpenRouterForJson({
    apiKey: input.apiKey,
    model: VISION_EXTRACTION_MODEL,
    messages: [
      {
        role: "system",
        content:
          "Extrae datos inmobiliarios de documentos mexicanos. Devuelve exclusivamente JSON válido sin markdown. " +
          PROPERTY_AREA_EXTRACTION_GUIDANCE +
          predialGuidance +
          deedGuidance +
          boletaGuidance,
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              `Documento tipo ${input.documentKind}. Extrae sólo lo visible con este shape: ` +
              `${jsonShape}. ${PROPERTY_AREA_EXTRACTION_GUIDANCE}${predialGuidance}${deedGuidance}${boletaGuidance} No inventes datos; usa null cuando no esté visible.`,
          },
          { type: "image_url", image_url: { url: input.dataUrl } },
        ],
      },
    ],
  });
  const parsed = parseModelJson(content, input.documentKind);
  if (!isPredial) return parsed;
  let normalizedPredial = normalizePredialExtractionSurfacesForTest(
    parsed,
    input.documentKind
  );
  if (predialNeedsContribuyenteRowRetry(normalizedPredial)) {
    const rowRetry = await extractPredialContribuyenteRowFromImage(input);
    normalizedPredial = normalizePredialExtractionSurfacesForTest(
      { ...normalizedPredial, ...rowRetry },
      input.documentKind
    );
    const warnings = [
      ...(Array.isArray(normalizedPredial.warnings)
        ? normalizedPredial.warnings.filter((item): item is string => typeof item === "string")
        : []),
      "Se ejecutó un segundo pase de lectura tabular del predial para validar SUP. TERR y SUP. CONST.",
    ];
    normalizedPredial.warnings = warnings.filter(
      (item, index, items) => items.indexOf(item) === index
    );
  }
  return normalizedPredial;
}

async function extractDocumentFieldsFromText(input: {
  apiKey: string;
  documentKind: string;
  text: string;
}) {
  const isDeed = isPropertyDeedKind(input.documentKind);
  const isBoleta = isBoletaRegistralKind(input.documentKind);
  const jsonShape = isDeed
    ? DEED_EXTRACTION_JSON_SHAPE
    : DOCUMENT_EXTRACTION_JSON_SHAPE;
  const deedGuidance = isDeed ? DEED_MULTI_PROPERTY_GUIDANCE : "";
  const boletaGuidance = isBoleta ? BOLETA_LEGAL_ADDRESS_GUIDANCE : "";
  const content = await callOpenRouterForJson({
    apiKey: input.apiKey,
    model: PDF_TEXT_EXTRACTION_MODEL,
    messages: [
      {
        role: "system",
        content:
          "Extrae datos inmobiliarios de documentos mexicanos a partir de texto OCR/PDF. Devuelve exclusivamente JSON válido sin markdown. " +
          PROPERTY_AREA_EXTRACTION_GUIDANCE +
          deedGuidance +
          boletaGuidance,
      },
      {
        role: "user",
        content:
          `Documento tipo ${input.documentKind}. Extrae sólo datos presentes en el texto con este shape: ` +
          `${jsonShape}. ${PROPERTY_AREA_EXTRACTION_GUIDANCE}${deedGuidance}${boletaGuidance} No inventes datos; usa null cuando no esté visible.\n\n` +
          input.text.slice(0, 24000),
      },
    ],
  });
  return enrichExtractionFromText(
    parseModelJson(content, input.documentKind),
    input.documentKind,
    input.text
  );
}

function predialPdfScreenshotWidth(documentKind: string) {
  return isPredialKind(documentKind) ? 2400 : 1800;
}

async function extractPdfDocumentFields(input: {
  apiKey: string;
  documentKind: string;
  bytes: Buffer;
}) {
  ensurePdfWorkerConfigured();
  const parser = new PDFParse({ data: Uint8Array.from(input.bytes) });
  try {
    const textResult = await parser.getText({
      first: 5,
      pageJoiner: "\n\n--- page_number of total_number ---\n\n",
    });
    const normalizedText = textResult.text.replace(/\s+/g, " ").trim();
    if (normalizedText.length >= 120) {
      const textExtraction = await extractDocumentFieldsFromText({
        apiKey: input.apiKey,
        documentKind: input.documentKind,
        text: textResult.text,
      });
      if (
        needsPdfVisionSupplement({
          documentKind: input.documentKind,
          extraction: textExtraction,
        })
      ) {
        const dataUrl = await renderPdfFirstPageDataUrl(parser, {
          desiredWidth: predialPdfScreenshotWidth(input.documentKind),
        });
        if (dataUrl) {
          const visionExtraction = enrichExtractionFromText(
            await extractDocumentFieldsFromImage({
              apiKey: input.apiKey,
              documentKind: input.documentKind,
              dataUrl,
            }),
            input.documentKind,
            textResult.text
          );
          const warnings = [
            ...(Array.isArray(textExtraction.warnings) ? textExtraction.warnings : []),
            pdfVisionSupplementWarning(input.documentKind),
          ];
          return {
            model: VISION_EXTRACTION_MODEL,
            extraction: {
              ...mergeDocumentExtractions(
                textExtraction,
                visionExtraction,
                "pdf_text_plus_vision"
              ),
              warnings,
            },
          };
        }
      }
      return {
        model: PDF_TEXT_EXTRACTION_MODEL,
        extraction: {
          ...textExtraction,
          extraction_source: "pdf_text",
        },
      };
    }

    const dataUrl = await renderPdfFirstPageDataUrl(parser, {
      desiredWidth: predialPdfScreenshotWidth(input.documentKind),
    });
    if (dataUrl) {
      const imageExtraction = await extractDocumentFieldsFromImage({
        apiKey: input.apiKey,
        documentKind: input.documentKind,
        dataUrl,
      });
      const warnings = Array.isArray(imageExtraction.warnings)
        ? imageExtraction.warnings
        : [];
      return {
        model: VISION_EXTRACTION_MODEL,
        extraction: {
          ...imageExtraction,
          extraction_source: "pdf_rendered_first_page",
          warnings: [
            ...warnings,
            "PDF sin texto suficiente; se renderizó la primera página como imagen.",
          ],
        },
      };
    }
    return {
      model: PDF_TEXT_EXTRACTION_MODEL,
      extraction: {
        document_kind: input.documentKind,
        confidence: "low",
        extraction_source: "pdf_unreadable",
        warnings: [
          "No se pudo extraer texto suficiente ni renderizar la primera página del PDF.",
        ],
      },
    };
  } catch (err) {
    return {
      model: PDF_TEXT_EXTRACTION_MODEL,
      extraction: {
        document_kind: input.documentKind,
        confidence: "low",
        extraction_source: "pdf_failed",
        warnings: [
          `No se pudo procesar el PDF: ${err instanceof Error ? err.message : String(err)}`,
        ],
      },
    };
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

function shouldUseCachedExtraction(input: {
  force?: boolean;
  contentType: string;
  extractionStatus: string;
  extraction: Record<string, unknown>;
}) {
  const extractionDocumentKind =
    typeof input.extraction.document_kind === "string"
      ? input.extraction.document_kind
      : "";
  if (input.force) return false;
  if (Object.keys(input.extraction ?? {}).length === 0) return false;
  if (
    input.contentType === "application/pdf" &&
    isPropertyDeedKind(input.extraction.document_kind) &&
    typeof input.extraction.area_total_m2 !== "number"
  ) {
    return false;
  }
  if (
    isPredialKind(extractionDocumentKind) &&
    typeof input.extraction.area_total_m2 !== "number"
  ) {
    return false;
  }
  if (input.extractionStatus === "ok") return true;
  if (input.extractionStatus !== "low_confidence") return false;
  if (input.contentType === "application/pdf") {
    return (
      input.extraction.extraction_source === "pdf_text_plus_vision" ||
      input.extraction.extraction_source === "pdf_rendered_first_page"
    );
  }
  return true;
}

export type DocumentFieldExtractionResult =
  | {
      ok: true;
      cached: boolean;
      reused_from_document_id?: string;
      document_id: string;
      extraction_status: string;
      extraction: Record<string, unknown> | null | undefined;
    }
  | { ok: false; error: string };

/**
 * Núcleo reutilizable de extracción documental multimodal (texto PDF + Vision).
 *
 * Antes vivía solo dentro del closure de la tool `operational_case_extract_document_fields`.
 * Extraído para que tanto el LLM (vía la tool) como el código determinístico
 * (invariante post-agente auto-remediante, WS3) puedan dispararla sin pasar por
 * el grafo del agente. No registra auditoría de `tool_calls`: ese wrapper es
 * responsabilidad del caller (la tool sí lo hace).
 */
export async function runDocumentFieldExtraction(
  db: DbClient,
  params: { userId: string; documentId: string; force?: boolean }
): Promise<DocumentFieldExtractionResult> {
  const document = await getOperationalCaseDocument(db, params.documentId);
  if (!document || document.user_id !== params.userId) {
    return { ok: false, error: "document_not_found_or_forbidden" };
  }
  const contentType = document.content_type ?? "";
  if (
    shouldUseCachedExtraction({
      force: params.force,
      contentType,
      extractionStatus: document.extraction_status,
      extraction: document.extraction_jsonb ?? {},
    })
  ) {
    return {
      ok: true,
      cached: true,
      document_id: document.id,
      extraction_status: document.extraction_status,
      extraction: document.extraction_jsonb,
    };
  }
  if (!params.force && document.sha256) {
    const previous = await findExtractedOperationalCaseDocumentByHash(db, {
      caseId: document.case_id,
      kind: document.kind,
      sha256: document.sha256,
      excludeDocumentId: document.id,
    });
    if (
      previous &&
      shouldUseCachedExtraction({
        contentType,
        extractionStatus: previous.extraction_status,
        extraction: previous.extraction_jsonb ?? {},
      })
    ) {
      const updated = await updateOperationalCaseDocumentExtraction(db, {
        documentId: document.id,
        status: previous.extraction_status,
        model: previous.extraction_model,
        extraction: {
          ...previous.extraction_jsonb,
          reused_from_document_id: previous.id,
        },
      });
      return {
        ok: true,
        cached: true,
        reused_from_document_id: previous.id,
        document_id: document.id,
        extraction_status: updated.extraction_status,
        extraction: updated.extraction_jsonb,
      };
    }
  }
  const { data: blob, error: downloadError } = await db.storage
    .from(document.storage_bucket)
    .download(document.storage_path);
  if (downloadError || !blob) {
    return { ok: false, error: downloadError?.message ?? "storage_download_failed" };
  }
  const bytes = Buffer.from(await blob.arrayBuffer());
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return { ok: false, error: "missing_openrouter_api_key" };
  }

  let extractionResult: { model: string; extraction: Record<string, unknown> };
  try {
    if (contentType === "application/pdf") {
      extractionResult = await extractPdfDocumentFields({
        apiKey,
        documentKind: document.kind,
        bytes,
      });
    } else if (contentType.startsWith("image/")) {
      const dataUrl = `data:${contentType};base64,${bytes.toString("base64")}`;
      extractionResult = {
        model: VISION_EXTRACTION_MODEL,
        extraction: {
          ...(await extractDocumentFieldsFromImage({
            apiKey,
            documentKind: document.kind,
            dataUrl,
          })),
          extraction_source: "image",
        },
      };
    } else {
      extractionResult = {
        model: VISION_EXTRACTION_MODEL,
        extraction: {
          document_kind: document.kind,
          confidence: "low",
          extraction_source: "unsupported_content_type",
          warnings: [
            `Tipo de archivo no soportado para extracción: ${contentType || "sin content-type"}.`,
          ],
        },
      };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  // Escrituras multi-inmueble (p. ej. sucesión): seleccionar deterministamente
  // el inmueble del caso usando un hint de dirección antes de persistir.
  if (isPropertyDeedKind(document.kind)) {
    const hint = await deedTargetHintFromCase(db, document.case_id);
    extractionResult = {
      model: extractionResult.model,
      extraction: selectDeedPropertyFromExtraction(extractionResult.extraction, hint),
    };
  }
  const updated = await updateOperationalCaseDocumentExtraction(db, {
    documentId: document.id,
    status: extractionStatusFor(extractionResult.extraction),
    model: extractionResult.model,
    extraction: extractionResult.extraction,
  });
  return {
    ok: true,
    cached: false,
    document_id: document.id,
    extraction_status: updated.extraction_status,
    extraction: updated.extraction_jsonb,
  };
}

export type NotifyUserFn = (
  db: ToolContext["db"],
  userId: string,
  payload: { text: string; kind?: string; data?: Record<string, unknown> },
  urgency?: "low" | "normal" | "high"
) => Promise<{
  delivered: Array<{ channel: string; ok: boolean; reason?: string }>;
  attempted: Array<{ channel: string; ok: boolean; reason?: string }>;
}>;

interface NotifyDeps {
  notifyUser: NotifyUserFn;
}

/**
 * PATTERN_GATED_TRANSITION_WITH_OWNED_REMEDIATION — fuente única de verdad.
 *
 * Un solo predicado determinístico decide si un caso `property_optioning`
 * puede avanzar a la transición destino, y para cada bloqueo declara QUIÉN es
 * responsable de remediarlo (`remediation.owner`):
 *  - `deterministic`: trabajo mecánico que el código puede disparar solo
 *    (re-OCR de un documento ya subido con `force=true`, texto + Vision).
 *  - `external`: falta un dato del inmueble que solo el dueño puede aportar.
 *  - `human`: requiere juicio/responsabilidad del asesor (HITL).
 *  - `llm`: requiere interpretación de lenguaje natural (merge con criterio).
 *
 * Consumido por el tool gate de `notify_user(property_data_review)` y por el
 * invariante post-agente. Antes existían tres copias divergentes de esta
 * lógica (regex vs señales documentales); esta función las reemplaza.
 *
 * Desacople por `targetTransition` (WS2/WS4):
 *  - `comparables_in_progress`: solo características del inmueble (predial +
 *    mínimos). La corroboración de titularidad NO bloquea aquí.
 *  - `contract_pending`: corroboración de identidad + estado de titularidad.
 */
export type PropertyAdvanceTransition =
  | "comparables_in_progress"
  | "contract_pending";

export type PropertyAdvanceGateBlockReason =
  | "boleta_extraction_pending"
  | "boleta_owner_or_address_missing"
  | "predial_extraction_pending"
  | "predial_area_total_missing"
  | "predial_area_construida_missing"
  | "predial_area_construida_implausible"
  | "characteristics_minimums_missing"
  | "owner_corroboration_extraction_pending"
  | "titularidad_unverified";

export type PropertyAdvanceRemediationOwner =
  | "deterministic"
  | "external"
  | "human"
  | "llm";

export type PropertyAdvanceGateBlock = {
  reason: PropertyAdvanceGateBlockReason;
  remediation: {
    owner: PropertyAdvanceRemediationOwner;
    /** Documentos a re-extraer cuando `owner === "deterministic"`. */
    document_ids?: string[];
    /** Campos faltantes cuando `owner === "external"`. */
    missing_fields?: Array<{ key: string; label: string }>;
    /** Estado de titularidad cuando `owner === "human"`. */
    titularidad_status?: OwnerConsistencyStatus;
    /** Valor observado cuando hay implausibilidad de superficie construida. */
    observed_value_m2?: number;
    /** Valor sugerido cuando hay sospecha de corrimiento decimal. */
    suggested_value_m2?: number;
  };
};

export type PropertyAdvanceGateResult = {
  satisfied: boolean;
  blocks: PropertyAdvanceGateBlock[];
};

const PREDIAL_AREA_TOTAL_PATHS = [
  "area_total_m2",
  "area_m2",
  "surface_m2",
  "superficie_m2",
  "sup_terr",
  "superficie_terreno_m2",
] as const;

const PREDIAL_AREA_CONSTRUIDA_PATHS = [
  "area_construida_m2",
  "construction_area_m2",
  "built_area_m2",
  "sup_const",
  "superficie_construccion_m2",
] as const;

const PENDING_EXTRACTION_STATUSES = ["pending", "failed", "not_applicable"];
const USABLE_EXTRACTION_STATUSES = ["ok", "low_confidence"];

function predialAdvanceBlocks(input: {
  propertyType: string;
  documents: OperationalCaseDocument[];
}): PropertyAdvanceGateBlock[] {
  const predials = input.documents.filter(
    (document) => document.status !== "superseded" && isPredialDocumentCandidate(document)
  );
  if (predials.length === 0) return [];
  const pending = predials.filter((document) =>
    PENDING_EXTRACTION_STATUSES.includes(document.extraction_status)
  );
  if (pending.length > 0) {
    return [
      {
        reason: "predial_extraction_pending",
        remediation: {
          owner: "deterministic",
          document_ids: pending.map((document) => document.id),
        },
      },
    ];
  }
  const extractedPredials = predials.filter((document) =>
    USABLE_EXTRACTION_STATUSES.includes(document.extraction_status)
  );
  const extractedIds = extractedPredials.map((document) => document.id);
  const hasTotal = extractedPredials.some((document) =>
    hasMeaningfulValue(
      firstMeaningfulValue(
        ...PREDIAL_AREA_TOTAL_PATHS.map((path) => document.extraction_jsonb?.[path])
      )
    )
  );
  if (!hasTotal) {
    return [
      {
        reason: "predial_area_total_missing",
        remediation: { owner: "deterministic", document_ids: extractedIds },
      },
    ];
  }
  const requiresBuiltArea = propertyTypeRequirementKey(input.propertyType) === "casa";
  const hasBuiltArea = extractedPredials.some((document) =>
    hasMeaningfulValue(
      firstMeaningfulValue(
        ...PREDIAL_AREA_CONSTRUIDA_PATHS.map(
          (path) => document.extraction_jsonb?.[path]
        )
      )
    )
  );
  if (requiresBuiltArea && !hasBuiltArea) {
    return [
      {
        reason: "predial_area_construida_missing",
        remediation: { owner: "deterministic", document_ids: extractedIds },
      },
    ];
  }
  if (requiresBuiltArea) {
    const implausibleDoc = extractedPredials
      .map((document) => {
        const extraction =
          document.extraction_jsonb && typeof document.extraction_jsonb === "object"
            ? (document.extraction_jsonb as Record<string, unknown>)
            : {};
        return {
          document,
          quality: evaluatePredialBuiltAreaQualityForTest(extraction),
        };
      })
      .find(({ quality }) => quality.implausible);
    if (implausibleDoc) {
      return [
        {
          reason: "predial_area_construida_implausible",
          remediation: {
            owner: "human",
            document_ids: [implausibleDoc.document.id],
            observed_value_m2: implausibleDoc.quality.observed_m2 ?? undefined,
            suggested_value_m2: implausibleDoc.quality.suggested_m2 ?? undefined,
          },
        },
      ];
    }
  }
  return [];
}

function boletaAdvanceBlocks(input: {
  documents: OperationalCaseDocument[];
}): PropertyAdvanceGateBlock[] {
  const boletas = input.documents.filter(
    (document) => document.status !== "superseded" && isBoletaDocumentCandidate(document)
  );
  if (boletas.length === 0) return [];
  const pending = boletas.filter((document) =>
    PENDING_EXTRACTION_STATUSES.includes(document.extraction_status)
  );
  if (pending.length > 0) {
    return [
      {
        reason: "boleta_extraction_pending",
        remediation: {
          owner: "deterministic",
          document_ids: pending.map((document) => document.id),
        },
      },
    ];
  }
  const extractedBoletas = boletas.filter((document) =>
    USABLE_EXTRACTION_STATUSES.includes(document.extraction_status)
  );
  const extractedIds = extractedBoletas.map((document) => document.id);
  const remediationIds =
    extractedIds.length > 0 ? extractedIds : boletas.map((document) => document.id);
  const hasBoletaOwner = extractedBoletas.some((document) =>
    extractionOwnerNames(document.extraction_jsonb ?? {}).length > 0
  );
  const hasBoletaAddress = extractedBoletas.some((document) =>
    extractionAddressCandidates(document.extraction_jsonb ?? {}).length > 0
  );
  if (!hasBoletaOwner || !hasBoletaAddress) {
    return [
      {
        reason: "boleta_owner_or_address_missing",
        remediation: {
          owner: "deterministic",
          document_ids: remediationIds,
        },
      },
    ];
  }
  return [];
}

function ownerCorroborationAdvanceBlocks(input: {
  documents: OperationalCaseDocument[];
}): PropertyAdvanceGateBlock[] {
  const corroborationDocuments = input.documents.filter((document) => {
    if (document.status === "superseded") return false;
    const signals = documentSignalsForMinimums(document, document.extraction_jsonb ?? {});
    return signals.identificacion || signals.comprobante;
  });
  if (corroborationDocuments.length === 0) return [];
  const pending = corroborationDocuments.filter((document) =>
    PENDING_EXTRACTION_STATUSES.includes(document.extraction_status)
  );
  if (pending.length === 0) return [];
  return [
    {
      reason: "owner_corroboration_extraction_pending",
      remediation: {
        owner: "deterministic",
        document_ids: pending.map((document) => document.id),
      },
    },
  ];
}

export function evaluatePropertyAdvanceGate(input: {
  documents: OperationalCaseDocument[];
  context: Record<string, unknown> | null | undefined;
  targetTransition: PropertyAdvanceTransition;
}): PropertyAdvanceGateResult {
  const context = input.context ?? {};
  const propertyData = propertyDataRecord(context);
  const propertyType =
    propertyTypeRequirementKey(
      propertyData.property_type ?? context.property_type
    ) || "desconocido";
  const documentFields = documentExtractionMinimumsContext(input.documents);
  const blocks: PropertyAdvanceGateBlock[] = [];

  if (input.targetTransition === "comparables_in_progress") {
    blocks.push(...boletaAdvanceBlocks({ documents: input.documents }));
    if (blocks.length === 0) {
      blocks.push(...predialAdvanceBlocks({ propertyType, documents: input.documents }));
    }
    if (blocks.length === 0) {
      const minimums = evaluatePropertyDataMinimumsForReview(context, documentFields);
      if (!minimums.ok) {
        blocks.push({
          reason: "characteristics_minimums_missing",
          remediation: {
            owner: "external",
            missing_fields: minimums.missing.map(({ key, label }) => ({ key, label })),
          },
        });
      }
    }
  } else {
    // contract_pending: titularidad debe estar corroborada (WS4).
    blocks.push(...ownerCorroborationAdvanceBlocks({ documents: input.documents }));
    if (blocks.length === 0) {
      const titularidadStatus = ownerConsistencyStatusFromFields(documentFields);
      if (titularidadStatus !== "match" && !titularidadOverrideApproved(context)) {
        blocks.push({
          reason: "titularidad_unverified",
          remediation: { owner: "human", titularidad_status: titularidadStatus },
        });
      }
    }
  }

  return { satisfied: blocks.length === 0, blocks };
}

/** Estado de titularidad consolidado por `documentExtractionMinimumsContext`. */
export function ownerConsistencyStatusFromFields(
  documentFields: Record<string, unknown>
): OwnerConsistencyStatus {
  const status = documentFields.owner_consistency_status;
  if (
    status === "match" ||
    status === "partial_mismatch" ||
    status === "mismatch" ||
    status === "insufficient"
  ) {
    return status;
  }
  return "insufficient";
}

/** Override auditado del asesor que desbloquea el gate de titularidad (WS4). */
export function titularidadOverrideApproved(
  context: Record<string, unknown> | null | undefined
): boolean {
  const titularidad = context?.titularidad;
  if (!titularidad || typeof titularidad !== "object") return false;
  const override = (titularidad as Record<string, unknown>).override;
  if (!override || typeof override !== "object") return false;
  return (override as Record<string, unknown>).approved === true;
}

export function missingRequiredIntakeFields(
  intakeSchema: readonly OperationalCaseIntakeField[] | undefined,
  context: Record<string, unknown>
) {
  const requiredFields = intakeSchema?.filter((field) => field?.required) ?? [];
  return requiredFields
    .filter((field) => {
      const value = context[field.name];
      return (
        value === undefined ||
        value === null ||
        (typeof value === "string" && value.trim() === "")
      );
    })
    .map((field) => ({ name: field.name, label: field.label }));
}

export function buildOperationalCaseCreateContext(params: {
  context: Record<string, unknown>;
  missing: Array<{ name: string; label: string }>;
  allowIncompleteIntake?: boolean;
  e2eControlled?: boolean;
  channel?: string;
}) {
  const incomplete = params.missing.length > 0;
  return {
    created_from: "agent_conversation",
    ...(params.context ?? {}),
    ...(params.e2eControlled
      ? {
          e2e_controlled: true,
          e2e_control_source: params.channel ?? "telegram",
          e2e_control_status: incomplete ? "intake" : "ready_for_manual_tick",
          e2e_control_started_at: new Date().toISOString(),
        }
      : {}),
    ...(params.allowIncompleteIntake && incomplete
      ? {
          intake_status: "incomplete",
          missing_required: params.missing,
        }
      : {
          intake_status: "complete",
          missing_required: [],
        }),
  };
}

function firstOperationalStep(flow: readonly OperationalCaseFlowStep[] | undefined) {
  return flow?.find((step) => step.step_key && step.step_key !== "intake")
    ?.step_key;
}

export function operationalCaseIntakeSuccessStep(params: {
  activationPolicy?: OperationalCaseActivationPolicy | null;
  flow?: readonly OperationalCaseFlowStep[] | null;
}) {
  return (
    params.activationPolicy?.safe_test?.success_step?.trim() ||
    firstOperationalStep(params.flow ?? undefined) ||
    "awaiting_documents"
  );
}

export function blockedAwaitingDocumentsTransitionReason(params: {
  currentStep: string | null | undefined;
  nextStep: string | null | undefined;
  recentEventTypes?: string[];
}): string | null {
  if (params.currentStep !== "awaiting_documents") return null;
  if (!params.nextStep || params.nextStep === "awaiting_documents") return null;
  if (
    params.nextStep === "documents_received" &&
    params.recentEventTypes?.includes("external_response")
  ) {
    return null;
  }
  return "awaiting_documents_requires_external_response";
}

const PROPERTY_OPTIONING_STEP_ORDER = [
  "intake",
  "awaiting_documents",
  "documents_received",
  "property_data_review",
  "comparables_in_progress",
  "price_proposal_pending",
  "contract_pending",
  "photos_requested",
  "package_ready",
  "published",
] as const;

function propertyOptioningStepRank(step: string | null | undefined) {
  if (!step) return null;
  const index = PROPERTY_OPTIONING_STEP_ORDER.indexOf(
    step as (typeof PROPERTY_OPTIONING_STEP_ORDER)[number]
  );
  return index === -1 ? null : index;
}

export function blockedPropertyOptioningStepRegressionReason(params: {
  caseType: string | null | undefined;
  currentStep: string | null | undefined;
  nextStep: string | null | undefined;
}): string | null {
  if (params.caseType !== "property_optioning" || !params.nextStep) return null;
  const currentRank = propertyOptioningStepRank(params.currentStep);
  const nextRank = propertyOptioningStepRank(params.nextStep);
  if (currentRank == null || nextRank == null) return null;
  if (nextRank < currentRank) return "property_optioning_step_regression_blocked";
  return null;
}

function sanitizeIntakePatch(
  intakeSchema: readonly OperationalCaseIntakeField[] | undefined,
  patch: Record<string, unknown>
) {
  const allowed = new Set((intakeSchema ?? []).map((field) => field.name));
  return Object.fromEntries(
    Object.entries(patch).filter(([key]) => allowed.has(key))
  );
}

export function buildOperationalCaseIntakeUpdateContext(params: {
  existingContext: Record<string, unknown>;
  intakePatch: Record<string, unknown>;
  intakeSchema?: readonly OperationalCaseIntakeField[];
  e2eControlled?: boolean;
  channel?: string;
}) {
  const sanitizedPatch = sanitizeIntakePatch(
    params.intakeSchema,
    params.intakePatch
  );
  const mergedContext = {
    ...params.existingContext,
    ...sanitizedPatch,
  };
  const missing = missingRequiredIntakeFields(
    params.intakeSchema,
    mergedContext
  );
  const complete = missing.length === 0;
  return {
    context: {
      ...mergedContext,
      intake_status: complete ? "complete" : "incomplete",
      missing_required: missing,
      ...(params.e2eControlled || mergedContext.e2e_controlled === true
        ? {
            e2e_controlled: true,
            e2e_control_source:
              typeof mergedContext.e2e_control_source === "string"
                ? mergedContext.e2e_control_source
                : (params.channel ?? "telegram"),
            e2e_control_status: complete ? "ready_for_manual_tick" : "intake",
          }
        : {}),
    },
    intakePatch: sanitizedPatch,
    missing,
    complete,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function addOperationalCaseTools(
  ctx: ToolContext,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: any[],
  deps: NotifyDeps
): void {
  if (!ctx.caseId && toolEnabled("operational_case_create", ctx)) {
    tools.push(
      tool(
        async (input: {
          case_type: string;
          context: Record<string, unknown>;
          external_contact?: Record<string, unknown>;
          next_action_at?: string;
          due_at?: string;
          allow_incomplete_intake?: boolean;
          e2e_controlled?: boolean;
        }) => {
          const record = await createTrackedToolCall(ctx, "operational_case_create",
            input as unknown as Record<string, unknown>,
            false);

          if (ctx.caseId) {
            const out = {
              ok: false,
              error: "case_already_in_scope",
              case_id: ctx.caseId,
              hint:
                "Ya hay un caso operacional activo en contexto. Continúa ese caso con operational_case_update_intake/update_state; no crees otro caso.",
            };
            await updateToolCallStatus(ctx.db, record.id, "failed", out);
            return JSON.stringify(out);
          }

          const caseType = await getOperationalCaseTypeForUser(
            ctx.db,
            ctx.userId,
            input.case_type
          );
          if (!caseType) {
            const out = {
              ok: false,
              error: "case_type_not_found_or_forbidden",
              hint: "The case_type slug is not visible to this user. Check the operational_case_types catalog.",
            };
            await updateToolCallStatus(ctx.db, record.id, "failed", out);
            return JSON.stringify(out);
          }
          if (caseType.status === "archived") {
            const out = {
              ok: false,
              error: "case_type_archived",
              hint: "This case_type is archived; ask the user to pick another or unarchive it from settings.",
            };
            await updateToolCallStatus(ctx.db, record.id, "failed", out);
            return JSON.stringify(out);
          }

          const intakeSchema = (caseType.intake_schema_jsonb ?? []) as
            | OperationalCaseIntakeField[]
            | undefined;
          const missing = missingRequiredIntakeFields(
            intakeSchema,
            input.context ?? {}
          );
          if (missing.length > 0 && !input.allow_incomplete_intake) {
            const out = {
              ok: false,
              error: "missing_required_intake_fields",
              missing,
              hint: "Ask the user for these fields conversationally before retrying, or pass allow_incomplete_intake=true to persist a draft intake case.",
            };
            await updateToolCallStatus(ctx.db, record.id, "failed", out);
            return JSON.stringify(out);
          }

          const externalContact = (input.external_contact ?? undefined) as
            | OperationalCaseExternalContact
            | undefined;

          const incompleteDraft =
            missing.length > 0 && input.allow_incomplete_intake === true;
          const created = await createOperationalCase(ctx.db, {
            userId: ctx.userId,
            caseTypeId: caseType.id,
            caseType: caseType.case_type,
            status: incompleteDraft ? "waiting_internal" : "active",
            currentStep: "intake",
            externalContact,
            nextActionAt:
              input.next_action_at ??
              (input.e2e_controlled ? null : new Date().toISOString()),
            dueAt: input.due_at ?? null,
            // Marcamos created_from para distinguir en /operational-cases
            // los casos creados por el flujo conversacional (chat/telegram)
            // de los creados desde el formulario web ("Poner en operación").
            // El web formula explícitamente `created_from='web_operational_cases_ui'`;
            // aquí marcamos `agent_conversation`. NO sobreescribimos si el
            // caller ya proveyó un valor (defensa por si en el futuro alguien
            // llama esta tool desde otro contexto y quiere su propio tag).
            context: buildOperationalCaseCreateContext({
              context: input.context ?? {},
              missing,
              allowIncompleteIntake: input.allow_incomplete_intake,
              e2eControlled: input.e2e_controlled,
              channel: ctx.channel,
            }),
          });

          await insertOperationalCaseEvent(ctx.db, {
            caseId: created.id,
            eventType: "step_completed",
            actor: "agent",
            payload: {
              kind: "case_created",
              source: "agent_conversation",
              case_type: created.case_type,
              current_step: created.current_step,
              intake_status: created.context_jsonb.intake_status ?? null,
              missing_required: created.context_jsonb.missing_required ?? [],
            },
          });

          const out = {
            ok: true,
            case_id: created.id,
            case_type: created.case_type,
            version: created.version,
            status: created.status,
            current_step: created.current_step,
            next_action_at: created.next_action_at,
            intake_status: created.context_jsonb.intake_status ?? "complete",
            missing_required: created.context_jsonb.missing_required ?? [],
            hint: incompleteDraft
              ? "Draft intake case created. Continue the conversation to collect missing_required before advancing operational steps."
              : "Case created at current_step='intake'. Inform the inmobiliario via notify_user; do NOT message the external contact yet — that is the responsibility of the next operational step.",
          };
          await updateToolCallStatus(ctx.db, record.id, "executed", out);
          return JSON.stringify(out);
        },
        {
          name: "operational_case_create",
          description:
            "Creates a new operational case for the calling user from a known case_type. Validates required fields against intake_schema_jsonb. Starts at current_step='intake'.",
          schema: z.object({
            case_type: z.string().min(1),
            context: z.record(z.string(), z.any()),
            external_contact: z.record(z.string(), z.any()).optional(),
            next_action_at: z.string().optional(),
            due_at: z.string().optional(),
            allow_incomplete_intake: z.boolean().optional(),
            e2e_controlled: z.boolean().optional(),
          }),
        }
      )
    );
  }

  if (toolEnabled("operational_case_update_intake", ctx)) {
    tools.push(
      tool(
        async (input: {
          case_id: string;
          expected_version: number;
          intake_patch: Record<string, unknown>;
          external_contact?: Record<string, unknown>;
          next_action_at?: string;
          note?: string;
        }) => {
          const record = await createTrackedToolCall(
            ctx,
            "operational_case_update_intake",
            input as unknown as Record<string, unknown>,
            false
          );

          const opCase = await getOperationalCase(ctx.db, input.case_id);
          if (!opCase || opCase.user_id !== ctx.userId) {
            const out = { ok: false, error: "case_not_found_or_forbidden" };
            await updateToolCallStatus(ctx.db, record.id, "failed", out);
            return JSON.stringify(out);
          }
          if (opCase.version !== input.expected_version) {
            const out = {
              ok: false,
              error: "version_mismatch",
              actual_version: opCase.version,
              expected_version: input.expected_version,
              hint: "Re-read the case and retry with the new version.",
            };
            await updateToolCallStatus(ctx.db, record.id, "failed", out);
            return JSON.stringify(out);
          }
          if (opCase.current_step !== "intake") {
            const out = {
              ok: false,
              error: "case_not_in_intake",
              current_step: opCase.current_step,
              hint: "Use operational_case_update_intake only while current_step='intake'.",
            };
            await updateToolCallStatus(ctx.db, record.id, "failed", out);
            return JSON.stringify(out);
          }

          const caseType = await getOperationalCaseTypeById(
            ctx.db,
            opCase.case_type_id
          );
          if (!caseType || (caseType.user_id && caseType.user_id !== ctx.userId)) {
            const out = { ok: false, error: "case_type_not_found_or_forbidden" };
            await updateToolCallStatus(ctx.db, record.id, "failed", out);
            return JSON.stringify(out);
          }

          const intakeSchema = (caseType.intake_schema_jsonb ?? []) as
            | OperationalCaseIntakeField[]
            | undefined;
          const intakeUpdate = buildOperationalCaseIntakeUpdateContext({
            existingContext:
              opCase.context_jsonb && typeof opCase.context_jsonb === "object"
                ? (opCase.context_jsonb as Record<string, unknown>)
                : {},
            intakePatch: input.intake_patch ?? {},
            intakeSchema,
            e2eControlled: opCase.context_jsonb?.e2e_controlled === true,
            channel: ctx.channel,
          });
          const successStep = operationalCaseIntakeSuccessStep({
            activationPolicy: caseType.activation_policy_jsonb,
            flow: caseType.operational_flow_jsonb,
          });
          const nextStep = intakeUpdate.complete ? successStep : "intake";
          const nextActionAt = intakeUpdate.complete
            ? opCase.context_jsonb?.e2e_controlled === true
              ? null
              : (input.next_action_at ?? new Date().toISOString())
            : null;
          const updated = await updateOperationalCase(
            ctx.db,
            opCase.id,
            opCase.version,
            {
              status: "active",
              currentStep: nextStep,
              nextActionAt,
              context: intakeUpdate.context,
              externalContact: mergeExternalContactPatch(
                opCase.external_contact_jsonb,
                input.external_contact
              ),
            }
          );
          if (!updated) {
            const out = {
              ok: false,
              error: "concurrent_update",
              hint: "Another worker updated the case between read and write. Re-read and retry.",
            };
            await updateToolCallStatus(ctx.db, record.id, "failed", out);
            return JSON.stringify(out);
          }

          await insertOperationalCaseEvent(ctx.db, {
            caseId: opCase.id,
            eventType: "state_changed",
            actor: "agent",
            payload: {
              source: "operational_case_update_intake",
              from: {
                status: opCase.status,
                current_step: opCase.current_step,
                version: opCase.version,
                intake_status: opCase.context_jsonb?.intake_status ?? null,
              },
              to: {
                status: updated.status,
                current_step: updated.current_step,
                version: updated.version,
                intake_status: intakeUpdate.complete ? "complete" : "incomplete",
              },
              missing_required: intakeUpdate.missing,
              updated_fields: Object.keys(intakeUpdate.intakePatch),
              ...(input.note ? { reason: input.note } : {}),
            },
          });

          const out = {
            ok: true,
            case_id: updated.id,
            version: updated.version,
            status: updated.status,
            current_step: updated.current_step,
            intake_status: intakeUpdate.complete ? "complete" : "incomplete",
            missing_required: intakeUpdate.missing,
            ready_for_manual_tick: intakeUpdate.complete,
            ...(intakeUpdate.complete
              ? {
                  user_reply_hint:
                    "Confirma brevemente que la propiedad quedó registrada en el caso. No uses «opcional» ni «opcionada». No menciones documentos ni adjuntos; el siguiente paso operativo los solicita.",
                }
              : {}),
          };
          await updateToolCallStatus(ctx.db, record.id, "executed", out);
          return JSON.stringify(out);
        },
        {
          name: "operational_case_update_intake",
          description:
            "Updates intake fields for an active operational case, validates required intake_schema fields, and when complete moves the case to the first operational step for the next case tick.",
          schema: z.object({
            case_id: z.string().min(1),
            expected_version: z.number().int().nonnegative(),
            intake_patch: z.record(z.string(), z.any()),
            external_contact: z.record(z.string(), z.any()).optional(),
            next_action_at: z.string().optional(),
            note: z.string().optional(),
          }),
        }
      )
    );
  }

  if (toolEnabled("operational_case_update_state", ctx)) {
    tools.push(
      tool(
        async (input: {
          case_id: string;
          expected_version: number;
          status?: (typeof STATUS_VALUES)[number];
          current_step?: string;
          next_action_at?: string;
          due_at?: string;
          context_patch?: Record<string, unknown>;
          external_contact?: Record<string, unknown>;
          note?: string;
        }) => {
          const record = await createTrackedToolCall(ctx, "operational_case_update_state",
            input as unknown as Record<string, unknown>,
            false);

          let expectedVersion = input.expected_version;
          let opCaseBefore: Awaited<ReturnType<typeof getOperationalCase>> = null;
          let updated: Awaited<ReturnType<typeof updateOperationalCase>> = null;

          for (let attempt = 0; attempt < 5; attempt++) {
            const opCase = await getOperationalCase(ctx.db, input.case_id);
            if (!opCase) {
              const out = { ok: false, error: "case_not_found" };
              await updateToolCallStatus(ctx.db, record.id, "failed", out);
              return JSON.stringify(out);
            }
            if (opCase.user_id !== ctx.userId) {
              const out = { ok: false, error: "case_belongs_to_another_user" };
              await updateToolCallStatus(ctx.db, record.id, "failed", out);
              return JSON.stringify(out);
            }
            if (opCase.version !== expectedVersion) {
              if (attempt < 4) {
                expectedVersion = opCase.version;
                continue;
              }
              const out = {
                ok: false,
                error: "version_mismatch",
                actual_version: opCase.version,
                expected_version: input.expected_version,
                hint: "Re-read the case and retry with the new version.",
              };
              await updateToolCallStatus(ctx.db, record.id, "failed", out);
              return JSON.stringify(out);
            }

            opCaseBefore = opCase;
            let contextPatch =
              input.context_patch && Object.keys(input.context_patch).length > 0
                ? { ...input.context_patch }
                : undefined;
            if (contextPatch && "comparables_analysis" in contextPatch) {
              const patchErrors = validateComparablesAnalysisArtifact(
                contextPatch.comparables_analysis
              );
              if (patchErrors.length > 0) {
                const { comparables_analysis: _omit, ...rest } = contextPatch;
                contextPatch =
                  Object.keys(rest).length > 0 ? rest : undefined;
              }
            }
            const mergedContext =
              contextPatch && Object.keys(contextPatch).length > 0
                ? {
                    ...(opCase.context_jsonb && typeof opCase.context_jsonb === "object"
                      ? (opCase.context_jsonb as Record<string, unknown>)
                      : {}),
                    ...contextPatch,
                  }
                : undefined;
            if (contextPatch) {
              const definedContextPatch = contextPatch;
              const protectedKeys = [
                "publication",
                "published",
                "publish_approvals",
                "photo_manifest",
                "e2e_control_status",
                "package_ready_lab_auto_continue_listing_id",
                "package_ready_machine_work_in_flight",
              ].filter((key) => key in definedContextPatch);
              if (protectedKeys.length > 0) {
                const out = {
                  ok: false,
                  error: "protected_context_keys",
                  protected_keys: protectedKeys,
                  hint:
                    "No escribas publication/published/publish_approvals/photo_manifest desde operational_case_update_state. El publication runner y los adapters de destino son dueños de ese estado.",
                };
                await updateToolCallStatus(ctx.db, record.id, "failed", out);
                return JSON.stringify(out);
              }
              // commission_terms.confirmation is owned by the typed commercial mutator / HITL.
              if ("commission_terms" in contextPatch) {
                const patchedTerms = contextPatch.commission_terms;
                if (
                  patchedTerms &&
                  typeof patchedTerms === "object" &&
                  !Array.isArray(patchedTerms) &&
                  "confirmation" in (patchedTerms as Record<string, unknown>)
                ) {
                  const { confirmation: _omit, ...restTerms } =
                    patchedTerms as Record<string, unknown>;
                  contextPatch = {
                    ...contextPatch,
                    commission_terms: restTerms,
                  };
                }
              }
            }
            const nextContext =
              mergedContext ??
              (opCase.context_jsonb && typeof opCase.context_jsonb === "object"
                ? (opCase.context_jsonb as Record<string, unknown>)
                : {});
            if (
              opCase.case_type === "property_optioning" &&
              opCase.current_step === "intake" &&
              input.current_step &&
              input.current_step !== "intake" &&
              opCase.context_jsonb?.intake_status !== "complete"
            ) {
              const out = {
                ok: false,
                error: "intake_incomplete_cannot_advance",
                current_step: opCase.current_step,
                requested_step: input.current_step,
                intake_status: opCase.context_jsonb?.intake_status ?? "incomplete",
                hint:
                  "Completa el intake con operational_case_update_intake antes de avanzar al siguiente paso operativo.",
              };
              await updateToolCallStatus(ctx.db, record.id, "failed", out);
              return JSON.stringify(out);
            }
            const regressionReason =
              blockedPropertyOptioningStepRegressionReason({
                caseType: opCase.case_type,
                currentStep: opCase.current_step,
                nextStep: input.current_step,
              });
            if (regressionReason) {
              const out = {
                ok: false,
                error: regressionReason,
                current_step: opCase.current_step,
                requested_step: input.current_step,
                hint:
                  "No retrocedas current_step en property_optioning. Continúa desde el hito actual o pide intervención humana si necesitas reabrir un paso anterior.",
              };
              await updateToolCallStatus(ctx.db, record.id, "failed", out);
              return JSON.stringify(out);
            }
            if (
              opCase.current_step === "awaiting_documents" &&
              input.current_step &&
              input.current_step !== "awaiting_documents"
            ) {
              const recentEvents = await getRecentOperationalCaseEvents(
                ctx.db,
                opCase.id,
                30
              );
              const blockedReason = blockedAwaitingDocumentsTransitionReason({
                currentStep: opCase.current_step,
                nextStep: input.current_step,
                recentEventTypes: recentEvents.map((event) => event.event_type),
              });
              if (blockedReason) {
                const out = {
                  ok: false,
                  error: blockedReason,
                  current_step: opCase.current_step,
                  requested_step: input.current_step,
                  hint:
                    "Desde awaiting_documents primero solicita documentos y espera un external_response. No avances a pasos posteriores sin evidencia de respuesta/documentos.",
                };
                await updateToolCallStatus(ctx.db, record.id, "failed", out);
                return JSON.stringify(out);
              }
            }
            const comparablesAnalysis = nextContext.comparables_analysis;
            if (comparablesAnalysis != null) {
              const artifactErrors =
                validateComparablesAnalysisArtifact(comparablesAnalysis);
              if (artifactErrors.length > 0) {
                const out = {
                  ok: false,
                  error: "invalid_comparables_analysis",
                  errors: artifactErrors,
                  hint:
                    "Usa operational_case_persist_comparables_analysis para construir el artefacto desde los resultados de búsqueda del turno.",
                };
                await updateToolCallStatus(ctx.db, record.id, "failed", out);
                return JSON.stringify(out);
              }
            }
            const comparablesDecision =
              typeof nextContext.comparables_decision === "string"
                ? nextContext.comparables_decision
                : null;
            const hasAvaclickValuation =
              isRecord(comparablesAnalysis) &&
              isRecord(comparablesAnalysis.external_valuation) &&
              typeof comparablesAnalysis.external_valuation.sale_average_mxn === "number";
            const allowAvaclickOnlyAdvance =
              comparablesDecision === "use_avaclick_primary" && hasAvaclickValuation;
            if (
              opCase.case_type === "property_optioning" &&
              opCase.current_step === "comparables_in_progress" &&
              input.current_step === "comparables_in_progress" &&
              input.status === "waiting_internal" &&
              !isRecord(comparablesAnalysis)
            ) {
              const out = {
                ok: false,
                error: "comparables_waiting_internal_requires_persist",
                hint:
                  "Antes de dejar comparables_in_progress en waiting_internal, ejecuta operational_case_persist_comparables_analysis. El artefacto persistido es la fuente de verdad para que el invariante emita una sola decisión de expansión.",
              };
              await updateToolCallStatus(ctx.db, record.id, "failed", out);
              return JSON.stringify(out);
            }
            if (
              input.current_step === "price_proposal_pending" &&
              opCase.current_step === "comparables_in_progress" &&
              !allowAvaclickOnlyAdvance
            ) {
              const comparablesDq =
                isRecord(comparablesAnalysis) && isRecord(comparablesAnalysis.data_quality)
                  ? comparablesAnalysis.data_quality
                  : null;
              const searchValidity =
                typeof comparablesDq?.search_validity === "string"
                  ? comparablesDq.search_validity
                  : "valid";
              const validityHint =
                searchValidity === "invalid_filters"
                  ? "La búsqueda fue inválida por filtros (no insuficiencia real). Reintenta con filtros canónicos y persiste de nuevo."
                  : searchValidity === "missing_required_source"
                    ? "Falta una fuente obligatoria aplicable (Avaclick). Ejecuta get_avaclick_valuation y vuelve a persistir."
                    : "No avances a price_proposal_pending hasta persistir comparables_analysis con defensible_sample=true (unique_comparable_count >= 3). Si no hay muestra defendible, deja current_step=comparables_in_progress y status=waiting_internal con notify_user. Solo se permite avanzar con Avaclick si existe decision humana explicita (context.comparables_decision=use_avaclick_primary).";
              const out = {
                ok: false,
                error: "price_advance_must_use_persist",
                search_validity: searchValidity,
                hint:
                  "No avances directo a price_proposal_pending desde operational_case_update_state. Usa operational_case_persist_comparables_analysis para persistir comparables y dejar trazabilidad de Paso 4 (price_proposal_prepared + price_approval_requested).",
                fallback_hint: validityHint,
              };
              await updateToolCallStatus(ctx.db, record.id, "failed", out);
              return JSON.stringify(out);
            }
            if (
              opCase.case_type === "property_optioning" &&
              (input.current_step === "published" || input.status === "completed")
            ) {
              const completion =
                canCompleteListingPublishedSummaryFromContext(nextContext);
              if (!completion.ok) {
                const out = {
                  ok: false,
                  error: "property_optioning_publish_completion_blocked",
                  hint: completion.reason,
                };
                await updateToolCallStatus(ctx.db, record.id, "failed", out);
                return JSON.stringify(out);
              }
            }

            updated = await updateOperationalCase(
              ctx.db,
              opCase.id,
              opCase.version,
              {
                status: input.status,
                currentStep: input.current_step,
                nextActionAt: input.next_action_at,
                dueAt: input.due_at,
                context: mergedContext,
                externalContact: mergeExternalContactPatch(
                  opCase.external_contact_jsonb,
                  input.external_contact
                ),
              }
            );
            if (updated) break;
          }

          if (!updated || !opCaseBefore) {
            const out = {
              ok: false,
              error: "concurrent_update",
              hint: "Another worker updated the case between read and write. Re-read and retry.",
            };
            await updateToolCallStatus(ctx.db, record.id, "failed", out);
            return JSON.stringify(out);
          }

          await insertOperationalCaseEvent(ctx.db, {
            caseId: opCaseBefore.id,
            eventType: "state_changed",
            actor: "agent",
            payload: {
              from: {
                status: opCaseBefore.status,
                current_step: opCaseBefore.current_step,
                version: opCaseBefore.version,
              },
              to: {
                status: updated.status,
                current_step: updated.current_step,
                version: updated.version,
              },
              ...(input.note ? { reason: input.note } : {}),
            },
          });

          if (
            opCaseBefore.case_type === "property_optioning" &&
            updated.current_step === "published" &&
            updated.status === "completed"
          ) {
            const recentEvents = await getRecentOperationalCaseEvents(
              ctx.db,
              updated.id,
              30
            );
            const alreadySent = listingPublishedSummaryAlreadySent(recentEvents);
            const completionGate = canCompleteListingPublishedSummaryFromContext(
              isRecord(updated.context_jsonb) ? updated.context_jsonb : {},
              recentEvents
            );
            if (!alreadySent && completionGate.ok) {
              try {
                const summaryText = formatListingPublishedSummaryNotifyText(updated);
                const result = await deps.notifyUser(
                  ctx.db,
                  ctx.userId,
                  {
                    text: summaryText,
                    kind: "listing_published_summary",
                    data: { case_id: updated.id },
                  },
                  "normal"
                );
                if (result.delivered.length > 0) {
                  await insertOperationalCaseEvent(ctx.db, {
                    caseId: updated.id,
                    eventType: "step_completed",
                    actor: "agent",
                    stepKey: "published",
                    payload: { kind: "listing_published_summary_sent" },
                  });
                }
              } catch {
                // El cierre de estado no debe fallar por errores de notificacion.
              }
            }
          }

          const out = {
            ok: true,
            case_id: updated.id,
            version: updated.version,
            status: updated.status,
            current_step: updated.current_step,
          };
          await updateToolCallStatus(ctx.db, record.id, "executed", out);
          return JSON.stringify(out);
        },
        {
          name: "operational_case_update_state",
          description:
            "Updates the active operational case (status/current_step/next_action_at/...). Optimistic-locked by version.",
          schema: z.object({
            case_id: z.string().min(1),
            expected_version: z.number().int().nonnegative(),
            status: z.enum(STATUS_VALUES).optional(),
            current_step: z.string().min(1).optional(),
            next_action_at: z.string().optional(),
            due_at: z.string().optional(),
            context_patch: z.record(z.string(), z.any()).optional(),
            external_contact: z.record(z.string(), z.any()).optional(),
            note: z.string().optional(),
          }),
        }
      )
    );
  }

  if (toolEnabled("operational_case_persist_comparables_analysis", ctx)) {
    tools.push(
      tool(
        async (input: {
          case_id: string;
          expected_version: number;
          note?: string;
        }) => {
          const record = await createTrackedToolCall(ctx, "operational_case_persist_comparables_analysis",
            input as unknown as Record<string, unknown>,
            false);

          if (!ctx.turnId) {
            const out = {
              ok: false,
              error: "turn_id_required",
              hint: "Esta tool construye comparables desde las búsquedas ejecutadas en el mismo turno.",
            };
            await updateToolCallStatus(ctx.db, record.id, "failed", out);
            return JSON.stringify(out);
          }

          const { data, error } = await ctx.db
            .from("tool_calls")
            .select("tool_name,status,arguments_json,result_json,created_at")
            .eq("turn_id", ctx.turnId)
            .in("tool_name", [
              "easybroker_search_listings",
              "easybroker_search_closed_deals",
              "bigquery_lookup_local_comparables",
              "get_avaclick_valuation",
            ])
            .order("created_at", { ascending: true });
          if (error) {
            const out = {
              ok: false,
              error: "tool_calls_lookup_failed",
              hint: error.message,
            };
            await updateToolCallStatus(ctx.db, record.id, "failed", out);
            return JSON.stringify(out);
          }

          let expectedVersion = input.expected_version;
          let opCaseBefore: Awaited<ReturnType<typeof getOperationalCase>> = null;
          let updated: Awaited<ReturnType<typeof updateOperationalCase>> = null;
          let analysis: Record<string, unknown> | null = null;
          for (let attempt = 0; attempt < 5; attempt++) {
            const opCase = await getOperationalCase(ctx.db, input.case_id);
            if (!opCase || opCase.user_id !== ctx.userId) {
              const out = { ok: false, error: "case_not_found_or_forbidden" };
              await updateToolCallStatus(ctx.db, record.id, "failed", out);
              return JSON.stringify(out);
            }
            if (opCase.version !== expectedVersion) {
              if (attempt < 4) {
                expectedVersion = opCase.version;
                continue;
              }
              const out = {
                ok: false,
                error: "version_mismatch",
                actual_version: opCase.version,
                expected_version: input.expected_version,
                hint: "Re-read the case and retry with the new version.",
              };
              await updateToolCallStatus(ctx.db, record.id, "failed", out);
              return JSON.stringify(out);
            }
            opCaseBefore = opCase;
            const context =
              opCase.context_jsonb && typeof opCase.context_jsonb === "object"
                ? (opCase.context_jsonb as Record<string, unknown>)
                : {};
            const propertyData = isRecord(context.property_data)
              ? context.property_data
              : context;
            analysis = buildComparablesAnalysisFromToolCalls(
              ((data ?? []) as PersistedToolCallRow[]).map((call) => ({
                tool_name: call.tool_name,
                status: call.status,
                arguments_json: call.arguments_json ?? null,
                result_json: call.result_json ?? null,
                created_at: call.created_at ?? null,
              })),
              {
                subject_area_m2: resolveSubjectAreaM2FromPropertyData(propertyData),
              }
            );
            analysis = normalizeComparablesAnalysisForInsufficientN4Test(
              analysis,
              context
            );
            const artifactErrors = validateComparablesAnalysisArtifact(analysis);
            if (artifactErrors.length > 0) {
              const out = {
                ok: false,
                error: "invalid_comparables_analysis",
                errors: artifactErrors,
              };
              await updateToolCallStatus(ctx.db, record.id, "failed", out);
              return JSON.stringify(out);
            }
            const analysisDataQuality = isRecord(analysis.data_quality)
              ? analysis.data_quality
              : {};
            const propertyDataUntrusted =
              analysisDataQuality.property_data_untrusted === true;
            const avaclickSatisfied = ((data ?? []) as PersistedToolCallRow[]).some(
              (call) => avaclickAttemptedNonRecoverable(call)
            );
            const avaclickRequired = requiresAvaclick(propertyData);
            const builtAreaReliable =
              positiveNumberFromUnknown(
                propertyData.area_construida_m2 ??
                  propertyData.construction_area_m2 ??
                  propertyData.built_area_m2
              ) != null;
            if (
              avaclickRequired &&
              builtAreaReliable &&
              !propertyDataUntrusted &&
              !avaclickSatisfied
            ) {
              const out = {
                ok: false,
                error: "avaclick_required_before_persist",
                retryable: true,
                missing_source: "get_avaclick_valuation",
                hint:
                  "Ejecuta get_avaclick_valuation antes de operational_case_persist_comparables_analysis para inmuebles residenciales con datos confiables.",
              };
              await updateToolCallStatus(ctx.db, record.id, "failed", out);
              return JSON.stringify(out);
            }

            updated = await updateOperationalCase(
              ctx.db,
              opCase.id,
              opCase.version,
              {
                context: {
                  ...context,
                  comparables_analysis: analysis,
                },
              }
            );
            if (updated) break;
            if (attempt < 4) {
              const latest = await getOperationalCase(ctx.db, input.case_id);
              expectedVersion = latest?.version ?? opCase.version + 1;
              continue;
            }
          }
          if (!updated || !opCaseBefore || !analysis) {
            const latest = await getOperationalCase(ctx.db, input.case_id);
            const out = {
              ok: false,
              error: "concurrent_update",
              actual_version: latest?.version ?? null,
              expected_version: input.expected_version,
              hint: "Another worker updated the case between read and write. Re-read and retry.",
            };
            await updateToolCallStatus(ctx.db, record.id, "failed", out);
            return JSON.stringify(out);
          }

          const analysisDataQuality = isRecord(analysis.data_quality)
            ? analysis.data_quality
            : {};
          const usableCount =
            typeof analysisDataQuality.usable_count === "number"
              ? analysisDataQuality.usable_count
              : 0;

          await insertOperationalCaseEvent(ctx.db, {
            caseId: opCaseBefore.id,
            eventType: "step_completed",
            actor: "agent",
            payload: {
              kind: "comparables_analysis_persisted",
              source: "operational_case_persist_comparables_analysis",
              usable_count: usableCount,
              unique_comparable_count:
                typeof analysisDataQuality.unique_comparable_count === "number"
                  ? analysisDataQuality.unique_comparable_count
                  : null,
              ...(input.note ? { note: input.note } : {}),
            },
          });

          let advanceResult: Awaited<ReturnType<typeof tryAdvanceComparablesAfterPersist>> | null =
            null;
          if (
            comparablesHasDefensibleSample(analysis) &&
            updated.current_step === "comparables_in_progress"
          ) {
            advanceResult = await tryAdvanceComparablesAfterPersist({
              db: ctx.db,
              opCase: updated,
              userId: ctx.userId,
              source: "operational_case_persist_comparables_analysis",
              notifyUser: deps.notifyUser,
            });
          }

          const out = {
            ok: true,
            case_id: advanceResult?.case?.id ?? updated.id,
            version: advanceResult?.case?.version ?? updated.version,
            initial_expected_version: input.expected_version,
            actual_version_used: opCaseBefore.version,
            defensible_sample: comparablesHasDefensibleSample(analysis),
            usable_count: usableCount,
            stats: analysis.stats,
            data_quality: analysisDataQuality,
            advanced_to_price_proposal: advanceResult?.advanced === true,
            price_approval_notified: advanceResult?.notified === true,
            advance_skip_reason: advanceResult?.skipReason ?? null,
            ...(advanceResult?.notified === true
              ? {
                  agent_hint:
                    "No llames notify_user(kind=price_approval|price_proposal): el sistema ya envió la propuesta canónica con salida/ideal/mínimo.",
                }
              : {}),
          };
          await updateToolCallStatus(ctx.db, record.id, "executed", out);
          return JSON.stringify(out);
        },
        {
          name: "operational_case_persist_comparables_analysis",
          description:
            "Builds and persists context_jsonb.comparables_analysis deterministically from this turn's EasyBroker, BigQuery and Avaclick results. Use after running comparable search/valuation tools; do not hand-write comparables_analysis via operational_case_update_state. When advanced_to_price_proposal and price_approval_notified are true, do NOT call notify_user for price approval—the system sends the canonical proposal automatically.",
          schema: z.object({
            case_id: z.string().min(1),
            expected_version: z.number().int().nonnegative(),
            note: z.string().optional(),
          }),
        }
      )
    );
  }

  if (toolEnabled("operational_case_add_event", ctx)) {
    tools.push(
      tool(
        async (input: {
          case_id: string;
          event_type: (typeof EVENT_TYPE_VALUES)[number];
          actor: (typeof ACTOR_VALUES)[number];
          payload?: Record<string, unknown>;
        }) => {
          const record = await createTrackedToolCall(ctx, "operational_case_add_event",
            input as unknown as Record<string, unknown>,
            false);
          const opCase = await getOperationalCase(ctx.db, input.case_id);
          if (!opCase || opCase.user_id !== ctx.userId) {
            const out = { ok: false, error: "case_not_found_or_forbidden" };
            await updateToolCallStatus(ctx.db, record.id, "failed", out);
            return JSON.stringify(out);
          }
          const ev = await insertOperationalCaseEvent(ctx.db, {
            caseId: opCase.id,
            eventType: input.event_type,
            actor: input.actor,
            payload: input.payload ?? {},
          });
          const out = { ok: true, event_id: ev.id };
          await updateToolCallStatus(ctx.db, record.id, "executed", out);
          return JSON.stringify(out);
        },
        {
          name: "operational_case_add_event",
          description: "Appends an event to the active operational case timeline.",
          schema: z.object({
            case_id: z.string().min(1),
            event_type: z.enum(EVENT_TYPE_VALUES),
            actor: z.enum(ACTOR_VALUES),
            payload: z.record(z.string(), z.any()).optional(),
          }),
        }
      )
    );
  }

  if (toolEnabled("operational_case_register_document", ctx)) {
    tools.push(
      tool(
        async (input: {
          case_id: string;
          kind: string;
          storage_path: string;
          storage_bucket?: string;
          display_name?: string;
          original_name?: string;
          content_type?: string;
          file_size_bytes?: number;
          sha256?: string;
          source?: "external_telegram" | "advisor_web" | "advisor_telegram" | "settings_test" | "unknown";
          blocking?: boolean;
          metadata?: Record<string, unknown>;
        }) => {
          const record = await createTrackedToolCall(ctx, "operational_case_register_document",
            input as unknown as Record<string, unknown>,
            false);
          const opCase = await getOperationalCase(ctx.db, input.case_id);
          if (!opCase || opCase.user_id !== ctx.userId) {
            const out = { ok: false, error: "case_not_found_or_forbidden" };
            await updateToolCallStatus(ctx.db, record.id, "failed", out);
            return JSON.stringify(out);
          }
          const document = await createOperationalCaseDocument(ctx.db, {
            caseId: opCase.id,
            userId: opCase.user_id,
            kind: input.kind,
            displayName: input.display_name ?? null,
            storageBucket: input.storage_bucket,
            storagePath: input.storage_path,
            originalName: input.original_name ?? null,
            contentType: input.content_type ?? null,
            fileSizeBytes: input.file_size_bytes ?? null,
            sha256: input.sha256 ?? null,
            source: input.source ?? "unknown",
            sourceMetadata: input.metadata ?? {},
            blocking: input.blocking ?? input.kind === "escritura_descripcion",
          });
          await insertOperationalCaseEvent(ctx.db, {
            caseId: opCase.id,
            eventType: "external_response",
            actor: input.source?.startsWith("advisor") ? "user" : "external",
            payload: {
              kind: "document_registered",
              document_id: document.id,
              document_kind: document.kind,
              source: document.source,
            },
          });
          const out = {
            ok: true,
            document_id: document.id,
            kind: document.kind,
            blocking: document.blocking,
            extraction_status: document.extraction_status,
          };
          await updateToolCallStatus(ctx.db, record.id, "executed", out);
          return JSON.stringify(out);
        },
        {
          name: "operational_case_register_document",
          description:
            "Registers a document already stored in Supabase Storage as evidence for an operational case.",
          schema: z.object({
            case_id: z.string().min(1),
            kind: z.string().min(1),
            storage_path: z.string().min(1),
            storage_bucket: z.string().min(1).optional(),
            display_name: z.string().optional(),
            original_name: z.string().optional(),
            content_type: z.string().optional(),
            file_size_bytes: z.number().int().nonnegative().optional(),
            sha256: z.string().optional(),
            source: z
              .enum(["external_telegram", "advisor_web", "advisor_telegram", "settings_test", "unknown"])
              .optional(),
            blocking: z.boolean().optional(),
            metadata: z.record(z.string(), z.any()).optional(),
          }),
        }
      )
    );
  }

  if (toolEnabled("operational_case_list_documents", ctx)) {
    tools.push(
      tool(
        async (input: { case_id: string }) => {
          const record = await createTrackedToolCall(ctx, "operational_case_list_documents",
            input,
            false);
          const opCase = await getOperationalCase(ctx.db, input.case_id);
          if (!opCase || opCase.user_id !== ctx.userId) {
            const out = { ok: false, error: "case_not_found_or_forbidden" };
            await updateToolCallStatus(ctx.db, record.id, "failed", out);
            return JSON.stringify(out);
          }
          const documents = await listOperationalCaseDocuments(ctx.db, {
            caseId: opCase.id,
            statuses: ["received"],
          });
          const out = {
            ok: true,
            documents: documents.map((doc) => ({
              id: doc.id,
              kind: doc.kind,
              display_name: doc.display_name,
              original_name: doc.original_name,
              content_type: doc.content_type,
              file_size_bytes: doc.file_size_bytes,
              blocking: doc.blocking,
              source: doc.source,
              extraction_status: doc.extraction_status,
              extraction: doc.extraction_jsonb,
              created_at: doc.created_at,
            })),
          };
          await updateToolCallStatus(ctx.db, record.id, "executed", out);
          return JSON.stringify(out);
        },
        {
          name: "operational_case_list_documents",
          description:
            "Lists received documents attached to an operational case, including cached extraction metadata.",
          schema: z.object({
            case_id: z.string().min(1),
          }),
        }
      )
    );
  }

  if (toolEnabled("operational_case_extract_document_fields", ctx)) {
    tools.push(
      tool(
        async (input: { document_id: string; force?: boolean }) => {
          const record = await createTrackedToolCall(ctx, "operational_case_extract_document_fields",
            input,
            false);
          const out = await runDocumentFieldExtraction(ctx.db, {
            userId: ctx.userId,
            documentId: input.document_id,
            force: input.force,
          });
          await updateToolCallStatus(ctx.db, record.id, out.ok ? "executed" : "failed", out);
          return JSON.stringify(out);
        },
        {
          name: "operational_case_extract_document_fields",
          description:
            "Runs cached multimodal extraction for a case document image and stores the extracted JSON on operational_case_documents.",
          schema: z.object({
            document_id: z.string().uuid(),
            force: z.boolean().optional(),
          }),
        }
      )
    );
  }

  if (toolEnabled("notify_user", ctx)) {
    tools.push(
      tool(
        async (input: {
          text: string;
          kind?: string;
          urgency?: "low" | "normal" | "high";
          case_id?: string;
        }) => {
          const caseId = input.case_id ?? ctx.caseId ?? undefined;
          const canonicalKind = canonicalizeNotifyKind(input.kind);
          const record = await createTrackedToolCall(ctx, "notify_user",
            input as unknown as Record<string, unknown>,
            false);
          try {
            // Cargar el caso para TODOS los kinds ligados a caso, no solo dos:
            // de lo contrario los guards de comparables_analysis/price_approval
            // (que requieren `opCase`) nunca disparan y notificaciones
            // informativas se vuelven pendientes humanos que detienen el flujo.
            const opCase =
              (CASE_BOUND_NOTIFY_KINDS.has(canonicalKind) ||
                looksLikeComparablesSummaryNotification(
                  canonicalKind,
                  input.text
                )) &&
              caseId
                ? await getOperationalCase(ctx.db, caseId)
                : null;
            if (canonicalKind === "property_data_review" && opCase) {
              const documents = await listOperationalCaseDocuments(ctx.db, {
                caseId: opCase.id,
                statuses: ["received"],
              });
              const documentMinimumsContext =
                documentExtractionMinimumsContext(documents);
              if (opCase.case_type === "property_optioning") {
                // Fuente única de verdad (PATTERN_GATED_TRANSITION_WITH_OWNED_REMEDIATION).
                // La corroboración de titularidad NO bloquea aquí (WS2): es
                // precondición de contract_pending, no de comparables.
                const gate = evaluatePropertyAdvanceGate({
                  documents,
                  context: opCase.context_jsonb,
                  targetTransition: "comparables_in_progress",
                });
                const predialBlock = gate.blocks.find(
                  (block) =>
                    block.reason === "predial_extraction_pending" ||
                    block.reason === "predial_area_total_missing" ||
                    block.reason === "predial_area_construida_missing" ||
                    block.reason === "predial_area_construida_implausible"
                );
                if (predialBlock) {
                  if (predialBlock.reason === "predial_area_construida_implausible") {
                    const out = {
                      ok: false,
                      error: "predial_data_quality_review_required",
                      reason: predialBlock.reason,
                      pending_predial_document_ids:
                        predialBlock.remediation.document_ids ?? [],
                      observed_area_construida_m2:
                        predialBlock.remediation.observed_value_m2 ?? null,
                      suggested_area_construida_m2:
                        predialBlock.remediation.suggested_value_m2 ?? null,
                      hint:
                        "Antes de enviar property_data_review, confirma con el asesor la superficie construida correcta (notify_user kind=property_data_quality_review). No avances a comparables con este valor implausible.",
                    };
                    await updateToolCallStatus(ctx.db, record.id, "failed", out);
                    return JSON.stringify(out);
                  }
                  const out = {
                    ok: false,
                    error: "predial_extraction_incomplete",
                    reason: predialBlock.reason,
                    pending_predial_document_ids:
                      predialBlock.remediation.document_ids ?? [],
                    hint:
                      "Antes de enviar property_data_review al contacto, termina extracción del predial con operational_case_extract_document_fields (force=true) para los pending_predial_document_ids y reintenta notify_user.",
                  };
                  await updateToolCallStatus(ctx.db, record.id, "failed", out);
                  return JSON.stringify(out);
                }
                const minimumsBlock = gate.blocks.find(
                  (block) => block.reason === "characteristics_minimums_missing"
                );
                if (minimumsBlock) {
                  const minimums = evaluatePropertyDataMinimumsForReview(
                    opCase.context_jsonb,
                    documentMinimumsContext
                  );
                  const suggestedExternalMessage =
                    buildPropertyDataMinimumsSummaryMessage({
                      context: opCase.context_jsonb,
                      supplement: documentMinimumsContext,
                      missing: minimums.missing,
                    });
                  const out = {
                    ok: false,
                    error: "property_data_minimums_missing",
                    property_type: minimums.propertyType,
                    missing: minimums.missing,
                    document_fields_used: documentMinimumsContext,
                    suggested_external_message: suggestedExternalMessage,
                    hint:
                      "Antes de crear property_data_review, envía suggested_external_message al contacto externo con telegram_send_message_to_contact(purpose='characteristics_pending') y deja el caso en waiting_external/documents_received.",
                  };
                  await updateToolCallStatus(ctx.db, record.id, "failed", out);
                  return JSON.stringify(out);
                }
              }
              const recentEvents = await getRecentOperationalCaseEvents(
                ctx.db,
                opCase.id,
                30
              );
              const alreadyRequested = recentEvents.some((event) => {
                const payload = event.payload_jsonb;
                if (!payload || typeof payload !== "object") return false;
                const kind = (payload as Record<string, unknown>).kind;
                return (
                  kind === "property_data_review_requested" ||
                  kind === "property_data_review"
                );
              });
              if (alreadyRequested || opCase.current_step === "property_data_review") {
                const out = {
                  ok: true,
                  status: "property_data_review_already_requested",
                  skipped: true,
                  case_id: opCase.id,
                };
                await updateToolCallStatus(ctx.db, record.id, "executed", out);
                return JSON.stringify(out);
              }
            }
            if (canonicalKind === "comparables_insufficient_data" && opCase) {
              const context =
                opCase.context_jsonb && typeof opCase.context_jsonb === "object"
                  ? (opCase.context_jsonb as Record<string, unknown>)
                  : {};
              const comparablesAnalysis = isRecord(context.comparables_analysis)
                ? context.comparables_analysis
                : null;
              const dataQuality =
                comparablesAnalysis && isRecord(comparablesAnalysis.data_quality)
                  ? comparablesAnalysis.data_quality
                  : null;
              const searchValidity =
                typeof dataQuality?.search_validity === "string"
                  ? dataQuality.search_validity
                  : "valid";
              if (searchValidity === "invalid_filters") {
                const out = {
                  ok: false,
                  error: "comparables_retry_required_before_notify",
                  search_validity: searchValidity,
                  hint:
                    "No notifiques insuficiencia de mercado con filtros inválidos. Reintenta comparables con filtros canónicos (y fallback moderado) antes de pedir decisión humana.",
                };
                await updateToolCallStatus(ctx.db, record.id, "failed", out);
                return JSON.stringify(out);
              }
              const usableCount =
                typeof dataQuality?.usable_count === "number"
                  ? dataQuality.usable_count
                  : 0;
              const insufficientComparablesInProgress =
                opCase.current_step === "comparables_in_progress" &&
                searchValidity === "insufficient_market_data" &&
                usableCount <= 0;
              const requiresDecisionNotification =
                insufficientComparablesInProgress &&
                opCase.status === "waiting_internal";
              if (requiresDecisionNotification) {
                const out = {
                  ok: false,
                  error: "comparables_decision_required_before_notify",
                  search_validity: searchValidity,
                  usable_count: usableCount,
                  expected_kind: "comparables_search_expansion_decision",
                  hint:
                    "Cuando el caso queda waiting_internal por insuficiencia real, no uses comparables_insufficient_data. Pide una decisión concreta con notify_user(kind=comparables_search_expansion_decision).",
                };
                await updateToolCallStatus(ctx.db, record.id, "failed", out);
                return JSON.stringify(out);
              }
              if (insufficientComparablesInProgress) {
                const out = {
                  ok: false,
                  error: "comparables_informational_copy_blocked",
                  search_validity: searchValidity,
                  usable_count: usableCount,
                  expected_kind: "comparables_search_expansion_decision",
                  hint:
                    "En comparables_in_progress con muestra insuficiente no envíes copy genérico de insuficiencia. Usa notify_user(kind=comparables_search_expansion_decision) con opciones accionables.",
                };
                await updateToolCallStatus(ctx.db, record.id, "failed", out);
                return JSON.stringify(out);
              }
            }
            if (canonicalKind === "comparables_search_expansion_decision" && opCase) {
              const context =
                opCase.context_jsonb && typeof opCase.context_jsonb === "object"
                  ? (opCase.context_jsonb as Record<string, unknown>)
                  : {};
              const comparablesAnalysis = isRecord(context.comparables_analysis)
                ? context.comparables_analysis
                : null;
              const recentEvents = await getRecentOperationalCaseEvents(
                ctx.db,
                opCase.id,
                40
              );
              if (comparablesSearchExpansionDecisionAlreadyRequested(recentEvents)) {
                const out = {
                  ok: true,
                  status: "comparables_search_expansion_decision_already_requested",
                  skipped: true,
                  case_id: opCase.id,
                };
                await updateToolCallStatus(ctx.db, record.id, "executed", out);
                return JSON.stringify(out);
              }
              if (
                opCase.case_type === "property_optioning" &&
                opCase.current_step === "comparables_in_progress" &&
                !comparablesAnalysis
              ) {
                const out = {
                  ok: false,
                  error: "comparables_analysis_required_before_decision_notify",
                  expected_tool: "operational_case_persist_comparables_analysis",
                  hint:
                    "No notifiques decisión de expansión antes de persistir comparables_analysis. Ejecuta operational_case_persist_comparables_analysis; el invariante post-agent emitirá un único pendiente accionable si usable_count sigue en 0.",
                };
                await updateToolCallStatus(ctx.db, record.id, "failed", out);
                return JSON.stringify(out);
              }
              if (
                opCase.case_type === "property_optioning" &&
                opCase.current_step === "comparables_in_progress"
              ) {
                const out = {
                  ok: false,
                  error: "comparables_decision_notify_owned_by_invariant",
                  hint:
                    "No envíes notify_user(kind=comparables_search_expansion_decision) directamente en este paso. Deja que el invariante post-agent emita una sola notificación desde comparables_analysis.",
                };
                await updateToolCallStatus(ctx.db, record.id, "failed", out);
                return JSON.stringify(out);
              }
            }
            if (
              looksLikeComparablesSummaryNotification(canonicalKind, input.text) &&
              opCase
            ) {
              const context =
                opCase.context_jsonb && typeof opCase.context_jsonb === "object"
                  ? (opCase.context_jsonb as Record<string, unknown>)
                  : {};
              const recentEvents = await getRecentOperationalCaseEvents(
                ctx.db,
                opCase.id,
                20
              );
              const priceApprovalAlreadyRequested = recentEvents.some((event) => {
                const payload =
                  event.payload_jsonb &&
                  typeof event.payload_jsonb === "object" &&
                  !Array.isArray(event.payload_jsonb)
                    ? (event.payload_jsonb as Record<string, unknown>)
                    : null;
                return payload?.kind === "price_approval_requested";
              });
              const pricingProposal = isRecord(context.pricing_proposal)
                ? context.pricing_proposal
                : null;
              const hasConcreteProposal =
                pricingProposal != null &&
                typeof pricingProposal.salida === "number" &&
                typeof pricingProposal.ideal === "number" &&
                typeof pricingProposal.minimo === "number";
              if (
                opCase.current_step === "comparables_in_progress" &&
                !hasConcreteProposal
              ) {
                const out = {
                  ok: false,
                  error: "comparables_ready_summary_blocked",
                  hint:
                    "No envíes comparables_analysis como pendiente humano en comparables_in_progress. Avanza a price_proposal_pending y solicita aprobación con notify_user(kind=price_approval) cuando exista pricing_proposal concreto (minimo/ideal/salida).",
                };
                await updateToolCallStatus(ctx.db, record.id, "failed", out);
                return JSON.stringify(out);
              }
              if (
                opCase.current_step === "price_proposal_pending" &&
                (hasConcreteProposal || priceApprovalAlreadyRequested)
              ) {
                const out = {
                  ok: false,
                  error: "comparables_summary_after_price_approval_blocked",
                  hint:
                    "Ya existe propuesta de precio en revisión. Evita resend de comparables_analysis; usa únicamente price_approval con la propuesta canónica.",
                };
                await updateToolCallStatus(ctx.db, record.id, "failed", out);
                return JSON.stringify(out);
              }
            }
            if (canonicalKind === "property_data_quality_review" && opCase) {
              const lowerText = `${input.text ?? ""}`.toLowerCase();
              const looksComparablesOrAvaclick =
                /(avaclick|avaluo|avaluos|valuacion|comparables?|easybroker|bigquery|precio)/.test(
                  lowerText
                );
              if (looksComparablesOrAvaclick) {
                const out = {
                  ok: false,
                  error: "wrong_notification_kind_for_comparables",
                  hint:
                    "property_data_quality_review solo aplica a validación de m²/superficie predial. Para temas de comparables/Avaclick usa price_approval (si ya hay propuesta) o deja warning en comparables_analysis.",
                };
                await updateToolCallStatus(ctx.db, record.id, "failed", out);
                return JSON.stringify(out);
              }
            }
            if (canonicalKind === "price_approval" && opCase) {
              const context =
                opCase.context_jsonb && typeof opCase.context_jsonb === "object"
                  ? (opCase.context_jsonb as Record<string, unknown>)
                  : {};
              const pricingProposal = isRecord(context.pricing_proposal)
                ? context.pricing_proposal
                : null;
              const salida = positiveNumberFromUnknown(pricingProposal?.salida);
              const ideal = positiveNumberFromUnknown(pricingProposal?.ideal);
              const minimo = positiveNumberFromUnknown(pricingProposal?.minimo);
              const hasConcreteProposal =
                salida != null && ideal != null && minimo != null;
              if (opCase.current_step === "comparables_in_progress") {
                const out = {
                  ok: false,
                  error: "price_approval_blocked_before_advance",
                  hint:
                    "No solicites price_approval en comparables_in_progress. Tras operational_case_persist_comparables_analysis con muestra defendible el sistema avanza a price_proposal_pending, genera pricing_proposal y notifica price_approval con números concretos.",
                };
                await updateToolCallStatus(ctx.db, record.id, "failed", out);
                return JSON.stringify(out);
              }
              if (
                opCase.current_step === "price_proposal_pending" &&
                !hasConcreteProposal
              ) {
                const out = {
                  ok: false,
                  error: "pricing_proposal_required_before_price_approval",
                  hint:
                    "Antes de solicitar price_approval debes persistir pricing_proposal con valores concretos (salida, ideal, minimo) y rationale/comparables_used.",
                };
                await updateToolCallStatus(ctx.db, record.id, "failed", out);
                return JSON.stringify(out);
              }

              const recentEvents = await getRecentOperationalCaseEvents(
                ctx.db,
                opCase.id,
                20
              );
              if (priceApprovalNotificationAlreadyDelivered(recentEvents)) {
                const out = {
                  ok: false,
                  error: "price_approval_already_notified",
                  hint:
                    "El sistema ya solicitó aprobación de precio con la propuesta canónica. No reenvíes notify_user(kind=price_approval); resuelve el pendiente existente o espera la decisión del asesor.",
                };
                await updateToolCallStatus(ctx.db, record.id, "failed", out);
                return JSON.stringify(out);
              }
              if (
                opCase.current_step === "price_proposal_pending" &&
                hasConcreteProposal &&
                looksLikeComparablesCompletionProse(input.text) &&
                (priceApprovalNotificationAlreadyDelivered(recentEvents) ||
                  priceApprovalRequestEventExists(recentEvents))
              ) {
                const out = {
                  ok: false,
                  error: "price_approval_prose_summary_blocked",
                  hint:
                    "No envíes un resumen libre de comparables como price_approval. Tras operational_case_persist_comparables_analysis el sistema notifica automáticamente con salida/ideal/mínimo.",
                };
                await updateToolCallStatus(ctx.db, record.id, "failed", out);
                return JSON.stringify(out);
              }
            }
            if (canonicalKind === "listing_published_summary" && opCase) {
              const recentEvents = await getRecentOperationalCaseEvents(
                ctx.db,
                opCase.id,
                30
              );
              const context =
                opCase.context_jsonb && typeof opCase.context_jsonb === "object"
                  ? (opCase.context_jsonb as Record<string, unknown>)
                  : {};
              const completionGate = canCompleteListingPublishedSummaryFromContext(
                context,
                recentEvents
              );
              if (!completionGate.ok) {
                const out = {
                  ok: false,
                  error: "listing_published_summary_blocked",
                  hint: completionGate.reason,
                };
                await updateToolCallStatus(ctx.db, record.id, "failed", out);
                return JSON.stringify(out);
              }
              const alreadySent = listingPublishedSummaryAlreadySent(recentEvents);
              if (alreadySent) {
                const out = {
                  ok: true,
                  status: "listing_published_summary_already_sent",
                  skipped: true,
                  case_id: opCase.id,
                };
                await updateToolCallStatus(ctx.db, record.id, "executed", out);
                return JSON.stringify(out);
              }
            }
            if (canonicalKind === "contract_review" && opCase) {
              const contractReviewGate = evaluateContractReviewNotifyGate(
                opCase.context_jsonb
              );
              if (!contractReviewGate.ok) {
                const out = {
                  ok: false,
                  error: contractReviewGate.error,
                  hint: contractReviewGate.hint,
                };
                await updateToolCallStatus(ctx.db, record.id, "failed", out);
                return JSON.stringify(out);
              }
            }
            if (canonicalKind === "listing_description_review" && opCase) {
              const listingReviewGate = evaluateListingDescriptionReviewNotifyGate(
                opCase.context_jsonb
              );
              if (!listingReviewGate.ok) {
                const out = {
                  ok: false,
                  error: listingReviewGate.error,
                  hint: listingReviewGate.hint,
                };
                await updateToolCallStatus(ctx.db, record.id, "failed", out);
                return JSON.stringify(out);
              }
            }
            if (canonicalKind === "ungga_publish_approval" && opCase) {
              const unggaGate = evaluateUnggaPublishApprovalNotifyGate(
                opCase.context_jsonb
              );
              if (!unggaGate.ok) {
                const out = {
                  ok: false,
                  error: unggaGate.error,
                  hint: unggaGate.hint,
                };
                await updateToolCallStatus(ctx.db, record.id, "failed", out);
                return JSON.stringify(out);
              }
              const { data: unreadRows } = await ctx.db
                .from("internal_user_notifications")
                .select("id")
                .eq("user_id", ctx.userId)
                .eq("case_id", opCase.id)
                .eq("kind", "ungga_publish_approval")
                .eq("status", "unread")
                .limit(1);
              if (Array.isArray(unreadRows) && unreadRows.length > 0) {
                const out = {
                  ok: false,
                  error: "ungga_publish_approval_already_notified",
                  hint:
                    "Ya hay un pendiente unread de ungga_publish_approval. No reenvíes notify_user; espera la decisión humana.",
                };
                await updateToolCallStatus(ctx.db, record.id, "failed", out);
                return JSON.stringify(out);
              }
            }
            let notificationText = input.text;
            let contractCommercialForNotify: ReturnType<
              typeof evaluateContractCommercialMinimums
            > | null = null;
            if (canonicalKind === "property_data_review") {
              notificationText = canonicalizePropertyDataReviewText(opCase, input.text);
            } else if (canonicalKind === "price_approval" && opCase) {
              const priceContext =
                opCase.context_jsonb && typeof opCase.context_jsonb === "object"
                  ? (opCase.context_jsonb as Record<string, unknown>)
                  : {};
              const pricingProposalForNotify = isRecord(priceContext.pricing_proposal)
                ? priceContext.pricing_proposal
                : null;
              const notifySalida = positiveNumberFromUnknown(
                pricingProposalForNotify?.salida
              );
              const notifyIdeal = positiveNumberFromUnknown(pricingProposalForNotify?.ideal);
              const notifyMinimo = positiveNumberFromUnknown(
                pricingProposalForNotify?.minimo
              );
              if (
                notifySalida != null &&
                notifyIdeal != null &&
                notifyMinimo != null &&
                pricingProposalForNotify
              ) {
                notificationText = formatPriceApprovalNotifyText(
                  pricingProposalForNotify as PricingProposal
                );
              }
            } else if (canonicalKind === "listing_description_review" && opCase) {
              const descriptionContext =
                opCase.context_jsonb && typeof opCase.context_jsonb === "object"
                  ? (opCase.context_jsonb as Record<string, unknown>)
                  : {};
              const draft = isRecord(descriptionContext.listing_description_draft)
                ? descriptionContext.listing_description_draft
                : null;
              if (draft) {
                notificationText = formatListingDescriptionReviewNotifyText(draft, {
                  currentContext: descriptionContext,
                });
              }
            } else if (canonicalKind === "contract_data_review") {
              if (opCase) {
                const contractContext =
                  opCase.context_jsonb && typeof opCase.context_jsonb === "object"
                    ? (opCase.context_jsonb as Record<string, unknown>)
                    : {};
                contractCommercialForNotify = evaluateContractCommercialMinimums({
                  context: contractContext,
                  propertyData: isRecord(contractContext.property_data)
                    ? contractContext.property_data
                    : {},
                  externalContact: isRecord(opCase.external_contact_jsonb)
                    ? (opCase.external_contact_jsonb as Record<string, unknown>)
                    : {},
                  requireConfirmation: true,
                });
                notificationText = buildContractCommercialMinimumsSummaryMessage(
                  contractCommercialForNotify
                );
              } else {
                notificationText = canonicalizeContractDataReviewText(input.text);
              }
            } else if (canonicalKind === "contract_review" && opCase) {
              notificationText = canonicalContractReviewNotifyText(opCase);
            } else if (
              canonicalKind === "easybroker_publish_approval" ||
              canonicalKind === "ungga_publish_approval"
            ) {
              notificationText = canonicalPublishDestinationApprovalText(canonicalKind);
            } else if (canonicalKind === "listing_published_summary" && opCase) {
              notificationText = formatListingPublishedSummaryNotifyText(opCase);
            }
            if (
              canonicalKind === "contract_data_review" &&
              opCase &&
              contractCommercialForNotify
            ) {
              const missingRequiredFields = contractCommercialForNotify.missing
                .filter((item) => item.optional !== true)
                .map((item) => item.key);
              const ownedNotificationId =
                await activeOwnedContractDataReviewNotificationId(
                  ctx.db,
                  ctx.userId,
                  opCase.id,
                  missingRequiredFields
                );
              if (ownedNotificationId) {
                const out = {
                  ok: true,
                  status: "contract_data_review_already_notified",
                  skipped: true,
                  notification_id: ownedNotificationId,
                  missing_required_fields: missingRequiredFields,
                };
                await updateToolCallStatus(ctx.db, record.id, "executed", out);
                return JSON.stringify(out);
              }
            }
            const result = await deps.notifyUser(
              ctx.db,
              ctx.userId,
              {
                text: notificationText,
                // Persistimos el kind canónico para que la config del inbox
                // (informational vs. actionable) se aplique correctamente.
                kind: canonicalKind,
                data: {
                  ...(caseId ? { case_id: caseId } : {}),
                  ...(canonicalKind === "price_approval"
                    ? {
                        artifact_key: "pricing_proposal",
                        actions: ["approve", "adjust", "reject"],
                      }
                    : {}),
                  ...(canonicalKind === "listing_description_review"
                    ? {
                        artifact_key: "listing_description_draft",
                        actions: ["approve", "request_changes"],
                      }
                    : {}),
                  ...(canonicalKind === "contract_review" && opCase
                    ? {
                        contract_draft_ready: true,
                        artifact_key: "contract_draft",
                      }
                    : {}),
                  ...(canonicalKind === "easybroker_publish_approval" ||
                  canonicalKind === "ungga_publish_approval"
                    ? {
                        actions: ["approve", "skip", "reject"],
                      }
                    : {}),
                  ...(canonicalKind === "contract_data_review"
                    ? {
                        missing_required_fields: contractCommercialForNotify
                          ? contractCommercialForNotify.missing
                              .filter((item) => item.optional !== true)
                              .map((item) => item.key)
                          : extractMissingContractFieldsFromText(notificationText),
                        missing_fields:
                          contractCommercialForNotify?.missing ?? undefined,
                        known_fields:
                          contractCommercialForNotify?.known ?? undefined,
                      }
                    : {}),
                },
              },
              input.urgency ?? "normal"
            );
            const out = {
              ok: result.delivered.length > 0,
              attempted: result.attempted,
              delivered: result.delivered,
            };
            if (
              canonicalKind === "listing_description_review" &&
              caseId &&
              result.delivered.length > 0
            ) {
              const descriptionContext =
                opCase?.context_jsonb && typeof opCase.context_jsonb === "object"
                  ? (opCase.context_jsonb as Record<string, unknown>)
                  : {};
              const draft = isRecord(descriptionContext.listing_description_draft)
                ? descriptionContext.listing_description_draft
                : {};
              const draftGeneratedAt =
                typeof draft.generated_at === "string"
                  ? Date.parse(draft.generated_at)
                  : Number.NaN;
              const recentEvents = await getRecentOperationalCaseEvents(
                ctx.db,
                caseId,
                30
              );
              const alreadyRecordedForDraft = recentEvents.some((event) => {
                const payload = isRecord(event.payload_jsonb)
                  ? event.payload_jsonb
                  : {};
                if (payload.kind !== "listing_description_review_requested") {
                  return false;
                }
                if (!Number.isFinite(draftGeneratedAt)) return true;
                return Date.parse(event.created_at) >= draftGeneratedAt;
              });
              if (!alreadyRecordedForDraft) {
                await insertOperationalCaseEvent(ctx.db, {
                  caseId,
                  eventType: "human_decision",
                  actor: "agent",
                  stepKey: "package_ready",
                  payload: {
                    kind: "listing_description_review_requested",
                    source: "notify_user",
                    waiting_for: "advisor_response",
                  },
                });
              }
            }
            if (
              canonicalKind === "listing_published_summary" &&
              caseId &&
              result.delivered.length > 0
            ) {
              await insertOperationalCaseEvent(ctx.db, {
                caseId,
                eventType: "step_completed",
                actor: "agent",
                stepKey: "published",
                payload: { kind: "listing_published_summary_sent" },
              });
            }
            await updateToolCallStatus(ctx.db, record.id, "executed", out);
            return JSON.stringify(out);
          } catch (e) {
            const out = {
              ok: false,
              error: (e as Error).message ?? String(e),
            };
            await updateToolCallStatus(ctx.db, record.id, "failed", out);
            return JSON.stringify(out);
          }
        },
        {
          name: "notify_user",
          description:
            "Notifies the inmobiliario via their preferred channel (web/telegram).",
          schema: z.object({
            text: z.string().min(1),
            kind: z.string().min(1).optional(),
            urgency: z.enum(["low", "normal", "high"]).optional(),
            case_id: z.string().min(1).optional(),
          }),
        }
      )
    );
  }
}

function toolEnabled(toolId: string, ctx: ToolContext): boolean {
  if (
    ctx.activeSkillAllowedTools &&
    ctx.activeSkillAllowedTools.length > 0 &&
    !ctx.activeSkillAllowedTools.includes(toolId)
  ) {
    return false;
  }
  // user_tool_settings opt-in/out: si NO está en la lista, default ON.
  const setting = ctx.enabledTools.find((t) => t.tool_id === toolId);
  if (setting && setting.enabled === false) return false;
  return true;
}
