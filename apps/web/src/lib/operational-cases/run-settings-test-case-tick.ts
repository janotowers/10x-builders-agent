import {
  buildContractDataReviewNotifyText,
  contractDraftOutputPathFromContext,
  evaluatePropertyAdvanceGate,
  formatListingDescriptionReviewNotifyText,
  listingDescriptionDraftContentFromContext,
  runAgent,
  runDocumentFieldExtraction,
} from "@agents/agent";
import {
  createToolCall,
  createServerClient,
  decryptToken,
  getGoogleCalendarAccessToken,
  getOperationalCase,
  getProfile,
  getUserIntegrations,
  getUserSkillSettings,
  getUserToolSettings,
  getOrCreateSession,
  insertOperationalCaseEvent,
  listOperationalCaseDocuments,
  markCaseProcessing,
  updateOperationalCase,
  updateToolCallStatus,
} from "@agents/db";
import {
  SETTINGS_TEST_TELEGRAM_LAB_CHAT_ID,
  isControlledE2EOperationalCase,
  isSettingsOperationalTestCase,
  operationalCaseDocumentRequestTargetFromContext,
  resolveOperationalCaseDocumentRequestTarget,
  type OperationalCase,
  type OperationalCaseDocument,
  type PendingConfirmation,
} from "@agents/types";
import { ensureAgentToolDepsWired } from "@/lib/agent/wire-tool-deps";
import { notify } from "@/lib/notify";
import { buildDocumentChecklistLines } from "@/lib/operational-cases/case-document-collection";
import { healStalePublishFlowBlockers } from "@/lib/operational-cases/finalize-case-after-tool-decision";
import {
  formatUnggaPublishApprovalNotifyText,
  shouldAutoFollowUpPackageReadyTick,
  shouldDeterministicallyRequestUnggaApproval,
} from "@/lib/operational-cases/package-ready-auto-continue";
import {
  buildPublicationAgentHint,
  requestPublicationProgress,
  type PublicationExecutionResult,
} from "@/lib/operational-cases/publication-runner";
import type { PublicationMachineAction } from "@/lib/operational-cases/publication-workflow";
import {
  buildContractDraftDownloadUrl,
  parseContractDraftFromContext,
  parseGenerateDocumentRenderResult,
} from "@/lib/operational-cases/contract-draft-document";
import { buildSettingsTestToolApprovalPolicy } from "@/lib/operational-cases/settings-test-tool-policy";
import { applyPropertyOptioningPostAgentInvariants } from "@/lib/operational-cases/property-optioning-post-agent-invariants";
import {
  countRawPhotos,
  dismissPhotosUploadRequestedNotifications,
  formatPhotosUploadRequestNotifyText,
  PHOTOS_UPLOAD_REQUESTED_NOTIFICATION_KIND,
  RAW_PHOTOS_MIN_COUNT,
} from "@/lib/operational-cases/photo-batch-completion";
import { telegramChatIdFromCase } from "@/lib/operational-cases/settings-test-telegram-lab";

type PostAgentInvariantAction = Awaited<
  ReturnType<typeof applyPropertyOptioningPostAgentInvariants>
>["action"];

type TurnToolCallRow = {
  tool_name: string;
  status: string;
  result_json: Record<string, unknown> | null;
};

function publicationToolForAction(action: PublicationMachineAction): string | null {
  if (!("destination" in action)) return null;
  if (action.destination === "easybroker") {
    if (action.type === "create_draft") return "easybroker_create_listing";
    if (action.type === "process_media") return "easybroker_upload_images";
    if (action.type === "publish") return "easybroker_publish_listing";
  }
  if (
    action.destination === "ungga" &&
    (action.type === "create_draft" || action.type === "publish")
  ) {
    return "ungga_publish_listing";
  }
  return null;
}

