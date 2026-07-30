import {
  buildContractCommercialMinimumsSummaryMessage,
  buildContractDataReviewNotifyText,
  buildListingDescriptionDraftTxtAttachment,
  contractDraftOutputPathFromContext,
  evaluateContractCommercialMinimums,
  evaluatePropertyAdvanceGate,
  formatListingDescriptionReviewNotifyText,
  listingDescriptionDraftContentFromContext,
  listingDescriptionReviewExcerptTruncated,
  renderCommissionContractForCase,
  runAgent,
  runDocumentFieldExtraction,
  type ToolContext,
} from "@agents/agent";
import {
  createToolCall,
  createServerClient,
  decryptToken,
  getGoogleCalendarAccessToken,
  getOperationalCase,
  getProfile,
  getRecentOperationalCaseEvents,
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
  isNestedPublicationRunnerTick,
  shouldAutoFollowUpPackageReadyTick,
  shouldDeterministicallyRequestUnggaApproval,
} from "@/lib/operational-cases/package-ready-auto-continue";
import {
  buildPublicationAgentHint,
  requestPublicationProgress,
  type PublicationExecutionResult,
} from "@/lib/operational-cases/publication-runner";
import { unggaMediaCountSatisfied } from "@/lib/operational-cases/publication-remote-snapshot";
import type { PublicationMachineAction } from "@/lib/operational-cases/publication-workflow";
import {
  buildContractDraftDownloadUrl,
  parseContractDraftFromContext,
  parseGenerateDocumentRenderResult,
} from "@/lib/operational-cases/contract-draft-document";
import {
  buildPublicationAwareE2EToolApprovalPolicy,
  listingDescriptionIsApproved,
  shouldAutoExecuteApprovedPublishToolsFromContext,
} from "@/lib/operational-cases/publication-tool-policy";
import { applyPropertyOptioningPostAgentInvariants } from "@/lib/operational-cases/property-optioning-post-agent-invariants";
import { createAdvisedCaseUpdate } from "@/lib/operational-cases/advised-case-update";
import {
  countRawPhotos,
  dismissPhotosUploadRequestedNotifications,
  formatPhotosUploadRequestNotifyText,
  PHOTOS_UPLOAD_REQUESTED_NOTIFICATION_KIND,
  RAW_PHOTOS_MIN_COUNT,
} from "@/lib/operational-cases/photo-batch-completion";
import { resolvePropertyDisplayLabel } from "@/lib/operational-cases/property-display-label";

// Paridad lab/producción (S1.6): el tick es compartido por cron, webhook y
// laboratorio; sus transiciones de paso/estado pasan por el mismo evaluador.
const advisedTickCaseUpdate = createAdvisedCaseUpdate("agent_tick", "runtime");
import { telegramChatIdFromCase } from "@/lib/operational-cases/settings-test-telegram-lab";

type PostAgentInvariantAction = Awaited<
  ReturnType<typeof applyPropertyOptioningPostAgentInvariants>
>["action"];