export function classifyPublicationExecutionFromToolCalls(
  action: PublicationMachineAction,
  toolCalls: TurnToolCallRow[]
): PublicationExecutionResult {
  const toolName = publicationToolForAction(action);
  if (!toolName) return { status: "not_executed", error: "no_tool_for_action" };
  const call = [...toolCalls].reverse().find((row) => row.tool_name === toolName);
  if (!call) {
    return { status: "not_executed", error: `${toolName}_not_called` };
  }
  const result = call.result_json ?? {};
  if (call.status === "pending_confirmation") {
    return { status: "pending_hitl", result };
  }
  const error =
    typeof result.error === "string"
      ? result.error
      : typeof result.message === "string"
        ? result.message
        : `${toolName}_${call.status}`;
  const unknown =
    /\b(timeout|timed out|killed|kill signal|sigterm|sigkill|aborted|econnreset|socket hang up)\b/i.test(
      error
    );
  if (
    call.status === "failed" ||
    result.ok === false ||
    ["failed", "not_configured", "validation_error"].includes(
      typeof result.status === "string" ? result.status : ""
    )
  ) {
    return { status: unknown ? "unknown_outcome" : "failed", result, error };
  }
  if (call.status !== "executed") {
    return { status: "not_executed", result, error };
  }
  if (action.type === "create_draft") {
    const artifact =
      action.destination === "easybroker"
        ? result.listing_id ?? result.public_id
        : result.ungga_property_id ?? result.property_id ?? result.id;
    if (!artifact || result.dry_run === true || result.status === "dry_run") {
      return {
        status: "failed",
        result,
        error: artifact ? "publication_dry_run" : "publication_artifact_missing",
      };
    }
  }
  if (
    action.type === "process_media" &&
    !(typeof result.count === "number" && result.count >= 0)
  ) {
    return { status: "failed", result, error: "remote_image_submission_unverified" };
  }
  if (
    action.type === "publish" &&
    result.status !== "published" &&
    result.remote_status !== "published" &&
    result.easybroker_status !== "published"
  ) {
    return { status: "failed", result, error: "publish_result_not_published" };
  }
  return { status: "succeeded", result };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deterministicDocumentIdsFromBlocks(
  blocks: ReturnType<typeof evaluatePropertyAdvanceGate>["blocks"]
): string[] {
  const ids = new Set<string>();
  for (const block of blocks) {
    if (block.remediation.owner !== "deterministic") continue;
    for (const id of block.remediation.document_ids ?? []) ids.add(id);
  }
  return [...ids];
}

function shouldSkipPreflightExtraction(document: OperationalCaseDocument): boolean {
  const extraction =
    document.extraction_jsonb && typeof document.extraction_jsonb === "object"
      ? (document.extraction_jsonb as Record<string, unknown>)
      : {};
  if (Object.keys(extraction).length === 0) return false;
  if (document.extraction_status === "ok") return true;
  return document.extraction_status === "low_confidence" && Boolean(document.extracted_at);
}

function contextRecord(opCase: OperationalCase): Record<string, unknown> {
  return opCase.context_jsonb && typeof opCase.context_jsonb === "object"
    ? (opCase.context_jsonb as Record<string, unknown>)
    : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function shouldAutoExecuteContractDraftGeneration(opCase: OperationalCase): boolean {
  if (opCase.case_type !== "property_optioning") return false;
  if (opCase.current_step !== "contract_pending") return false;
  const context = contextRecord(opCase);
  const pricingProposal =
    context.pricing_proposal && typeof context.pricing_proposal === "object"
      ? (context.pricing_proposal as Record<string, unknown>)
      : null;
  return pricingProposal?.approval_status === "approved";
}

/**
 * Tras aprobación de negocio por destino, el tick E2E no debe pedir un segundo
 * HITL técnico para tools high-risk de publicación (mismo patrón que
 * generate_document_from_template tras precio aprobado).
 */
export function shouldAutoExecuteApprovedPublishToolsForTest(
  opCase: OperationalCase
): boolean {
  if (opCase.case_type !== "property_optioning") return false;
  if (opCase.current_step !== "package_ready") return false;
  const context = contextRecord(opCase);
  const approved = context.listing_description_approved;
  if (!approved || typeof approved !== "object" || Array.isArray(approved)) {
    return false;
  }
  const description =
    typeof (approved as Record<string, unknown>).description === "string"
      ? ((approved as Record<string, unknown>).description as string).trim()
      : "";
  if (!description) return false;
  const approvals =
    context.publish_approvals &&
    typeof context.publish_approvals === "object" &&
    !Array.isArray(context.publish_approvals)
      ? (context.publish_approvals as Record<string, unknown>)
      : {};
  return approvals.easybroker === "approved" || approvals.ungga === "approved";
}

function shouldAutoExecuteApprovedPublishTools(opCase: OperationalCase): boolean {
  return shouldAutoExecuteApprovedPublishToolsForTest(opCase);
}

async function listTurnToolCalls(
  db: ReturnType<typeof createServerClient>,
  turnId: string | null | undefined
): Promise<TurnToolCallRow[]> {
  if (!turnId) return [];
  const { data, error } = await db
    .from("tool_calls")
    .select("tool_name,status,result_json")
    .eq("turn_id", turnId);
  if (error) return [];
  return (data ?? []) as TurnToolCallRow[];
}

function hasRenderedContractDraftFromToolCalls(toolCalls: TurnToolCallRow[]): boolean {
  return toolCalls.some((call) => {
    if (call.tool_name !== "generate_document_from_template") return false;
    if (call.status !== "executed") return false;
    return parseGenerateDocumentRenderResult(call.result_json ?? undefined) != null;
  });
}

export function missingContractFieldsFromToolCalls(toolCalls: TurnToolCallRow[]): string[] {
  const fields = new Set<string>();
  for (const call of toolCalls) {
    if (call.tool_name !== "generate_document_from_template") continue;
    const result = call.result_json ?? {};
    if (result.error !== "commission_contract_missing_required_data") continue;
    const missing = result.missing_required_fields;
    if (!Array.isArray(missing)) continue;
    for (const field of missing) {
      if (typeof field === "string" && field.trim()) fields.add(field.trim());
    }
  }
  return [...fields];
}

export type ContractGenerationFailureKind =
  | "not_attempted"
  | "template_missing"
  | "titularidad_review_required"
  | "owner_corroboration_incomplete"
  | "pending_confirmation"
  | "unknown";

/** Clasifica por qué el tick de contrato no dejó un borrador renderizado. */
export function classifyContractGenerationFailureFromToolCalls(
  toolCalls: TurnToolCallRow[]
): { kind: ContractGenerationFailureKind; detail?: string } {
  const generateCalls = toolCalls.filter(
    (call) => call.tool_name === "generate_document_from_template"
  );
  if (generateCalls.length === 0) {
    return { kind: "not_attempted" };
  }
  if (generateCalls.some((call) => call.status === "pending_confirmation")) {
    return { kind: "pending_confirmation" };
  }
  for (const call of generateCalls) {
    const result = call.result_json ?? {};
    const error = typeof result.error === "string" ? result.error : "";
    const status = typeof result.status === "string" ? result.status : "";
    if (status === "not_configured" || /template|not_configured|plantilla/i.test(error)) {
      return {
        kind: "template_missing",
        detail:
          typeof result.hint === "string" && result.hint.trim()
            ? result.hint.trim()
            : undefined,
      };
    }
    if (error === "titularidad_review_required") {
      return { kind: "titularidad_review_required" };
    }
    if (error === "owner_corroboration_extraction_incomplete") {
      return { kind: "owner_corroboration_incomplete" };
    }
  }
  const last = generateCalls[generateCalls.length - 1];
  const lastError =
    typeof last?.result_json?.error === "string"
      ? last.result_json.error
      : typeof last?.result_json?.status === "string"
        ? last.result_json.status
        : undefined;
  return { kind: "unknown", detail: lastError };
}

function contractGenerationFailureNotify(params: {
  failure: { kind: ContractGenerationFailureKind; detail?: string };
  caseId: string;
}): { kind: string; text: string } {
  switch (params.failure.kind) {
    case "template_missing":
      return {
        kind: "contract_template_missing",
        text:
          "No pude generar el borrador del contrato: falta la plantilla DOCX `commission_contract_template` en la cuenta. Súbela en Preparación operativa y pulsa «Revisar avance».",
      };
    case "titularidad_review_required":
      return {
        kind: "titularidad_review",
        text:
          "No pude generar el contrato porque la titularidad no está verificada (desajuste entre documentos). Confirma si avanzamos con override o corrige la identificación/comprobante, y luego pulsa «Revisar avance».",
      };
    case "owner_corroboration_incomplete":
      return {
        kind: "case_update",
        text:
          "No pude generar el contrato: falta terminar la extracción de identificación/comprobante del propietario. Pulsa «Revisar avance» para reintentar la extracción y el borrador.",
      };
    case "pending_confirmation":
      return {
        kind: "case_update",
        text:
          "La generación del contrato quedó pendiente de aprobación humana (HITL). Aprueba la tool en Pendientes y continúa.",
      };
    case "not_attempted":
      return {
        kind: "case_update",
        text:
          "El caso avanzó a contrato, pero en este tick no se generó el borrador DOCX. Pulsa «Revisar avance» para preparar el contrato de comisión.",
      };
    default:
      return {
        kind: "case_update",
        text: params.failure.detail
          ? `No pude verificar el borrador del contrato (${params.failure.detail}). Pulsa «Revisar avance» para reintentar.`
          : "No pude verificar el borrador del contrato (falta render real). Pulsa «Revisar avance» para reintentar.",
      };
  }
}

/** Ingredientes faltantes reportados por prepare_listing_description_draft en el turno. */
export function missingListingDescriptionIngredientsFromToolCalls(
  toolCalls: TurnToolCallRow[]
): string[] {
  const fields = new Set<string>();
  for (const call of toolCalls) {
    if (call.tool_name !== "prepare_listing_description_draft") continue;
    const result = call.result_json ?? {};
    if (result.status !== "missing_required_ingredients") continue;
    const missing = result.missing_ingredients;
    if (!Array.isArray(missing)) continue;
    for (const field of missing) {
      if (typeof field === "string" && field.trim()) fields.add(field.trim());
    }
  }
  return [...fields];
}

function hasListingDescriptionDraftFromToolCalls(toolCalls: TurnToolCallRow[]): boolean {
  return toolCalls.some((call) => {
    if (call.tool_name !== "prepare_listing_description_draft") return false;
    if (call.status !== "executed") return false;
    const result = call.result_json ?? {};
    return result.status === "drafted" || result.ok === true;
  });
}

function hasEasybrokerUploadFromToolCalls(toolCalls: TurnToolCallRow[]): boolean {
  return toolCalls.some((call) => {
    if (call.tool_name !== "easybroker_upload_images") return false;
    if (call.status !== "executed") return false;
    const result = call.result_json ?? {};
    return result.ok !== false && result.status !== "failed";
  });
}

function hasEasybrokerUploadFailureFromToolCalls(
  toolCalls: TurnToolCallRow[]
): { failed: boolean; error: string | null } {
  for (const call of toolCalls) {
    if (call.tool_name !== "easybroker_upload_images") continue;
    if (call.status === "failed") {
      const result = call.result_json ?? {};
      const error =
        typeof result.error === "string"
          ? result.error
          : "easybroker_upload_images failed";
      return { failed: true, error };
    }
    const result = call.result_json ?? {};
    if (result.ok === false || result.status === "failed") {
      const error =
        typeof result.error === "string"
          ? result.error
          : "easybroker_upload_images failed";
      return { failed: true, error };
    }
  }
  return { failed: false, error: null };
}

async function hasUnreadUnggaPublishApprovalNotification(
  db: ReturnType<typeof createServerClient>,
  userId: string,
  caseId: string
) {
  const { data, error } = await db
    .from("internal_user_notifications")
    .select("id")
    .eq("user_id", userId)
    .eq("case_id", caseId)
    .eq("kind", "ungga_publish_approval")
    .eq("status", "unread")
    .limit(1)
    .maybeSingle();
  if (error) return false;
  return Boolean(data?.id);
}

/** Revisión humana que exige regenerar borrador antes de un nuevo notify. */
export function listingDescriptionReviewNeedsRegeneration(
  context: Record<string, unknown> | null | undefined
): boolean {
  if (!context) return false;
  const review = context.listing_description_review;
  if (!review || typeof review !== "object" || Array.isArray(review)) return false;
  const status =
    typeof (review as Record<string, unknown>).status === "string"
      ? ((review as Record<string, unknown>).status as string)
      : null;
  return (
    status === "changes_requested" ||
    status === "highlights_added" ||
    status === "regeneration_requested"
  );
}

async function hasUnreadListingDescriptionReviewNotification(
  db: ReturnType<typeof createServerClient>,
  userId: string,
  caseId: string
) {
  const { data, error } = await db
    .from("internal_user_notifications")
    .select("id")
    .eq("user_id", userId)
    .eq("case_id", caseId)
    .eq("kind", "listing_description_review")
    .eq("status", "unread")
    .limit(1)
    .maybeSingle();
  if (error) return false;
  return Boolean(data?.id);
}

async function hasUnreadPhotosUploadRequestedNotification(
  db: ReturnType<typeof createServerClient>,
  userId: string,
  caseId: string
) {
  const { data, error } = await db
    .from("internal_user_notifications")
    .select("id")
    .eq("user_id", userId)
    .eq("case_id", caseId)
    .eq("kind", PHOTOS_UPLOAD_REQUESTED_NOTIFICATION_KIND)
    .eq("status", "unread")
    .limit(1)
    .maybeSingle();
  if (error) return false;
  return Boolean(data?.id);
}

function propertyLabelFromCaseContext(context: Record<string, unknown>): string | null {
  const propertyData =
    context.property_data &&
    typeof context.property_data === "object" &&
    !Array.isArray(context.property_data)
      ? (context.property_data as Record<string, unknown>)
      : {};
  for (const key of ["property_title", "address", "legal_address"] as const) {
    const value = propertyData[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/** Descarta listing_description_review prematuro cuando aún no hay borrador. */
async function dismissPrematureListingDescriptionReviewNotifications(
  db: ReturnType<typeof createServerClient>,
  userId: string,
  caseId: string
) {
  await db
    .from("internal_user_notifications")
    .update({
      status: "read",
      read_at: new Date().toISOString(),
    })
    .eq("user_id", userId)
    .eq("case_id", caseId)
    .eq("kind", "listing_description_review")
    .eq("status", "unread");
}

async function hasUnreadContractReviewNotification(
  db: ReturnType<typeof createServerClient>,
  userId: string,
  caseId: string
) {
  const { data, error } = await db
    .from("internal_user_notifications")
    .select("id")
    .eq("user_id", userId)
    .eq("case_id", caseId)
    .eq("kind", "contract_review")
    .eq("status", "unread")
    .limit(1)
    .maybeSingle();
  if (error) return false;
  return Boolean(data?.id);
}

async function hasUnreadContractDataNotification(
  db: ReturnType<typeof createServerClient>,
  userId: string,
  caseId: string
) {
  const { data, error } = await db
    .from("internal_user_notifications")
    .select("id,kind")
    .eq("user_id", userId)
    .eq("case_id", caseId)
    .in("kind", ["contract_data_review", "contract_generation_error"])
    .eq("status", "unread")
    .limit(10);
  if (error) return false;
  return Array.isArray(data) && data.length > 0;
}

async function dismissUnreadContractGenerationErrorNotifications(
  db: ReturnType<typeof createServerClient>,
  userId: string,
  caseId: string
) {
  await db
    .from("internal_user_notifications")
    .update({
      status: "read",
      read_at: new Date().toISOString(),
    })
    .eq("user_id", userId)
    .eq("case_id", caseId)
    .eq("kind", "contract_generation_error")
    .eq("status", "unread");
}

/** Descarta contract_review prematuro cuando aún no hay borrador renderizado. */
async function dismissPrematureContractReviewNotifications(
  db: ReturnType<typeof createServerClient>,
  userId: string,
  caseId: string
) {
  await db
    .from("internal_user_notifications")
    .update({
      status: "read",
      read_at: new Date().toISOString(),
    })
    .eq("user_id", userId)
    .eq("case_id", caseId)
    .eq("kind", "contract_review")
    .eq("status", "unread");
}

async function runAuditedDocumentExtraction(params: {
  db: ReturnType<typeof createServerClient>;
  sessionId: string;
  opCase: OperationalCase;
  userId: string;
  documentId: string;
  force: boolean;
  source: string;
}) {
  const args = { document_id: params.documentId, force: params.force };
  const record = await createToolCall(
    params.db,
    params.sessionId,
    "operational_case_extract_document_fields",
    args,
    false,
    null,
    {
      executorKind: "deterministic",
      metadata: {
        case_id: params.opCase.id,
        operational_step_key: params.opCase.current_step ?? "documents_received",
        channel: "case_runner",
        source: "agent_e2e",
      },
    }
  );
  const out = await runDocumentFieldExtraction(params.db, {
    userId: params.userId,
    documentId: params.documentId,
    force: params.force,
  });
  await updateToolCallStatus(params.db, record.id, out.ok ? "executed" : "failed", out);
  return out;
}

async function ensureRequiredDocumentExtractionsForE2E(params: {
  db: ReturnType<typeof createServerClient>;
  sessionId: string;
  opCase: OperationalCase;
  userId: string;
  source: string;
}): Promise<{
  status: "ready" | "blocked";
  documents: OperationalCaseDocument[];
  blockingDocumentIds: string[];
  blockingReasons: string[];
}> {
  let documents = await listOperationalCaseDocuments(params.db, {
    caseId: params.opCase.id,
    statuses: ["received"],
  });
  const initialIds = new Set(documents.map((document) => document.id));

  for (const document of documents) {
    if (shouldSkipPreflightExtraction(document)) continue;
    await runAuditedDocumentExtraction({
      ...params,
      documentId: document.id,
      force: false,
      source: `${params.source}:preflight_all_received_documents`,
    });
  }

  documents = await listOperationalCaseDocuments(params.db, {
    caseId: params.opCase.id,
    statuses: ["received"],
  });
  let gate = evaluatePropertyAdvanceGate({
    documents,
    context: params.opCase.context_jsonb,
    targetTransition: "comparables_in_progress",
  });
  const remediationIds = deterministicDocumentIdsFromBlocks(gate.blocks).filter((id) =>
    initialIds.has(id)
  );

  for (const documentId of remediationIds) {
    await runAuditedDocumentExtraction({
      ...params,
      documentId,
      force: true,
      source: `${params.source}:preflight_remediation`,
    });
  }

  documents = await listOperationalCaseDocuments(params.db, {
    caseId: params.opCase.id,
    statuses: ["received"],
  });
  gate = evaluatePropertyAdvanceGate({
    documents,
    context: params.opCase.context_jsonb,
    targetTransition: "comparables_in_progress",
  });
  const blockingDocumentIds = deterministicDocumentIdsFromBlocks(gate.blocks);
  // Importante: los bloqueos de calidad predial con owner=human NO deben
  // detener aquí el tick E2E como "blocked_pending_extraction". Esos casos
  // se atienden en applyPropertyOptioningPostAgentInvariants, que emite
  // notify_user(kind=property_data_quality_review) y deja el caso en
  // waiting_internal con acción humana clara. Si bloqueamos en preflight,
  // el panel queda en limbo sin pendiente accionable.
  if (blockingDocumentIds.length > 0) {
    return {
      status: "blocked",
      documents,
      blockingDocumentIds: [...new Set(blockingDocumentIds)],
      blockingReasons: gate.blocks.map((block) => block.reason),
    };
  }
  return { status: "ready", documents, blockingDocumentIds: [], blockingReasons: [] };
}

/**
 * Translate the deterministic invariant outcome into an honest controlled-E2E
 * status so the lab panel never reports a hollow "tick completed" when the case
 * is actually waiting on the owner or blocked on document extraction.
 */
function deriveControlledE2EStatus(
  action: PostAgentInvariantAction,
  pendingConfirmation: boolean
): string {
  if (pendingConfirmation) return "pending_hitl";
  switch (action) {
    case "requested_property_data_review":
    case "remediated_extraction":
      return "manual_tick_completed";
    case "asked_missing_characteristics":
    case "asked_missing_characteristics_again":
      return "waiting_external";
    case "asked_missing_characteristics_internal":
    case "asked_missing_characteristics_again_internal":
    case "requested_comparables_decision":
    case "requested_property_data_quality_review":
      return "waiting_internal";
    case "deferred_pending_extraction":
      return "blocked_pending_extraction";
    case "remediated_comparables":
      return "manual_tick_completed";
    case "advanced_to_price_proposal":
      return "waiting_internal";
    case "escalated_extraction_to_human":
      return "extraction_escalated_to_human";
    case "no_action":
    case "not_applicable":
    default:
      return "manual_tick_completed";
  }
}

export function deriveControlledE2EStatusForTest(
  action: PostAgentInvariantAction,
  pendingConfirmation: boolean
): string {
  return deriveControlledE2EStatus(action, pendingConfirmation);
}

export function shouldProcessOwnerResponseAsDocumentsReplyForTest(params: {
  currentStep: OperationalCase["current_step"];
  ownerResponseText?: string;
}): boolean {
  return (
    params.currentStep === "documents_received" &&
    Boolean(params.ownerResponseText?.trim())
  );
}

export function isSettingsTestCase(opCase: OperationalCase): boolean {
  return isSettingsOperationalTestCase(opCase);
}

function buildCaseE2ETickMessage(
  opCase: OperationalCase,
  options?: { ownerResponseText?: string }
): string {
  const context =
    opCase.context_jsonb && typeof opCase.context_jsonb === "object"
      ? (opCase.context_jsonb as Record<string, unknown>)
      : {};
  const explicitDocumentRequestTarget =
    operationalCaseDocumentRequestTargetFromContext(context);
  if (
    shouldProcessOwnerResponseAsDocumentsReplyForTest({
      currentStep: opCase.current_step,
      ownerResponseText: options?.ownerResponseText,
    })
  ) {
    return [
      `Procesa la respuesta reciente del dueño en el caso ${opCase.id}.`,
      `Estado actual: status=${opCase.status}, current_step=${opCase.current_step ?? "(none)"}.`,
      "Acción esperada: sub-skill extract-property-characteristics mientras el caso esté en documents_received.",
      "Integra el evento external_response reciente en context_jsonb.property_data.",
      "No avances a comparables, precio, contrato ni publicación en este tick.",
      "Antes de extraer, llama operational_case_list_documents y usa únicamente IDs UUID reales devueltos ahí; nunca uses placeholders como <document_id>.",
      "Antes de preguntar faltantes, consolida lo extraído de documentos de propiedad (escritura, predial, boleta): titulares, dirección legal y superficie/metraje. No uses dirección de IFE/comprobante como dirección del inmueble salvo que esté marcada como propiedad.",
      explicitDocumentRequestTarget === "internal_user"
        ? "Si faltan campos mínimos, notifícalos al asesor interno (notify_user) y conserva status=waiting_internal/current_step=documents_received. NO uses telegram_send_message_to_contact cuando document_request_target=internal_user."
        : "Si faltan campos mínimos, prepara preguntas al dueño (purpose=characteristics_pending). Mínimos comunes: dueño/titulares, dirección y superficie/metraje. Por tipo: casa requiere construcción m2, plantas, recámaras, baños completos, medios baños, cocina integral y cajones de estacionamiento; departamento requiere recámaras, baños completos, medios baños, cajones, piso, elevador y amenidades; terreno requiere metraje y si está en coto/condominio/parque industrial o es independiente; bodega/nave requiere m2 de bodega, altura, oficinas si aplica, baños, cajones, KVA y transformador. Para terrenos/lotes no preguntes recámaras, baños ni estacionamientos salvo que exista construcción.",
      "Al mezclar datos, conserva como canónicos los campos del intake ya confirmado (property_title, property_zone, operation_type, property_type). Los documentos pueden aportar dirección legal, superficie, folio, titular, medidas y colindancias, pero no deben reemplazar property_type='Terreno' por etiquetas notariales como 'Unidad Privativa' salvo que pidas confirmación explícita como posible conflicto.",
      "Si los mínimos están completos, solicita revisión interna con notify_user(kind=property_data_review). En ese mensaje separa claramente: datos confirmados por intake; datos encontrados en documentos; faltantes/advertencias/conflictos. No pongas tipo/operación/zona como datos extraídos si solo vienen del intake. No combines zona y dirección bajo un solo campo. Para terrenos/lotes muestra recámaras/baños/estacionamientos como 'No aplica' salvo que exista construcción.",
    ].join(" ");
  }
  const settingsTestCase = isSettingsOperationalTestCase(opCase);
  const controlledE2ECase = isControlledE2EOperationalCase(opCase);
  const externalChatId =
    telegramChatIdFromCase(opCase, context) ??
    (settingsTestCase || controlledE2ECase
        ? SETTINGS_TEST_TELEGRAM_LAB_CHAT_ID
      : null);
  const documentRequestTarget = resolveOperationalCaseDocumentRequestTarget({
    externalContact: opCase.external_contact_jsonb,
    context,
  });
  return [
    `Tick E2E controlado para el caso ${opCase.id} (case_type=${opCase.case_type}, status=${opCase.status}, current_step=${opCase.current_step ?? "(none)"}).`,
    settingsTestCase || controlledE2ECase
      ? "Ejecuta la siguiente acción según la skill del caso de prueba. En este tick de prueba controlada las tools operativas y Telegram al contacto están pre-autorizadas (sin HITL)."
      : "Ejecuta la siguiente acción según la skill del caso. Este tick reemplaza al cron para un recorrido E2E controlado; los mensajes entrantes por Telegram siguen siendo parte del flujo real.",
    explicitDocumentRequestTarget === "external_contact" && externalChatId
      ? `Contacto externo Telegram del caso: usa exactamente chat_id=${externalChatId} al llamar telegram_send_message_to_contact.`
      : "",
    opCase.current_step === "awaiting_documents"
      ? [
          explicitDocumentRequestTarget == null
            ? "Acción esperada para este paso: antes de pedir documentos, solicita al asesor elegir destino («interno» o «externo») con notify_user(kind=case_update). No envíes solicitud documental todavía."
            : documentRequestTarget === "external_contact"
            ? "Acción esperada para este paso: usa request-property-documents, envía el mensaje inicial de solicitud de documentos al contacto por Telegram, registra reminder_sent con purpose=initial_request y deja el caso en waiting_external / awaiting_documents."
            : "Acción esperada para este paso: NO contactes al dueño por Telegram. Usa notify_user(kind=case_update) para pedir al asesor interno que suba documentos al caso (web, Telegram interno o panel de casos) y confirme con “listo” cuando termine.",
          explicitDocumentRequestTarget == null
            ? "Si el asesor responde «interno», registra document_request_target=internal_user. Si responde «externo», registra document_request_target=external_contact y entonces sí solicita documentos al contacto."
            : documentRequestTarget === "external_contact"
            ? "El mensaje inicial DEBE enumerar documentos específicos, no uses una frase genérica. Incluye estos bullets:"
            : "La notificación interna DEBE enumerar documentos específicos, no uses una frase genérica. Incluye estos bullets:",
          ...buildDocumentChecklistLines(),
          explicitDocumentRequestTarget === "external_contact"
            ? "Si falta alguno, pide que envíe lo disponible y aclara que pueden continuar por texto sin detener el proceso."
            : "Si falta alguno, indica que puede subir lo disponible y continuar por texto sin detener el proceso.",
          "Incluye una frase breve de privacidad: solo se usan para verificar la propiedad y armar el contrato; no se comparten sin autorización.",
          explicitDocumentRequestTarget == null
            ? "No avances de awaiting_documents hasta que exista elección explícita de document_request_target."
            : documentRequestTarget === "external_contact"
            ? "No avances a documents_received, comparables, precio ni contrato sin external_response."
            : "No avances a documents_received, comparables, precio ni contrato hasta que el asesor confirme “listo” y exista al menos un documento registrado.",
        ].join(" ")
      : "",
    opCase.current_step === "comparables_in_progress"
      ? [
          "Acción esperada para este paso: usa perform-comparable-analysis.",
          "No regreses a awaiting_documents ni documents_received.",
          "Consulta comparables con easybroker_search_listings, easybroker_search_closed_deals y bigquery_lookup_local_comparables usando property_zone/property_data como filtros.",
          "No uses placeholders con 0 en filtros opcionales (m², precio, cajones). La búsqueda debe correr en escalera determinística strict -> expanded -> wide -> location_only (sin área) antes de concluir insuficiencia real.",
          "Si el tipo es casa/departamento en condominio, intenta siempre get_avaclick_valuation antes de persistir comparables_analysis. Si faltan coordenadas pero hay dirección suficiente, intenta geocode_property_address primero.",
          "Si Avaclick devuelve missing_required_fields, not_configured o validation_error, no bloquees el paso: continúa con las otras fuentes y deja warning explícito en comparables_analysis.",
          "No llames operational_case_persist_comparables_analysis hasta tener get_avaclick_valuation ejecutado (o un resultado no recuperable documentado de Avaclick). Después persiste comparables_analysis; no lo escribas manualmente.",
          "Si detectas que area_construida_m2 es implausible/no confiable, no avances a precio: permanece en comparables_in_progress, status=waiting_internal y notifica con notify_user(kind=property_data_quality_review) solicitando confirmación/corrección.",
          "Si hay muestra defendible, avanza a price_proposal_pending con status=active y notifica al asesor. Si data_quality.search_validity=insufficient_market_data y el caso quedará en waiting_internal, solicita decisión concreta con notify_user(kind=comparables_search_expansion_decision). Usa comparables_insufficient_data solo como resumen informativo no bloqueante. Si data_quality.search_validity=invalid_filters, corrige/reintenta y no notifiques insuficiencia.",
        ].join(" ")
      : "",
    opCase.current_step === "contract_pending"
      ? (() => {
          const pricing =
            context.pricing_proposal &&
            typeof context.pricing_proposal === "object" &&
            !Array.isArray(context.pricing_proposal)
              ? (context.pricing_proposal as Record<string, unknown>)
              : null;
          const approved = pricing?.approval_status === "approved";
          const hasDraft = Boolean(
            contractDraftOutputPathFromContext(context)
          );
          if (!approved) {
            return [
              "Acción esperada para este paso: el precio aún no está aprobado.",
              "No generes contrato. Mantén current_step=contract_pending o regresa a price_proposal_pending según el estado real del caso.",
            ].join(" ");
          }
          if (hasDraft) {
            return [
              "Acción esperada para este paso: ya existe contract_draft.output_path.",
              "Envía notify_user(kind=contract_review) con el enlace estable /api/operational-cases/{case_id}/documents/contract_draft/download.",
              "No regeneres el DOCX salvo que el asesor haya pedido cambios. Deja status=waiting_internal.",
            ].join(" ");
          }
          return [
            "Acción esperada para este paso: preparar el contrato de comisión (prepare-commission-contract).",
            "En este tick SOLO el flujo de contrato: generate_document_from_template y notify_user.",
            "No uses herramientas de fotos, package_ready, EasyBroker ni Ungga.",
            "Llama generate_document_from_template(template_slug=commission_contract, format=docx, case_id=...) exactamente una vez.",
            "Si devuelve titularidad_review_required, notify_user(kind=titularidad_review) y detente en waiting_internal.",
            "Si devuelve owner_corroboration_extraction_incomplete, extrae esos documentos con operational_case_extract_document_fields(force=true) y reintenta una vez.",
            "Si devuelve not_configured / plantilla faltante, notify_user explicando que falta commission_contract_template y deja status=paused.",
            "Si status=rendered con output_path, entonces notify_user(kind=contract_review) con «Descargar borrador del contrato» + /api/operational-cases/{case_id}/documents/contract_draft/download.",
            "No notifiques contract_review sin borrador real. Deja current_step=contract_pending y status=waiting_internal tras pedir revisión.",
          ].join(" ");
        })()
      : "",
    opCase.current_step === "photos_requested"
      ? (() => {
          const photoCount = countRawPhotos(context);
          const propertyLabel = propertyLabelFromCaseContext(context);
          return [
            "Acción esperada para este paso: solicitar fotos al asesor interno (request-property-photos).",
            "En este tick SOLO fotos internas: notify_user, operational_case_add_event y operational_case_update_state.",
            "NO uses telegram_send_message_to_contact ni herramientas de calendario, contrato o publicación.",
            photoCount >= RAW_PHOTOS_MIN_COUNT
              ? `Ya hay ${photoCount} foto(s) en raw_photos. Aun así envía notify_user(kind=photos_upload_requested) recordando el mínimo de ${RAW_PHOTOS_MIN_COUNT} y que responda «listo» para avanzar; no avances a package_ready en este tick.`
              : `Hay ${photoCount} foto(s) en raw_photos. Envía notify_user(kind=photos_upload_requested) pidiendo al menos ${RAW_PHOTOS_MIN_COUNT} fotos${propertyLabel ? ` de ${propertyLabel}` : ""} (fachada, sala/comedor, cocina, recámara principal, baño principal) por web o Telegram interno, e indica que responda «listo» al terminar.`,
            "Inserta operational_case_add_event(reminder_sent, purpose=photos_upload_requested).",
            "Deja current_step=photos_requested y status=waiting_internal. NO avances a package_ready sin «listo» del asesor.",
          ].join(" ");
        })()
      : "",
    opCase.current_step === "package_ready"
      ? (() => {
          const review =
            context.listing_description_review &&
            typeof context.listing_description_review === "object" &&
            !Array.isArray(context.listing_description_review)
              ? (context.listing_description_review as Record<string, unknown>)
              : null;
          const reviewStatus =
            typeof review?.status === "string" ? review.status : null;
          if (
            reviewStatus === "changes_requested" ||
            reviewStatus === "highlights_added"
          ) {
            return [
              "Acción esperada para este paso: el asesor pidió cambios en la descripción comercial.",
              "Llama prepare_listing_description_draft(case_id) incorporando context_jsonb.listing_description_review.change_classification, listing_highlights y listing_description_replacement_candidate si existen.",
              "Si zone_context tiene POIs vacíos o se consultó antes con lat/lng=0, vuelve a llamar lookup_property_surroundings(case_id=...) SIN latitude/longitude (reutiliza geocode del caso) antes de regenerar el borrador.",
              "Después envía notify_user(kind=listing_description_review) con el borrador actualizado para una nueva revisión humana.",
              "No publiques en destinos ni marques listing_description_approved en este tick.",
              "Deja current_step=package_ready y status=waiting_internal.",
            ].join(" ");
          }
          if (reviewStatus === "regeneration_requested") {
            return [
              "Acción esperada para este paso: el asesor cerró un pendiente prematuro sin borrador.",
              "Si falta photo_analysis, llama analyze_property_images(case_id) SIN image_paths.",
              "Si falta zone_context, llama lookup_property_surroundings(case_id=...) SIN latitude/longitude (no pases 0).",
              "Luego prepare_listing_description_draft(case_id) y notify_user(kind=listing_description_review) solo con borrador real.",
              "Deja current_step=package_ready y status=waiting_internal.",
            ].join(" ");
          }
          if (context.listing_description_approved) {
            const publishApprovals =
              context.publish_approvals &&
              typeof context.publish_approvals === "object" &&
              !Array.isArray(context.publish_approvals)
                ? (context.publish_approvals as Record<string, unknown>)
                : {};
            const published =
              context.published &&
              typeof context.published === "object" &&
              !Array.isArray(context.published)
                ? (context.published as Record<string, unknown>)
                : {};
            const easybrokerPublished = Boolean(
              published.easybroker &&
                typeof published.easybroker === "object" &&
                !Array.isArray(published.easybroker) &&
                (typeof (published.easybroker as Record<string, unknown>).listing_id ===
                  "string" ||
                  (published.easybroker as Record<string, unknown>).ok === true)
            );
            const easybrokerDecision =
              typeof publishApprovals.easybroker === "string"
                ? publishApprovals.easybroker
                : null;
            const unggaDecision =
              typeof publishApprovals.ungga === "string"
                ? publishApprovals.ungga
                : null;
            const easybrokerResolvedForNextDestination =
              easybrokerPublished ||
              easybrokerDecision === "skipped" ||
              easybrokerDecision === "rejected";
            const pendingAction = context.publication_runner_pending_action;
            const runnerHint =
              pendingAction &&
              typeof pendingAction === "object" &&
              !Array.isArray(pendingAction) &&
              typeof (pendingAction as Record<string, unknown>).type === "string"
                ? buildPublicationAgentHint(
                    pendingAction as PublicationMachineAction,
                    context
                  )
                : "";
            return [
              "Acción esperada para este paso: continúa publish-listing-package tras la aprobación de descripción.",
              "Solo aplica EasyBroker y Ungga; NO solicites Manual/Inmuebles24/Vivanuncios en este flujo.",
              "Las aprobaciones de destino son una por una, no en un mensaje batch.",
              runnerHint
                ? runnerHint
                : !easybrokerDecision || easybrokerDecision === "pending"
                  ? "Si EasyBroker aún no tiene decisión, envía notify_user(kind=easybroker_publish_approval) con botones Publicar en EasyBroker / No publicar en EasyBroker / Detener y revisar; no publiques todavía."
                  : easybrokerDecision === "approved" && !easybrokerPublished
                    ? "publish_approvals.easybroker=approved y aún NO hay context.published.easybroker: en este tick DEBES llamar easybroker_create_listing(case_id) con title/description/operation/property_type/price/street/location. NO inventes custom_fields, legal_address, area_construida_m2, features libres, lot_width/lot_length=0, internal_id=UUID del caso, placeholders N/D ni latitude/longitude=0; el adapter enriquece desde el caso y allowlista el payload EasyBroker. NO pidas Ungga todavía."
                    : easybrokerDecision === "approved" && easybrokerPublished
                      ? "EasyBroker ya quedó en context.published.easybroker; no lo vuelvas a crear. Si el listing sigue not_published, sube fotos (image_watermark + easybroker_upload_images) y luego easybroker_publish_listing tras preflight. Si Ungga no tiene decisión y EasyBroker ya está publicado/skipped/rejected, envía notify_user(kind=ungga_publish_approval)."
                      : "EasyBroker está skipped/rejected; no lo publiques.",
              !runnerHint &&
              easybrokerResolvedForNextDestination &&
              (!unggaDecision || unggaDecision === "pending")
                ? "Solo ahora (EasyBroker ya publicado, skipped o rejected): si Ungga aún no tiene decisión y ya subiste fotos (o no hay fotos), envía notify_user(kind=ungga_publish_approval)."
                : !runnerHint && unggaDecision === "approved"
                  ? "PUBLICATION: publish_approvals.ungga=approved. Si aún no hay ungga_property_id, llama ungga_publish_listing(action=prepare_draft, case_id) UNA vez (omitir strings vacíos). NO uses publish_draft hasta tener GU-ID y preflight pass. Si el runner indica publish, usa action=publish_draft con ungga_property_id del contexto."
                  : !runnerHint
                    ? "NO solicites Ungga hasta que EasyBroker esté publicado en context.published.easybroker o quede skipped/rejected."
                    : "",
              "Publica solo destinos con publish_approvals.<destino>=approved. Si un destino está skipped/rejected, no lo publiques.",
              "Si no hay decisión humana pendiente, continúa el trabajo de máquina en el mismo tick (create → upload → publish EasyBroker → ask Ungga); no te detengas a mitad.",
              "No escribas published/publish_approvals/photo_manifest/publication vía operational_case_update_state.",
            ]
              .filter(Boolean)
              .join(" ");
          }
          const hasPhotoAnalysis =
            context.photo_analysis &&
            typeof context.photo_analysis === "object" &&
            !Array.isArray(context.photo_analysis) &&
            Object.keys(context.photo_analysis as Record<string, unknown>).length > 0;
          const hasZoneContext =
            context.zone_context &&
            typeof context.zone_context === "object" &&
            !Array.isArray(context.zone_context) &&
            Object.keys(context.zone_context as Record<string, unknown>).length > 0;
          const hasDraft = Boolean(
            listingDescriptionDraftContentFromContext(context)
          );
          return [
            "Acción esperada para este paso: preparar el paquete comercial en orden estricto.",
            hasPhotoAnalysis
              ? "photo_analysis ya existe; no rehagas analyze_property_images salvo que falte evidencia."
              : "Si falta photo_analysis, llama analyze_property_images(case_id) SIN image_paths (se derivan de raw_photos con bucket correcto).",
            hasZoneContext
              ? "zone_context ya existe; no rehagas lookup_property_surroundings salvo que points/POIs estén vacíos (entonces reintenta con case_id y SIN latitude/longitude=0)."
              : "Si falta zone_context, llama lookup_property_surroundings(case_id=...) SIN latitude/longitude (no pases 0; reutiliza el geocode del caso).",
            hasDraft
              ? "listing_description_draft ya existe; envía notify_user(kind=listing_description_review) para revisión humana."
              : "Cuando existan photo_analysis y zone_context, llama prepare_listing_description_draft(case_id).",
            "Solo después de tener listing_description_draft.description envía notify_user(kind=listing_description_review).",
            "No notifiques listing_description_review sin borrador real. No publiques en destinos sin aprobación explícita.",
            "Deja current_step=package_ready y status=waiting_internal tras solicitar la revisión.",
          ].join(" ");
        })()
      : "",
  ].join(" ");
}

export type SettingsTestCaseTickResult = {
  case: OperationalCase;
  pending_confirmation: boolean;
  pendingConfirmation: PendingConfirmation | null;
  response_preview: string | null;
  publication_execution?: PublicationExecutionResult;
};

/**
 * Un tick del agente sobre un caso de prueba creado desde Settings.
 * Usado por la API de pruebas y por el webhook de Telegram cuando el
 * contacto externo responde (el cron no procesa estos casos).
 */
export async function runSettingsTestCaseAgentTick(
  db: ReturnType<typeof createServerClient>,
  opCase: OperationalCase,
  userId: string,
  options?: {
    source?: string;
    skipLock?: boolean;
    ownerResponseText?: string;
    /** Depth of automatic machine-only follow-up ticks (package_ready). */
    autoFollowUpDepth?: number;
  }
): Promise<SettingsTestCaseTickResult> {
  ensureAgentToolDepsWired();

  if (
    isControlledE2EOperationalCase(opCase) ||
    isSettingsOperationalTestCase(opCase)
  ) {
    try {
      await healStalePublishFlowBlockers(db, {
        caseId: opCase.id,
        userId,
      });
      const healed = await getOperationalCase(db, opCase.id);
      if (healed) opCase = healed;
    } catch (error) {
      console.warn(
        "[run-settings-test-case-tick] healStalePublishFlowBlockers failed:",
        error
      );
    }
  }

  const initialContext = contextRecord(opCase);
  if (
    opCase.current_step === "package_ready" &&
    !isRecord(initialContext.publication_runner_pending_action)
  ) {
    const progress = await requestPublicationProgress(
      db,
      opCase.id,
      options?.source ?? "case_tick_publication_entry",
      {
        runAgentTick: async (runnerCase, action) => {
          const tick = await runSettingsTestCaseAgentTick(
            db,
            runnerCase,
            userId,
            {
              ...options,
              source: `publication_runner:${action.type}`,
              skipLock: true,
            }
          );
          return (
            tick.publication_execution ?? {
              status: "not_executed",
              error: "publication_execution_result_missing",
            }
          );
        },
      }
    );
    const afterProgress = (await getOperationalCase(db, opCase.id)) ?? opCase;
    return {
      case: afterProgress,
      pending_confirmation: false,
      pendingConfirmation: null,
      response_preview: progress.message ?? progress.status,
    };
  }

  if (
    opCase.context_jsonb?.created_from === "agent_conversation" &&
    opCase.current_step === "intake" &&
    opCase.context_jsonb?.intake_status !== "complete"
  ) {
    return {
      case: opCase,
      pending_confirmation: false,
      pendingConfirmation: null,
      response_preview:
        "Skipped: conversational intake is incomplete; continue collecting fields in Telegram.",
    };
  }

  if (!options?.skipLock) {
    let caseForLock = opCase;
    const maxLockAttempts = isControlledE2EOperationalCase(opCase) ? 4 : 1;
    for (let attempt = 0; attempt < maxLockAttempts; attempt += 1) {
      const locked = await markCaseProcessing(
        db,
        caseForLock.id,
        caseForLock.version,
        1
      );
      if (locked) {
        break;
      }
      if (attempt === maxLockAttempts - 1) {
        throw new Error("case_busy");
      }
      await sleep(750 * (attempt + 1));
      const reread = await getOperationalCase(db, opCase.id);
      if (!reread) {
        throw new Error("case_not_found");
      }
      caseForLock = reread;
    }
  }

  const fresh = await getOperationalCase(db, opCase.id);
  if (!fresh) {
    throw new Error("case_not_found");
  }
  const caseWithTarget = fresh;
  const pendingPublicationActionRaw = contextRecord(fresh)
    .publication_runner_pending_action;
  const pendingPublicationAction =
    isRecord(pendingPublicationActionRaw) &&
    typeof pendingPublicationActionRaw.type === "string"
      ? (pendingPublicationActionRaw as PublicationMachineAction)
      : null;

  await insertOperationalCaseEvent(db, {
    caseId: fresh.id,
    eventType: "step_completed",
    actor: "system",
    stepKey: fresh.current_step ?? undefined,
    payload: {
      kind: "controlled_test_e2e_started",
      source: options?.source ?? "settings_test_case_tick",
      current_step: fresh.current_step ?? null,
      status: fresh.status,
      note: "Transición con agente sobre caso de prueba (tools reales, pre-autorizadas en Settings).",
    },
  });

  const profile = await getProfile(db, userId);
  const toolSettings = await getUserToolSettings(db, userId);
  const skillSettings = await getUserSkillSettings(db, userId);
  const integrations = await getUserIntegrations(db, userId);

  const githubIntegration = integrations.find((i) => i.provider === "github");
  let githubToken: string | undefined;
  if (githubIntegration) {
    const raw = (githubIntegration as unknown as { encrypted_tokens?: string })
      .encrypted_tokens;
    if (raw) {
      try {
        githubToken = decryptToken(raw);
      } catch {
        /* sin token GitHub */
      }
    }
  }

  const googleCalendarAccessToken =
    (await getGoogleCalendarAccessToken(db, userId)) ?? undefined;
  const session = await getOrCreateSession(db, userId, "case_runner");
  const controlledE2ECase = isControlledE2EOperationalCase(fresh);
  const settingsTestCase = isSettingsOperationalTestCase(fresh);
  const explicitDocumentRequestTarget =
    operationalCaseDocumentRequestTargetFromContext(
      (caseWithTarget.context_jsonb as Record<string, unknown>) ?? null
    );
  const deterministicDocumentsReceivedPath =
    caseWithTarget.current_step === "documents_received";
  const deterministicPriceProposalPath =
    caseWithTarget.current_step === "price_proposal_pending" &&
    Boolean(
      caseWithTarget.context_jsonb &&
        typeof caseWithTarget.context_jsonb === "object" &&
        !Array.isArray(caseWithTarget.context_jsonb) &&
        (caseWithTarget.context_jsonb as Record<string, unknown>).pricing_proposal &&
        typeof (caseWithTarget.context_jsonb as Record<string, unknown>).pricing_proposal ===
          "object"
    );

  if (deterministicDocumentsReceivedPath) {
    const extractionReadiness = await ensureRequiredDocumentExtractionsForE2E({
      db,
      sessionId: session.id,
      opCase: caseWithTarget,
      userId,
      source: options?.source ?? "settings_test_case_tick",
    });
    if (extractionReadiness.status === "blocked") {
      const updated = await updateOperationalCase(db, fresh.id, fresh.version, {
        nextActionAt: controlledE2ECase ? null : new Date().toISOString(),
        context: {
          ...(fresh.context_jsonb ?? {}),
          ...(settingsTestCase
            ? {
                controlled_test_status: "blocked_pending_extraction",
                controlled_test_e2e_last_run_at: new Date().toISOString(),
              }
            : {}),
          ...(controlledE2ECase
            ? {
                e2e_control_status: "blocked_pending_extraction",
                e2e_control_last_run_at: new Date().toISOString(),
                e2e_control_last_invariant_action: "deferred_pending_extraction",
              }
            : {}),
          extraction_preflight_blocked_document_ids:
            extractionReadiness.blockingDocumentIds,
          extraction_preflight_blocking_reasons:
            extractionReadiness.blockingReasons,
        },
      });
      await insertOperationalCaseEvent(db, {
        caseId: fresh.id,
        eventType: "state_changed",
        actor: "system",
        stepKey: fresh.current_step ?? undefined,
        payload: {
          source: options?.source ?? "settings_test_case_tick",
          kind: "document_extraction_preflight_blocked",
          result: "blocked_pending_extraction",
          pending_document_ids: extractionReadiness.blockingDocumentIds,
          reasons: extractionReadiness.blockingReasons,
        },
      });
      return {
        case: updated ?? fresh,
        pending_confirmation: false,
        pendingConfirmation: null,
        response_preview: null,
      };
    }
  }

  if (deterministicDocumentsReceivedPath) {
    const invariantResult = await applyPropertyOptioningPostAgentInvariants({
      db,
      opCase: caseWithTarget,
      source: "post_agent_invariant_e2e",
    });
    const caseAfterDeterministicFallback = invariantResult.case ?? caseWithTarget;
    const version = caseAfterDeterministicFallback.version ?? fresh.version;
    const controlledStatus = deriveControlledE2EStatus(invariantResult.action, false);
    const updated = await updateOperationalCase(db, fresh.id, version, {
      nextActionAt: controlledE2ECase ? null : undefined,
      context: {
        ...(caseAfterDeterministicFallback.context_jsonb ?? fresh.context_jsonb),
        ...(settingsTestCase
          ? {
              test_mode: true,
              controlled_test_e2e_last_run_at: new Date().toISOString(),
              controlled_test_e2e_pending_confirmation: false,
              controlled_test_status: "e2e_tick_completed",
            }
          : {}),
        ...(controlledE2ECase
          ? {
              e2e_control_last_run_at: new Date().toISOString(),
              e2e_control_pending_confirmation: false,
              e2e_control_status: controlledStatus,
              e2e_control_last_invariant_action: invariantResult.action,
            }
          : {}),
      },
    });

    await insertOperationalCaseEvent(db, {
      caseId: fresh.id,
      eventType: "state_changed",
      actor: "system",
      stepKey: (updated ?? caseAfterDeterministicFallback ?? fresh).current_step ?? undefined,
      payload: {
        source: options?.source ?? "settings_test_case_tick",
        result: "e2e_tick_completed",
        pending_confirmation: false,
        invariant_action: invariantResult.action,
        controlled_status: controlledStatus,
        response_preview: null,
      },
    });

    return {
      case: updated ?? caseAfterDeterministicFallback ?? fresh,
      pending_confirmation: false,
      pendingConfirmation: null,
      response_preview: null,
    };
  }

  if (deterministicPriceProposalPath) {
    const invariantResult = await applyPropertyOptioningPostAgentInvariants({
      db,
      opCase: caseWithTarget,
      source: "post_agent_invariant_e2e",
    });
    const caseAfterDeterministicFallback = invariantResult.case ?? caseWithTarget;
    const version = caseAfterDeterministicFallback.version ?? fresh.version;
    const controlledStatus = deriveControlledE2EStatus(invariantResult.action, false);
    const updated = await updateOperationalCase(db, fresh.id, version, {
      nextActionAt: controlledE2ECase ? null : undefined,
      context: {
        ...(caseAfterDeterministicFallback.context_jsonb ?? fresh.context_jsonb),
        ...(settingsTestCase
          ? {
              test_mode: true,
              controlled_test_e2e_last_run_at: new Date().toISOString(),
              controlled_test_e2e_pending_confirmation: false,
              controlled_test_status: "e2e_tick_completed",
            }
          : {}),
        ...(controlledE2ECase
          ? {
              e2e_control_last_run_at: new Date().toISOString(),
              e2e_control_pending_confirmation: false,
              e2e_control_status: controlledStatus,
              e2e_control_last_invariant_action: invariantResult.action,
            }
          : {}),
      },
    });

    await insertOperationalCaseEvent(db, {
      caseId: fresh.id,
      eventType: "state_changed",
      actor: "system",
      stepKey: (updated ?? caseAfterDeterministicFallback ?? fresh).current_step ?? undefined,
      payload: {
        source: options?.source ?? "settings_test_case_tick",
        result: "e2e_tick_completed",
        pending_confirmation: false,
        invariant_action: invariantResult.action,
        controlled_status: controlledStatus,
        response_preview: null,
      },
    });

    return {
      case: updated ?? caseAfterDeterministicFallback ?? fresh,
      pending_confirmation: false,
      pendingConfirmation: null,
      response_preview: null,
    };
  }

  const agentResult = await runAgent({
    message: buildCaseE2ETickMessage(caseWithTarget, {
      ownerResponseText: options?.ownerResponseText,
    }),
    userId,
    sessionId: session.id,
    systemPrompt: profile.agent_system_prompt,
    db,
    enabledTools: toolSettings,
    enabledSkills: skillSettings,
    integrations,
    githubToken,
    userTimezone: profile.timezone,
    userName: profile.name,
    userEmail: profile.email,
    userPhone: profile.phone,
    businessBrain: profile.business_brain ?? {},
    isUnggaAdmin: profile.is_ungga_admin ?? false,
    channel: "case_runner",
    googleCalendarAccessToken,
    autoApproveTools: false,
    toolApprovalPolicy:
      settingsTestCase || controlledE2ECase || Boolean(pendingPublicationAction)
      ? buildSettingsTestToolApprovalPolicy(undefined, {
          documentRequestTarget: explicitDocumentRequestTarget,
          autoExecuteContractDraftGeneration:
            shouldAutoExecuteContractDraftGeneration(caseWithTarget),
          autoExecuteApprovedPublishTools:
            Boolean(pendingPublicationAction) ||
            shouldAutoExecuteApprovedPublishTools(caseWithTarget),
        })
      : undefined,
    caseId: caseWithTarget.id,
    toolCallSource: "agent_e2e",
  });

  const afterAgent = await getOperationalCase(db, fresh.id);
  const invariantResult = await applyPropertyOptioningPostAgentInvariants({
    db,
    opCase: afterAgent,
    source: "post_agent_invariant_e2e",
  });
  const caseAfterDeterministicFallback = invariantResult.case ?? afterAgent;
  let caseForFinalUpdate = caseAfterDeterministicFallback;
  const turnToolCalls = await listTurnToolCalls(db, agentResult.turnId);
  const hasRenderedContractDraft = hasRenderedContractDraftFromToolCalls(turnToolCalls);
  const missingContractFields = missingContractFieldsFromToolCalls(turnToolCalls);
  const missingListingIngredients =
    missingListingDescriptionIngredientsFromToolCalls(turnToolCalls);
  const draftedListingThisTurn = hasListingDescriptionDraftFromToolCalls(turnToolCalls);
  const uploadedEasybrokerImagesThisTurn =
    hasEasybrokerUploadFromToolCalls(turnToolCalls);
  const easybrokerUploadFailure =
    hasEasybrokerUploadFailureFromToolCalls(turnToolCalls);
  const contractDraft = parseContractDraftFromContext(
    caseAfterDeterministicFallback?.context_jsonb ?? null
  );
  const hasContractDraftOutputPath = Boolean(contractDraft?.output_path?.trim());
  const listingDraftContent = listingDescriptionDraftContentFromContext(
    caseAfterDeterministicFallback?.context_jsonb ?? null
  );
  let responsePreviewForEvent: string | null =
    agentResult.response?.slice(0, 500) ?? null;
  if (
    caseAfterDeterministicFallback?.current_step === "contract_pending" &&
    missingContractFields.length === 0 &&
    !hasContractDraftOutputPath &&
    !hasRenderedContractDraft
  ) {
    responsePreviewForEvent = null;
    const failure = classifyContractGenerationFailureFromToolCalls(turnToolCalls);
    await insertOperationalCaseEvent(db, {
      caseId: fresh.id,
      eventType: "state_changed",
      actor: "system",
      stepKey: "contract_pending",
      payload: {
        kind: "contract_generation_unverified",
        source: options?.source ?? "settings_test_case_tick",
        reason: "missing_generate_document_render",
        failure_kind: failure.kind,
        ...(failure.detail ? { failure_detail: failure.detail } : {}),
      },
    });
    if (!agentResult.pendingConfirmation) {
      const notifyPayload = contractGenerationFailureNotify({
        failure,
        caseId: fresh.id,
      });
      await notify(
        db,
        userId,
        {
          text: notifyPayload.text,
          kind: notifyPayload.kind,
          data: {
            case_id: fresh.id,
            source: options?.source ?? "settings_test_case_tick",
            failure_kind: failure.kind,
          },
        },
        "high"
      );
    }
  }
  if (
    caseAfterDeterministicFallback?.current_step === "contract_pending" &&
    missingContractFields.length > 0 &&
    !agentResult.pendingConfirmation
  ) {
    responsePreviewForEvent = null;
    const hasDraft =
      contractDraftOutputPathFromContext(
        caseAfterDeterministicFallback.context_jsonb
      ) != null;
    if (!hasDraft) {
      await dismissPrematureContractReviewNotifications(db, userId, fresh.id);
    }
    const hasUnreadContractData = await hasUnreadContractDataNotification(
      db,
      userId,
      fresh.id
    );
    if (!hasUnreadContractData) {
      await dismissUnreadContractGenerationErrorNotifications(db, userId, fresh.id);
      await notify(
        db,
        userId,
        {
          text: buildContractDataReviewNotifyText(missingContractFields),
          kind: "contract_data_review",
          data: {
            case_id: fresh.id,
            missing_required_fields: missingContractFields,
            source: options?.source ?? "settings_test_case_tick",
          },
        },
        "high"
      );
      await insertOperationalCaseEvent(db, {
        caseId: fresh.id,
        eventType: "human_decision",
        actor: "system",
        stepKey: "contract_pending",
        payload: {
          kind: "contract_data_review_requested",
          source: options?.source ?? "settings_test_case_tick",
          missing_required_fields: missingContractFields,
        },
      });
    }
  }
  if (
    caseAfterDeterministicFallback?.current_step === "contract_pending" &&
    missingContractFields.length === 0 &&
    hasContractDraftOutputPath &&
    !agentResult.pendingConfirmation
  ) {
    const hasUnreadReview = await hasUnreadContractReviewNotification(
      db,
      userId,
      fresh.id
    );
    if (!hasUnreadReview) {
      const contractUrl = buildContractDraftDownloadUrl(fresh.id);
      await notify(
        db,
        userId,
        {
          text: `Borrador de contrato listo para revisión.\n\nDescargar borrador del contrato: ${contractUrl}\n\nResponde “mándalo al dueño” o “pedir cambios”, o usa los botones.`,
          kind: "contract_review",
          data: {
            case_id: fresh.id,
            contract_draft_ready: true,
            contract_draft_url: contractUrl,
          },
        },
        "normal"
      );
      await insertOperationalCaseEvent(db, {
        caseId: fresh.id,
        eventType: "human_decision",
        actor: "system",
        stepKey: "contract_pending",
        payload: {
          kind: "contract_review_requested",
          source: options?.source ?? "settings_test_case_tick",
          doc_url: contractUrl,
        },
      });
    }
  }
  if (
    caseAfterDeterministicFallback?.current_step === "photos_requested" &&
    !agentResult.pendingConfirmation
  ) {
    const hasUnreadPhotos = await hasUnreadPhotosUploadRequestedNotification(
      db,
      userId,
      fresh.id
    );
    if (!hasUnreadPhotos) {
      const photosContext = contextRecord(caseAfterDeterministicFallback);
      const photoCount = countRawPhotos(photosContext);
      const appUrl =
        process.env.NEXT_PUBLIC_APP_URL?.trim() ||
        process.env.APP_URL?.trim() ||
        null;
      const notifyText = formatPhotosUploadRequestNotifyText({
        propertyLabel: propertyLabelFromCaseContext(photosContext),
        caseId: fresh.id,
        appUrl,
      });
      await notify(
        db,
        userId,
        {
          text: notifyText,
          kind: PHOTOS_UPLOAD_REQUESTED_NOTIFICATION_KIND,
          data: {
            case_id: fresh.id,
            source: options?.source ?? "settings_test_case_tick",
            raw_photos_count: photoCount,
            minimum_required: RAW_PHOTOS_MIN_COUNT,
          },
        },
        "normal"
      );
      await insertOperationalCaseEvent(db, {
        caseId: fresh.id,
        eventType: "reminder_sent",
        actor: "system",
        stepKey: "photos_requested",
        payload: {
          purpose: "photos_upload_requested",
          source: options?.source ?? "settings_test_case_tick",
          raw_photos_count: photoCount,
          minimum_required: RAW_PHOTOS_MIN_COUNT,
          remediation: "owned_photos_upload_request",
        },
      });
      if (caseAfterDeterministicFallback.status !== "waiting_internal") {
        const waiting = await updateOperationalCase(
          db,
          caseAfterDeterministicFallback.id,
          caseAfterDeterministicFallback.version,
          {
            status: "waiting_internal",
            currentStep: "photos_requested",
            nextActionAt: null,
          }
        );
        if (waiting) {
          caseForFinalUpdate = waiting;
        }
      }
      responsePreviewForEvent = null;
    }
  }
  if (
    caseAfterDeterministicFallback?.current_step === "package_ready" &&
    !agentResult.pendingConfirmation
  ) {
    await dismissPhotosUploadRequestedNotifications({
      db,
      userId,
      caseId: fresh.id,
    }).catch((error) => {
      console.warn(
        "[settings-test-case-tick] dismiss photos_upload_requested failed:",
        error
      );
    });
    if (!listingDraftContent) {
      await dismissPrematureListingDescriptionReviewNotifications(db, userId, fresh.id);
    }
    if (missingListingIngredients.length > 0 && !listingDraftContent) {
      responsePreviewForEvent = null;
      await insertOperationalCaseEvent(db, {
        caseId: fresh.id,
        eventType: "state_changed",
        actor: "system",
        stepKey: "package_ready",
        payload: {
          kind: "package_ready_ingredients_missing",
          source: options?.source ?? "settings_test_case_tick",
          missing_ingredients: missingListingIngredients,
          remediation:
            "Ejecutar analyze_property_images(case_id) y/o lookup_property_surroundings(case_id) antes de prepare_listing_description_draft.",
        },
      });
    } else if (
      listingDraftContent &&
      draftedListingThisTurn &&
      !(
        caseAfterDeterministicFallback.context_jsonb &&
        typeof caseAfterDeterministicFallback.context_jsonb === "object" &&
        !Array.isArray(caseAfterDeterministicFallback.context_jsonb) &&
        Boolean(
          (caseAfterDeterministicFallback.context_jsonb as Record<string, unknown>)
            .listing_description_approved
        )
      )
    ) {
      const hasUnreadListingReview = await hasUnreadListingDescriptionReviewNotification(
        db,
        userId,
        fresh.id
      );
      if (!hasUnreadListingReview) {
        const contextRecord =
          caseAfterDeterministicFallback.context_jsonb &&
          typeof caseAfterDeterministicFallback.context_jsonb === "object" &&
          !Array.isArray(caseAfterDeterministicFallback.context_jsonb)
            ? (caseAfterDeterministicFallback.context_jsonb as Record<string, unknown>)
            : null;
        const draftRecord = contextRecord?.listing_description_draft;
        const notifyText =
          draftRecord &&
          typeof draftRecord === "object" &&
          !Array.isArray(draftRecord)
            ? formatListingDescriptionReviewNotifyText(
                draftRecord as Record<string, unknown>,
                {
                  currentContext: contextRecord,
                }
              )
            : `Borrador de descripción listo para revisión.\n\n${listingDraftContent.headline}\n\n${listingDraftContent.description}`;
        await notify(
          db,
          userId,
          {
            text: notifyText,
            kind: "listing_description_review",
            data: {
              case_id: fresh.id,
              artifact_key: "listing_description_draft",
              actions: ["approve", "request_changes"],
              source: options?.source ?? "settings_test_case_tick",
            },
          },
          "normal"
        );
        await insertOperationalCaseEvent(db, {
          caseId: fresh.id,
          eventType: "human_decision",
          actor: "system",
          stepKey: "package_ready",
          payload: {
            kind: "listing_description_review_requested",
            source: options?.source ?? "settings_test_case_tick",
          },
        });
      }
    } else if (
      caseAfterDeterministicFallback &&
      listingDescriptionReviewNeedsRegeneration(
        contextRecord(caseAfterDeterministicFallback)
      ) &&
      !draftedListingThisTurn
    ) {
      responsePreviewForEvent = null;
      await insertOperationalCaseEvent(db, {
        caseId: fresh.id,
        eventType: "state_changed",
        actor: "system",
        stepKey: "package_ready",
        payload: {
          kind: "listing_description_regeneration_skipped",
          source: options?.source ?? "settings_test_case_tick",
          remediation:
            "El tick no ejecutó prepare_listing_description_draft tras Pedir cambios. Reintentar con «Revisar avance».",
        },
      });
      const hasUnreadListingReview = await hasUnreadListingDescriptionReviewNotification(
        db,
        userId,
        fresh.id
      );
      if (!hasUnreadListingReview) {
        await notify(
          db,
          userId,
          {
            text:
              "No pude regenerar el borrador en este intento (faltó prepare_listing_description_draft). Pulsa «Revisar avance» para reintentar, o vuelve a usar «Pedir cambios».",
            kind: "case_update",
            data: {
              case_id: fresh.id,
              source: options?.source ?? "settings_test_case_tick",
              failure_kind: "listing_description_regeneration_skipped",
            },
          },
          "high"
        );
      }
    }

    const packageReadyCase =
      caseForFinalUpdate ?? caseAfterDeterministicFallback ?? fresh;
    const packageReadyContext = contextRecord(packageReadyCase);
    if (uploadedEasybrokerImagesThisTurn || easybrokerUploadFailure.failed) {
      const published = isRecord(packageReadyContext.published)
        ? packageReadyContext.published
        : {};
      const easybroker = isRecord(published.easybroker) ? published.easybroker : {};
      const patched = await updateOperationalCase(
        db,
        fresh.id,
        packageReadyCase.version ?? fresh.version,
        {
          context: {
            ...packageReadyContext,
            published: {
              ...published,
              easybroker: {
                ...easybroker,
                ...(uploadedEasybrokerImagesThisTurn
                  ? {
                      images_uploaded: true,
                      images_status: "submitted",
                      images_error: null,
                    }
                  : {
                      images_uploaded: false,
                      images_status: "failed",
                      images_error: easybrokerUploadFailure.error,
                    }),
              },
            },
          },
        }
      );
      if (patched) caseForFinalUpdate = patched;
    }

    const continueCase =
      caseForFinalUpdate ?? caseAfterDeterministicFallback ?? fresh;
    const contextForContinue = contextRecord(continueCase);
    if (
      shouldDeterministicallyRequestUnggaApproval({
        context: contextForContinue,
        pendingConfirmation: Boolean(agentResult.pendingConfirmation),
        uploadedImagesThisTurn: uploadedEasybrokerImagesThisTurn,
      })
    ) {
      const hasUnreadUngga = await hasUnreadUnggaPublishApprovalNotification(
        db,
        userId,
        fresh.id
      );
      if (!hasUnreadUngga) {
        const published = isRecord(contextForContinue.published)
          ? contextForContinue.published
          : {};
        const easybroker = isRecord(published.easybroker)
          ? published.easybroker
          : {};
        await notify(
          db,
          userId,
          {
            text: formatUnggaPublishApprovalNotifyText(),
            kind: "ungga_publish_approval",
            data: {
              case_id: fresh.id,
              destination: "ungga",
              actions: ["approve", "skip", "reject"],
              source: options?.source ?? "settings_test_case_tick",
              ...(typeof easybroker.listing_id === "string"
                ? { easybroker_listing_id: easybroker.listing_id }
                : {}),
            },
          },
          "high"
        );
        await insertOperationalCaseEvent(db, {
          caseId: fresh.id,
          eventType: "human_decision",
          actor: "system",
          stepKey: "package_ready",
          payload: {
            kind: "ungga_publish_approval_requested",
            source: options?.source ?? "settings_test_case_tick",
            remediation: "owned_publish_destination_approval",
          },
        });
        responsePreviewForEvent = null;
        if (continueCase.status !== "waiting_internal") {
          const waiting = await updateOperationalCase(
            db,
            fresh.id,
            continueCase.version ?? fresh.version,
            {
              status: "waiting_internal",
              currentStep: "package_ready",
              nextActionAt: null,
            }
          );
          if (waiting) caseForFinalUpdate = waiting;
        }
      }
    }
  }
  const version = caseForFinalUpdate?.version ?? fresh.version;
  const controlledStatus = deriveControlledE2EStatus(
    invariantResult.action,
    Boolean(agentResult.pendingConfirmation)
  );
  const contextBeforeFinal = contextRecord(caseForFinalUpdate ?? fresh);
  const schedulePackageReadyFollowUp =
    (settingsTestCase || controlledE2ECase) &&
    (caseForFinalUpdate ?? caseAfterDeterministicFallback ?? fresh)
      .current_step === "package_ready" &&
    shouldAutoFollowUpPackageReadyTick({
      context: contextBeforeFinal,
      pendingConfirmation: Boolean(agentResult.pendingConfirmation),
      uploadedImagesThisTurn: uploadedEasybrokerImagesThisTurn,
      uploadFailedThisTurn: easybrokerUploadFailure.failed,
      autoFollowUpDepth: options?.autoFollowUpDepth ?? 0,
    });

  const updated = await updateOperationalCase(db, fresh.id, version, {
    nextActionAt: controlledE2ECase ? null : undefined,
    context: {
      ...(caseForFinalUpdate?.context_jsonb ?? fresh.context_jsonb),
      ...(settingsTestCase
        ? {
            test_mode: true,
            controlled_test_e2e_last_run_at: new Date().toISOString(),
            controlled_test_e2e_pending_confirmation: Boolean(
              agentResult.pendingConfirmation
            ),
            controlled_test_status: agentResult.pendingConfirmation
              ? "e2e_pending_hitl"
              : schedulePackageReadyFollowUp
                ? "e2e_auto_follow_up_scheduled"
                : "e2e_tick_completed",
          }
        : {}),
      ...(controlledE2ECase
        ? {
            e2e_control_last_run_at: new Date().toISOString(),
            e2e_control_pending_confirmation: Boolean(
              agentResult.pendingConfirmation
            ),
            e2e_control_status: schedulePackageReadyFollowUp
              ? "auto_follow_up_scheduled"
              : controlledStatus,
            e2e_control_last_invariant_action: invariantResult.action,
          }
        : {}),
    },
  });

  await insertOperationalCaseEvent(db, {
    caseId: fresh.id,
    eventType: "state_changed",
    actor: "system",
    stepKey: (updated ?? caseForFinalUpdate ?? fresh).current_step ?? undefined,
    payload: {
      source: options?.source ?? "settings_test_case_tick",
      result: agentResult.pendingConfirmation
        ? "e2e_pending_hitl"
        : schedulePackageReadyFollowUp
          ? "e2e_auto_follow_up_scheduled"
          : "e2e_tick_completed",
      pending_confirmation: Boolean(agentResult.pendingConfirmation),
      invariant_action: invariantResult.action,
      controlled_status: schedulePackageReadyFollowUp
        ? "auto_follow_up_scheduled"
        : controlledStatus,
      response_preview: responsePreviewForEvent,
      ...(schedulePackageReadyFollowUp
        ? {
            auto_follow_up_depth: (options?.autoFollowUpDepth ?? 0) + 1,
            auto_follow_up_reason: "package_ready_easybroker_images",
          }
        : {}),
    },
  });

  if (schedulePackageReadyFollowUp && updated) {
    // Serialized follow-up via publication runner (no skipLock recursion).
    const { requestPublicationProgress } = await import(
      "@/lib/operational-cases/publication-runner"
    );
    void requestPublicationProgress(
      db,
      updated.id,
      "package_ready_auto_follow_up",
      {
        runAgentTick: async (opCase, action) => {
          const tick = await runSettingsTestCaseAgentTick(db, opCase, userId, {
            source: `package_ready_auto_follow_up:${action.type}`,
            autoFollowUpDepth: (options?.autoFollowUpDepth ?? 0) + 1,
          });
          return (
            tick.publication_execution ?? {
              status: "not_executed",
              error: "publication_execution_result_missing",
            }
          );
        },
      }
    ).catch((error) => {
      console.warn(
        "[settings-test-case-tick] package_ready auto follow-up failed:",
        error
      );
    });
  }

  return {
    case: updated ?? caseForFinalUpdate ?? fresh,
    pending_confirmation: Boolean(agentResult.pendingConfirmation),
    pendingConfirmation: agentResult.pendingConfirmation ?? null,
    response_preview: agentResult.response?.slice(0, 800) ?? null,
    ...(pendingPublicationAction
      ? {
          publication_execution: classifyPublicationExecutionFromToolCalls(
            pendingPublicationAction,
            turnToolCalls
          ),
        }
      : {}),
  };
}