export type TurnToolCallRow = {
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
  // Playwright action timeouts (e.g. click on disabled PUBLICAR) are known
  // failures, not process kill / unknown external outcomes.
  const knownPlaywrightActionFailure =
    /element is not enabled|ungga_publish_button_disabled|gestiona desde tu portal o crm|open_modal_guid_mismatch/i.test(
      error
    ) ||
    (/locator\.(click|fill|check)/i.test(error) &&
      /timeout \d+ms exceeded/i.test(error));
  const unknown =
    result.status === "unknown_outcome" ||
    (!knownPlaywrightActionFailure &&
      /\b(timeout|timed out|killed|kill signal|sigterm|sigkill|aborted|econnreset|socket hang up)\b/i.test(
        error
      ));
  if (
    call.status === "failed" ||
    result.ok === false ||
    ["failed", "not_configured", "validation_error", "unknown_outcome"].includes(
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
    if (action.destination === "ungga") {
      const expected =
        typeof result.expected_image_count === "number"
          ? result.expected_image_count
          : null;
      const uploaded =
        typeof result.uploaded_image_count === "number"
          ? result.uploaded_image_count
          : typeof result.image_count === "number"
            ? result.image_count
            : null;
      if (
        typeof expected === "number" &&
        expected > 0 &&
        result.images_verified !== true &&
        !unggaMediaCountSatisfied(uploaded, expected)
      ) {
        return {
          status: "failed",
          result,
          error: `ungga_media_incomplete:expected_${expected}_got_${uploaded ?? 0}`,
        };
      }
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

export function shouldAutoExecuteApprovedPublishToolsForTest(
  opCase: OperationalCase
): boolean {
  return shouldAutoExecuteApprovedPublishToolsFromContext(contextRecord(opCase), {
    caseType: opCase.case_type,
    currentStep: opCase.current_step,
  });
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

/** Prefer structured missing_fields from tool results; fall back to commercial evaluator. */
export function resolveContractDataReviewCommercialState(params: {
  toolCalls: TurnToolCallRow[];
  context?: Record<string, unknown> | null;
}): ReturnType<typeof evaluateContractCommercialMinimums> {
  const context = params.context ?? {};
  const propertyData = isRecord(context.property_data) ? context.property_data : {};
  const externalContact = isRecord(context.external_contact)
    ? context.external_contact
    : {};

  for (const call of params.toolCalls) {
    if (call.tool_name !== "generate_document_from_template") continue;
    const result = call.result_json ?? {};
    if (result.error !== "commission_contract_missing_required_data") continue;
    if (
      Array.isArray(result.missing_fields) &&
      result.missing_fields.length > 0 &&
      typeof result.commercial_summary === "string" &&
      result.commercial_summary.trim()
    ) {
      const evaluated = evaluateContractCommercialMinimums({
        context,
        propertyData,
        externalContact,
        requireConfirmation: false,
      });
      // Prefer live evaluator (source of truth) even when tool already returned summary.
      return evaluated;
    }
  }

  return evaluateContractCommercialMinimums({
    context,
    propertyData,
    externalContact,
    requireConfirmation: false,
  });
}

export type ContractGenerationFailureKind =
  | "not_attempted"
  | "template_missing"
  | "titularidad_review_required"
  | "owner_corroboration_incomplete"
  | "pending_confirmation"
  | "infrastructure_error"
  | "unknown";

function summarizeContractGenerationError(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (/502\s*bad\s*gateway|cloudflare/i.test(raw)) {
    return "error temporal del almacenamiento (502). Reintenta en unos segundos";
  }
  if (/503\s*service\s*unavailable|504\s*gateway/i.test(raw)) {
    return "servicio de almacenamiento temporalmente no disponible. Reintenta en unos segundos";
  }
  // Avoid dumping HTML bodies into Telegram/web notices.
  if (/<html[\s>]/i.test(raw) || raw.length > 180) {
    return "error temporal de infraestructura al renderizar el DOCX";
  }
  return raw;
}

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

  // Prefer terminal outcomes over orphan pending rows. Auto-execute creates a
  // pending_confirmation audit row first; if render throws before status update,
  // a later failed sibling can leave a stale pending that must not look like HITL.
  const terminalCalls = generateCalls.filter((call) =>
    ["executed", "failed", "rejected", "approved"].includes(call.status)
  );
  const failedCalls = generateCalls.filter((call) => call.status === "failed");
  const stillPending =
    generateCalls.some((call) => call.status === "pending_confirmation") &&
    failedCalls.length === 0 &&
    !generateCalls.some((call) => call.status === "executed");

  if (stillPending) {
    return { kind: "pending_confirmation" };
  }

  for (const call of failedCalls.length > 0 ? failedCalls : terminalCalls) {
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
    if (/502|503|504|cloudflare|bad gateway|storage|gateway/i.test(error)) {
      return {
        kind: "infrastructure_error",
        detail: summarizeContractGenerationError(error),
      };
    }
  }

  const lastFailed = failedCalls[failedCalls.length - 1];
  const last = lastFailed ?? generateCalls[generateCalls.length - 1];
  const lastError =
    typeof last?.result_json?.error === "string"
      ? last.result_json.error
      : typeof last?.result_json?.status === "string"
        ? last.result_json.status
        : undefined;
  return {
    kind: "unknown",
    detail: summarizeContractGenerationError(lastError),
  };
}

export function contractGenerationFailureNotify(params: {
  failure: { kind: ContractGenerationFailureKind; detail?: string };
  caseId: string;
}): { kind: string; text: string } {
  // Copy dirigido al asesor (Telegram/web chat). NO menciona «Revisar avance»
  // (control interno de laboratorio). Los fallos recuperables indican reintento
  // automático; los que requieren acción humana la piden en lenguaje de producto.
  switch (params.failure.kind) {
    case "template_missing":
      return {
        kind: "contract_template_missing",
        text:
          "No pude generar el borrador del contrato: falta la plantilla DOCX de contrato de comisión en la cuenta. Súbela en Preparación operativa y el borrador se generará en cuanto esté disponible.",
      };
    case "titularidad_review_required":
      return {
        kind: "titularidad_review",
        text:
          "No pude generar el contrato porque la titularidad aún no está verificada (hay un desajuste entre los documentos). Confirma si avanzamos de todos modos o corrige la identificación/comprobante para continuar.",
      };
    case "owner_corroboration_incomplete":
      return {
        kind: "case_update",
        text:
          "Estoy terminando de verificar la identificación/comprobante del propietario para armar el contrato. Lo reintento automáticamente en cuanto quede lista.",
      };
    case "pending_confirmation":
      return {
        kind: "case_update",
        text:
          "La generación del contrato quedó pendiente de tu aprobación. Apruébala en Pendientes para continuar.",
      };
    case "infrastructure_error":
      return {
        kind: "case_update",
        text: params.failure.detail
          ? `No pude generar el borrador del contrato (${params.failure.detail}). Lo reintento automáticamente en unos minutos.`
          : "No pude generar el borrador del contrato por un error temporal. Lo reintento automáticamente en unos minutos.",
      };
    case "not_attempted":
      return {
        kind: "case_update",
        text:
          "Estoy preparando el borrador del contrato de comisión. Te aviso en cuanto esté listo para tu revisión.",
      };
    default:
      return {
        kind: "case_update",
        text:
          "No pude generar el borrador del contrato por un error temporal. Lo reintento automáticamente en unos minutos.",
      };
  }
}

export function isPriceApprovedForContract(context: Record<string, unknown>): boolean {
  const pricing = isRecord(context.pricing_proposal)
    ? context.pricing_proposal
    : null;
  return pricing?.approval_status === "approved";
}

/** Ensure `contract_review` notify + event exist once a real draft is stored. */
async function ensureContractReviewNotification(
  db: ReturnType<typeof createServerClient>,
  userId: string,
  caseId: string,
  source: string
): Promise<void> {
  const hasUnreadReview = await hasUnreadContractReviewNotification(
    db,
    userId,
    caseId
  );
  if (hasUnreadReview) return;
  const contractUrl = buildContractDraftDownloadUrl(caseId);
  await notify(
    db,
    userId,
    {
      text: `Borrador de contrato listo para revisión.\n\nDescargar borrador del contrato: ${contractUrl}\n\nResponde “mándalo al dueño” o “pedir cambios”, o usa los botones.`,
      kind: "contract_review",
      data: {
        case_id: caseId,
        contract_draft_ready: true,
        contract_draft_url: contractUrl,
      },
    },
    "normal"
  );
  await insertOperationalCaseEvent(db, {
    caseId,
    eventType: "human_decision",
    actor: "system",
    stepKey: "contract_pending",
    payload: {
      kind: "contract_review_requested",
      source,
      doc_url: contractUrl,
    },
  });
}

/** Ensure `contract_data_review` notify + event exist when commercial data is missing. */
async function ensureContractDataReviewNotification(params: {
  db: ReturnType<typeof createServerClient>;
  userId: string;
  caseId: string;
  source: string;
  toolCalls: TurnToolCallRow[];
  context: Record<string, unknown>;
  missingContractFields: string[];
}): Promise<void> {
  const { db, userId, caseId, source } = params;
  const hasDraft = contractDraftOutputPathFromContext(params.context) != null;
  if (!hasDraft) {
    await dismissPrematureContractReviewNotifications(db, userId, caseId);
  }
  const hasUnreadContractData = await hasUnreadContractDataNotification(
    db,
    userId,
    caseId
  );
  if (hasUnreadContractData) return;
  await dismissUnreadContractGenerationErrorNotifications(db, userId, caseId);
  const commercial = resolveContractDataReviewCommercialState({
    toolCalls: params.toolCalls,
    context: params.context,
  });
  const requiredMissing = commercial.missing.filter(
    (item) => item.optional !== true
  );
  const missingKeys =
    requiredMissing.length > 0
      ? requiredMissing.map((item) => item.key)
      : params.missingContractFields;
  const notifyText =
    requiredMissing.length > 0 || commercial.known.length > 0
      ? buildContractCommercialMinimumsSummaryMessage(commercial)
      : buildContractDataReviewNotifyText(missingKeys);
  await notify(
    db,
    userId,
    {
      text: notifyText,
      kind: "contract_data_review",
      data: {
        case_id: caseId,
        missing_required_fields: missingKeys,
        missing_fields: commercial.missing,
        known_fields: commercial.known,
        source,
      },
    },
    "high"
  );
  await insertOperationalCaseEvent(db, {
    caseId,
    eventType: "human_decision",
    actor: "system",
    stepKey: "contract_pending",
    payload: {
      kind: "contract_data_review_requested",
      source,
      missing_required_fields: missingKeys,
    },
  });
}

/** Emit the observability event + advisor notice for a contract generation failure. */
async function emitContractGenerationFailure(params: {
  db: ReturnType<typeof createServerClient>;
  userId: string;
  caseId: string;
  source: string;
  failure: { kind: ContractGenerationFailureKind; detail?: string };
}): Promise<void> {
  const { db, userId, caseId, source, failure } = params;
  await insertOperationalCaseEvent(db, {
    caseId,
    eventType: "state_changed",
    actor: "system",
    stepKey: "contract_pending",
    payload: {
      kind: "contract_generation_unverified",
      source,
      reason: "missing_generate_document_render",
      failure_kind: failure.kind,
      ...(failure.detail ? { failure_detail: failure.detail } : {}),
    },
  });
  const notifyPayload = contractGenerationFailureNotify({ failure, caseId });
  await notify(
    db,
    userId,
    {
      text: notifyPayload.text,
      kind: notifyPayload.kind,
      data: { case_id: caseId, source, failure_kind: failure.kind },
    },
    "high"
  );
}

/**
 * Manejo determinista compartido del paso de contrato tras un turno del agente
 * (cron y tick E2E usan EXACTAMENTE esta función). Garantiza paridad
 * laboratorio/producción: si ya hay borrador asegura `contract_review`; si
 * faltan datos comerciales asegura `contract_data_review`; y si el agente no
 * generó el DOCX pese a tener precio aprobado + datos completos, renderiza el
 * contrato de forma determinista (PATTERN_DETERMINISTIC_AUTO_REMEDIATION).
 *
 * Devuelve `humanWait=true` cuando el resultado deja el caso esperando una
 * acción/decisión humana (el cron NO debe re-armar next_action_at en ese caso).
 */
export async function applyPostAgentContractHandling(params: {
  db: ReturnType<typeof createServerClient>;
  userId: string;
  opCase: OperationalCase;
  toolCalls: TurnToolCallRow[];
  pendingConfirmation: boolean;
  source: string;
  toolContext: {
    sessionId: string;
    enabledTools: Awaited<ReturnType<typeof getUserToolSettings>>;
    integrations: Awaited<ReturnType<typeof getUserIntegrations>>;
    userTimezone?: string;
  };
}): Promise<{ handled: boolean; humanWait: boolean }> {
  const { db, userId, source, opCase } = params;
  if (!opCase || opCase.current_step !== "contract_pending") {
    return { handled: false, humanWait: false };
  }
  // Un HITL pendiente del agente es dueño del turno; no interferimos.
  if (params.pendingConfirmation) {
    return { handled: false, humanWait: false };
  }

  const caseId = opCase.id;
  const context = contextRecord(opCase);
  const missingContractFields = missingContractFieldsFromToolCalls(
    params.toolCalls
  );

  // 1) Ya existe borrador real → asegurar revisión de contrato.
  if (contractDraftOutputPathFromContext(opCase.context_jsonb) != null) {
    await ensureContractReviewNotification(db, userId, caseId, source);
    return { handled: true, humanWait: true };
  }

  // 2) Faltan datos comerciales (por tool call o por el evaluador en vivo) →
  //    asegurar contract_data_review. Cubre también el caso en que el agente
  //    nunca llamó la tool pero los datos aún están incompletos.
  const propertyData = isRecord(context.property_data)
    ? (context.property_data as Record<string, unknown>)
    : {};
  const externalContact = isRecord(opCase.external_contact_jsonb)
    ? (opCase.external_contact_jsonb as Record<string, unknown>)
    : {};
  const liveCommercial = evaluateContractCommercialMinimums({
    context,
    propertyData,
    externalContact,
    requireConfirmation: true,
  });
  const liveRequiredMissing = liveCommercial.missing.filter(
    (item) => item.optional !== true
  );
  if (missingContractFields.length > 0 || liveRequiredMissing.length > 0) {
    await ensureContractDataReviewNotification({
      db,
      userId,
      caseId,
      source,
      toolCalls: params.toolCalls,
      context,
      missingContractFields,
    });
    return { handled: true, humanWait: true };
  }

  // 3) Precio no aprobado → no es nuestro trabajo generar; lo dueña el flujo.
  if (!isPriceApprovedForContract(context)) {
    return { handled: false, humanWait: false };
  }

  // 4) Trabajo mecánico → código: render determinista del contrato.
  ensureAgentToolDepsWired();
  const ctx: ToolContext = {
    db,
    userId,
    sessionId: params.toolContext.sessionId,
    channel: "case_runner",
    enabledTools: params.toolContext.enabledTools,
    integrations: params.toolContext.integrations,
    userTimezone: params.toolContext.userTimezone,
  };
  const result = await renderCommissionContractForCase(ctx, { caseId });

  switch (result.kind) {
    case "rendered":
      await ensureContractReviewNotification(db, userId, caseId, source);
      return { handled: true, humanWait: true };
    case "missing_required_data": {
      const refreshed = (await getOperationalCase(db, caseId)) ?? opCase;
      await ensureContractDataReviewNotification({
        db,
        userId,
        caseId,
        source,
        toolCalls: params.toolCalls,
        context: contextRecord(refreshed),
        missingContractFields: result.missingRequiredFields,
      });
      return { handled: true, humanWait: true };
    }
    case "titularidad_review_required":
      await emitContractGenerationFailure({
        db,
        userId,
        caseId,
        source,
        failure: { kind: "titularidad_review_required", detail: result.detail },
      });
      return { handled: true, humanWait: true };
    case "template_missing":
      await emitContractGenerationFailure({
        db,
        userId,
        caseId,
        source,
        failure: { kind: "template_missing", detail: result.hint },
      });
      return { handled: true, humanWait: true };
    case "owner_corroboration_incomplete":
      await emitContractGenerationFailure({
        db,
        userId,
        caseId,
        source,
        failure: { kind: "owner_corroboration_incomplete" },
      });
      // Recuperable de forma automática: el cron puede reintentar.
      return { handled: true, humanWait: false };
    case "infrastructure_error":
    case "failed":
    default:
      await emitContractGenerationFailure({
        db,
        userId,
        caseId,
        source,
        failure: { kind: "infrastructure_error" },
      });
      return { handled: true, humanWait: false };
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

async function hasListingDescriptionReviewRequestedEventForCurrentDraft(
  db: ReturnType<typeof createServerClient>,
  caseId: string,
  context: Record<string, unknown>
) {
  const draft = isRecord(context.listing_description_draft)
    ? context.listing_description_draft
    : {};
  const draftGeneratedAt =
    typeof draft.generated_at === "string"
      ? Date.parse(draft.generated_at)
      : Number.NaN;
  const events = await getRecentOperationalCaseEvents(db, caseId, 30);
  return events.some((event) => {
    const payload = isRecord(event.payload_jsonb) ? event.payload_jsonb : {};
    if (payload.kind !== "listing_description_review_requested") return false;
    if (!Number.isFinite(draftGeneratedAt)) return true;
    return Date.parse(event.created_at) >= draftGeneratedAt;
  });
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
  const label = resolvePropertyDisplayLabel(context, { fallback: "" });
  return label.trim() ? label : null;
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
  const forceInstruction = options?.ownerResponseText?.trim() ?? "";
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
            : "Acción esperada para este paso: NO contactes al dueño por Telegram. Usa notify_user(kind=documents_upload_requested) para pedir al asesor interno que suba documentos aquí en el chat y confirme con “listo” (o Terminé de subir) cuando termine.",
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
            "Omite asset_key y data si no los necesitas; no envíes strings vacíos ni data={}.",
            "Si devuelve titularidad_review_required, notify_user(kind=titularidad_review) y detente en waiting_internal.",
            "Si devuelve owner_corroboration_extraction_incomplete, extrae esos documentos con operational_case_extract_document_fields(force=true) y reintenta una vez.",
            "Si devuelve not_configured / plantilla faltante, notify_user explicando que falta commission_contract_template y deja status=paused.",
            "Si devuelve commission_contract_missing_required_data, la tool ya emitió contract_data_review como remediación owned: NO llames notify_user otra vez; termina el turno en waiting_internal.",
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
              ? `Ya hay ${photoCount} foto(s) en raw_photos. Aun así envía notify_user(kind=photos_upload_requested) recordando el mínimo de ${RAW_PHOTOS_MIN_COUNT} y que responda exactamente **«listo»** (con negrita markdown) para avanzar; no avances a package_ready en este tick.`
              : `Hay ${photoCount} foto(s) en raw_photos. Envía notify_user(kind=photos_upload_requested) pidiendo al menos ${RAW_PHOTOS_MIN_COUNT} fotos${propertyLabel ? ` de ${propertyLabel}` : ""} aquí (fachada, sala/comedor, cocina, recámara principal, baño principal) e indica que responda exactamente **«listo»** (con negrita markdown) al terminar. No menciones panel ni «Referencia del caso».`,
            "Inserta operational_case_add_event(reminder_sent, purpose=photos_upload_requested).",
            "Deja current_step=photos_requested y status=waiting_internal. NO avances a package_ready sin **«listo»** del asesor.",
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
            const easybrokerDraftCreated = Boolean(
              published.easybroker &&
                typeof published.easybroker === "object" &&
                !Array.isArray(published.easybroker) &&
                (typeof (published.easybroker as Record<string, unknown>).listing_id ===
                  "string" ||
                  (published.easybroker as Record<string, unknown>).ok === true)
            );
            const publicationState =
              context.publication &&
              typeof context.publication === "object" &&
              !Array.isArray(context.publication)
                ? (context.publication as Record<string, unknown>)
                : null;
            const easybrokerDest =
              publicationState &&
              typeof publicationState.destinations === "object" &&
              publicationState.destinations &&
              !Array.isArray(publicationState.destinations) &&
              typeof (publicationState.destinations as Record<string, unknown>)
                .easybroker === "object"
                ? ((publicationState.destinations as Record<string, unknown>)
                    .easybroker as Record<string, unknown>)
                : null;
            const easybrokerPubliclyPublished =
              easybrokerDest?.phase === "published" ||
              (published.easybroker &&
                typeof published.easybroker === "object" &&
                !Array.isArray(published.easybroker) &&
                ((published.easybroker as Record<string, unknown>).status ===
                  "published" ||
                  (published.easybroker as Record<string, unknown>)
                    .remote_status === "published"));
            const easybrokerDecision =
              typeof publishApprovals.easybroker === "string"
                ? publishApprovals.easybroker
                : null;
            const unggaDecision =
              typeof publishApprovals.ungga === "string"
                ? publishApprovals.ungga
                : null;
            const easybrokerResolvedForNextDestination =
              Boolean(easybrokerPubliclyPublished) ||
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
                  ? "Si EasyBroker aún no tiene decisión, envía notify_user(kind=easybroker_publish_approval) con botones Publicar en EasyBroker / Omitir EasyBroker / Pausar publicación; no publiques todavía."
                  : easybrokerDecision === "approved" && !easybrokerDraftCreated
                    ? "publish_approvals.easybroker=approved y aún NO hay context.published.easybroker: en este tick DEBES llamar easybroker_create_listing(case_id) con title/description/operation/property_type/price/street/location. NO inventes custom_fields, legal_address, area_construida_m2, features libres, lot_width/lot_length=0, internal_id=UUID del caso, placeholders N/D ni latitude/longitude=0; el adapter enriquece desde el caso y allowlista el payload EasyBroker. NO pidas Ungga todavía."
                    : easybrokerDecision === "approved" &&
                        easybrokerDraftCreated &&
                        !easybrokerPubliclyPublished
                      ? "EasyBroker ya tiene listing (borrador). No lo vuelvas a crear. Si faltan fotos, image_watermark (solo si hay logo de marca) + easybroker_upload_images. No publiques ni pidas Ungga hasta que el runner indique publish y EasyBroker esté publicado remotamente."
                      : easybrokerDecision === "approved" &&
                          easybrokerPubliclyPublished
                        ? "EasyBroker ya está publicado remotamente. Si Ungga no tiene decisión, envía notify_user(kind=ungga_publish_approval)."
                        : "EasyBroker está skipped/rejected; no lo publiques.",
              !runnerHint &&
              easybrokerResolvedForNextDestination &&
              (!unggaDecision || unggaDecision === "pending")
                ? "Solo ahora (EasyBroker ya publicado remotamente, skipped o rejected): si Ungga aún no tiene decisión y ya subiste fotos (o no hay fotos), envía notify_user(kind=ungga_publish_approval)."
                : !runnerHint && unggaDecision === "approved"
                  ? "PUBLICATION: publish_approvals.ungga=approved. Si aún no hay ungga_property_id, llama ungga_publish_listing({ action: \"prepare_draft\", case_id }) UNA vez — SOLO action+case_id (sin image_urls). NO uses publish_draft hasta tener GU-ID y preflight pass. Si el runner indica publish, usa action=publish_draft con ungga_property_id del contexto."
                  : !runnerHint
                    ? "NO solicites Ungga hasta que EasyBroker esté publicado remotamente (phase=published) o quede skipped/rejected."
                    : "",
              "Publica solo destinos con publish_approvals.<destino>=approved. Si un destino está skipped/rejected, no lo publiques.",
              runnerHint
                ? "Ejecuta SOLO la acción pendiente del publication runner; no llames tools de otras fases; el runner encadena el siguiente paso. No pidas Ungga en este tick salvo que el hint lo indique."
                : easybrokerResolvedForNextDestination
                  ? "Si no hay decisión humana pendiente, continúa el trabajo de máquina; puedes pedir Ungga solo porque EasyBroker ya está publicado/skipped/rejected."
                  : "Si no hay decisión humana pendiente, continúa el trabajo de máquina del paso actual (create o upload EasyBroker); no publiques ni pidas Ungga todavía.",
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
    forceInstruction,
  ]
    .filter(Boolean)
    .join(" ");
}

export type SettingsTestCaseTickResult = {
  case: OperationalCase;
  pending_confirmation: boolean;
  pendingConfirmation: PendingConfirmation | null;
  response_preview: string | null;
  publication_execution?: PublicationExecutionResult;
};

export type SettingsTestCaseTickOptions = {
  source?: string;
  skipLock?: boolean;
  ownerResponseText?: string;
  autoFollowUpDepth?: number;
  publicationRunnerOwned?: boolean;
};

/**
 * Builds the runAgentTick callback used by requestPublicationProgress.
 * Always sets publicationRunnerOwned so nested ticks preserve the runner lease
 * and never schedule a second fire-and-forget runner.
 */
export function createPublicationRunnerOwnedAgentTick(
  db: ReturnType<typeof createServerClient>,
  userId: string,
  sourcePrefix: string,
  options?: Omit<
    SettingsTestCaseTickOptions,
    "source" | "skipLock" | "publicationRunnerOwned"
  >
): (
  opCase: OperationalCase,
  action: PublicationMachineAction
) => Promise<PublicationExecutionResult> {
  return async (opCase, action) => {
    const toolName = publicationToolForAction(action);
    const runOnce = async (ownerResponseText?: string) => {
      const tick = await runSettingsTestCaseAgentTick(db, opCase, userId, {
        ...options,
        source: `${sourcePrefix}:${action.type}`,
        skipLock: true,
        publicationRunnerOwned: true,
        ...(ownerResponseText?.trim()
          ? { ownerResponseText: ownerResponseText.trim() }
          : {}),
      });
      return (
        tick.publication_execution ?? {
          status: "not_executed" as const,
          error: "publication_execution_result_missing",
        }
      );
    };

    let execution = await runOnce();
    // Models sometimes "complete" by narrating a prior media/form failure without
    // calling the publication tool (~few seconds). Retry once with an explicit
    // force-call instruction before the runner marks *_not_called.
    if (
      execution.status === "not_executed" &&
      typeof execution.error === "string" &&
      (execution.error.endsWith("_not_called") ||
        execution.error === "publication_execution_result_missing")
    ) {
      console.warn(
        `[publication-runner] ${execution.error} after first tick; retrying once to force ${toolName ?? "publication tool"}`
      );
      const fresh = await getOperationalCase(db, opCase.id);
      if (fresh) opCase = fresh;
      execution = await runOnce(
        [
          "REINTENTO OBLIGATORIO DEL PUBLICATION RUNNER.",
          toolName
            ? `En este turno DEBES llamar ${toolName} ahora (no es opcional).`
            : "En este turno DEBES llamar la herramienta de publicación ahora.",
          "NO resumas ni reutilices fallos de turnos anteriores.",
          "NO digas que falló media/formulario si no acabas de ejecutar la tool en ESTE turno.",
          "Si no llamas la tool, el caso queda bloqueado.",
        ].join(" ")
      );
    }
    return execution;
  };
}

/**
 * Un tick del agente sobre un caso de prueba creado desde Settings.
 * Usado por la API de pruebas y por el webhook de Telegram cuando el
 * contacto externo responde (el cron no procesa estos casos).
 */
export async function runSettingsTestCaseAgentTick(
  db: ReturnType<typeof createServerClient>,
  opCase: OperationalCase,
  userId: string,
  options?: SettingsTestCaseTickOptions
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
    listingDescriptionIsApproved(initialContext) &&
    !isRecord(initialContext.publication_runner_pending_action)
  ) {
    const progress = await requestPublicationProgress(
      db,
      opCase.id,
      options?.source ?? "case_tick_publication_entry",
      {
        // Settings/E2E run route already took the processing lease with skipLock.
        skipLock: options?.skipLock === true,
        runAgentTick: createPublicationRunnerOwnedAgentTick(
          db,
          userId,
          "publication_runner",
          options
        ),
      }
    );
    // Once copy is approved, publication state owns the tick in all rollout
    // modes. In particular, off/shadow must not fall through to the legacy
    // agent where a publish write could become a generic technical HITL.
    let afterProgress = (await getOperationalCase(db, opCase.id)) ?? opCase;
    if (
      progress.status === "waiting_remote" &&
      (isControlledE2EOperationalCase(afterProgress) ||
        isSettingsOperationalTestCase(afterProgress))
    ) {
      const ctx = contextRecord(afterProgress);
      const patched = await updateOperationalCase(
        db,
        afterProgress.id,
        afterProgress.version,
        {
          context: {
            ...ctx,
            ...(isSettingsOperationalTestCase(afterProgress)
              ? { controlled_test_status: "e2e_waiting_remote_media" }
              : {}),
            ...(isControlledE2EOperationalCase(afterProgress)
              ? { e2e_control_status: "waiting_remote_media" }
              : {}),
          },
        }
      );
      if (patched) afterProgress = patched;
      await insertOperationalCaseEvent(db, {
        caseId: afterProgress.id,
        eventType: "state_changed",
        actor: "system",
        stepKey: afterProgress.current_step ?? undefined,
        payload: {
          source: options?.source ?? "case_tick_publication_entry",
          result: "e2e_waiting_remote_media",
          next_action: progress.next_action?.type ?? "wait_remote_media",
          message: progress.message ?? "waiting_for_remote_media",
        },
      });
    }
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
      ? buildPublicationAwareE2EToolApprovalPolicy({
          context: contextRecord(caseWithTarget),
          documentRequestTarget: explicitDocumentRequestTarget,
          autoExecuteContractDraftGeneration:
            shouldAutoExecuteContractDraftGeneration(caseWithTarget),
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
  const missingListingIngredients =
    missingListingDescriptionIngredientsFromToolCalls(turnToolCalls);
  const draftedListingThisTurn = hasListingDescriptionDraftFromToolCalls(turnToolCalls);
  const uploadedEasybrokerImagesThisTurn =
    hasEasybrokerUploadFromToolCalls(turnToolCalls);
  const easybrokerUploadFailure =
    hasEasybrokerUploadFailureFromToolCalls(turnToolCalls);
  const listingDraftContent = listingDescriptionDraftContentFromContext(
    caseAfterDeterministicFallback?.context_jsonb ?? null
  );
  let responsePreviewForEvent: string | null =
    agentResult.response?.slice(0, 500) ?? null;
  // Manejo determinista compartido del paso de contrato (paridad lab/prod).
  const contractHandling = await applyPostAgentContractHandling({
    db,
    userId,
    opCase: caseAfterDeterministicFallback ?? fresh,
    toolCalls: turnToolCalls,
    pendingConfirmation: Boolean(agentResult.pendingConfirmation),
    source: options?.source ?? "settings_test_case_tick",
    toolContext: {
      sessionId: session.id,
      enabledTools: toolSettings,
      integrations,
      userTimezone: profile.timezone,
    },
  });
  if (contractHandling.handled) {
    responsePreviewForEvent = null;
    // El render determinista pudo persistir contract_draft; refresca el caso
    // para que el resto del tick no clobbere el contexto recién escrito.
    const refreshedForContract = await getOperationalCase(db, fresh.id);
    if (refreshedForContract) {
      caseForFinalUpdate = refreshedForContract;
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
        const waiting = await advisedTickCaseUpdate(
          db,
          caseAfterDeterministicFallback,
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
        const draftForTxt =
          draftRecord && typeof draftRecord === "object" && !Array.isArray(draftRecord)
            ? (draftRecord as Record<string, unknown>)
            : null;
        const txtAttachment =
          draftForTxt &&
          listingDescriptionReviewExcerptTruncated(draftForTxt, {
            currentContext: contextRecord,
          })
            ? buildListingDescriptionDraftTxtAttachment(draftForTxt, {
                caseId: fresh.id,
              })
            : null;
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
              ...(txtAttachment
                ? {
                    listing_description_txt: txtAttachment.content,
                    listing_description_txt_filename: txtAttachment.filename,
                  }
                : {}),
            },
          },
          "normal"
        );
      }
      // Agent notify_user records this event at delivery time. Keep a
      // post-agent backfill for owned fallback/legacy paths, deduped per draft.
      const reviewEventAlreadyRecorded =
        await hasListingDescriptionReviewRequestedEventForCurrentDraft(
          db,
          fresh.id,
          contextRecord(caseAfterDeterministicFallback)
        );
      if (!reviewEventAlreadyRecorded) {
        await insertOperationalCaseEvent(db, {
          caseId: fresh.id,
          eventType: "human_decision",
          actor: "system",
          stepKey: "package_ready",
          payload: {
            kind: "listing_description_review_requested",
            source: options?.source ?? "settings_test_case_tick",
            waiting_for: "advisor_response",
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
          const waiting = await advisedTickCaseUpdate(
            db,
            continueCase,
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
      source: options?.source ?? null,
      publicationRunnerOwned: options?.publicationRunnerOwned === true,
    });

  const preserveRunnerLease =
    options?.skipLock === true &&
    isNestedPublicationRunnerTick(options?.source ?? null, {
      publicationRunnerOwned: options?.publicationRunnerOwned === true,
    });

  const updated = await updateOperationalCase(db, fresh.id, version, {
    nextActionAt:
      preserveRunnerLease
        ? undefined
        : controlledE2ECase
          ? null
          : undefined,
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
        runAgentTick: createPublicationRunnerOwnedAgentTick(
          db,
          userId,
          "package_ready_auto_follow_up",
          {
            autoFollowUpDepth: (options?.autoFollowUpDepth ?? 0) + 1,
          }
        ),
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
