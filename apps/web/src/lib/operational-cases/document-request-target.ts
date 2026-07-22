import {
  getOperationalCase,
  getRecentOperationalCaseEvents,
  insertOperationalCaseEvent,
  updateOperationalCase,
  type DbClient,
} from "@agents/db";
import type {
  OperationalCase,
  OperationalCaseConversationBinding,
} from "@agents/types";
import {
  type OperationalCaseDocumentRequestTarget,
  hasOperationalCaseVerifiedExternalContact,
  resolveOperationalCaseDocumentRequestTarget,
  operationalCaseDocumentRequestTargetFromContext,
} from "@agents/types";
import {
  DOCUMENT_PRIVACY_LINE,
  buildDocumentChecklistLines,
  looksLikeDocumentBatchComplete,
  looksLikeDocumentUploadSideText,
} from "./case-document-collection";
import {
  classifyOperationalConversationMessage,
  type OperationalConversationClassifierModel,
} from "./operational-conversation-classifier";
import { looksLikeNewCaseIntent } from "./conversational-case-routing";
import { isAwaitingCharacteristicsResponse } from "./characteristics-response";
import {
  conversationalStepLabel,
  operationalCaseModeLabel,
} from "./conversation-case-identity";
import { buildTelegramIntakeCompletionMessage } from "./telegram-intake-completion-message";
import {
  beginExternalContactLink,
  buildExternalContactSetupMessage,
} from "./external-contact-link";
import { recordStepBranchSelected } from "./step-branch-selected";

type DocumentRequestTargetDecisionSource =
  | "default"
  | "user"
  | "agent"
  | "test"
  | "inferred";

function caseContext(opCase: OperationalCase): Record<string, unknown> {
  return opCase.context_jsonb && typeof opCase.context_jsonb === "object"
    ? (opCase.context_jsonb as Record<string, unknown>)
    : {};
}

function firstContextString(
  context: Record<string, unknown>,
  keys: string[]
): string | null {
  for (const key of keys) {
    const value = context[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function buildCaseScopeLead(opCase: OperationalCase): string {
  const context = caseContext(opCase);
  const mode = operationalCaseModeLabel(opCase);
  const title =
    firstContextString(context, ["property_title", "title", "property_name"]) ??
    firstContextString(context, ["property_zone", "zona", "zone"]) ??
    "Propiedad sin título";
  return `Sobre ${mode} ${title} (${conversationalStepLabel(opCase.current_step)}):`;
}

export function resolveCaseDocumentRequestTarget(
  opCase: OperationalCase
): OperationalCaseDocumentRequestTarget {
  return resolveOperationalCaseDocumentRequestTarget({
    externalContact: opCase.external_contact_jsonb,
    context: caseContext(opCase),
  });
}

export function caseDocumentRequestTargetLabel(
  target: OperationalCaseDocumentRequestTarget
): string {
  return target === "external_contact"
    ? "Se solicitan al contacto externo"
    : "Los sube el equipo interno";
}

export function explicitCaseDocumentRequestTarget(
  opCase: OperationalCase
): OperationalCaseDocumentRequestTarget | null {
  return operationalCaseDocumentRequestTargetFromContext(caseContext(opCase));
}

export function shouldPromptCaseDocumentRequestTarget(
  opCase: OperationalCase
): boolean {
  return (
    opCase.context_jsonb?.created_from === "agent_conversation" &&
    opCase.current_step === "awaiting_documents" &&
    explicitCaseDocumentRequestTarget(opCase) == null
  );
}

/**
 * Pregunta de cierre interno/externo. Variante por canal sólo para el modo de
 * envío; el cuerpo (documentos) es común y vive en el checklist compartido.
 */
function buildDocumentTargetChoiceQuestion(params: {
  canUseExternal: boolean;
}): string {
  const externalLine = params.canUseExternal
    ? "• **«externo»** si quieres que se los solicite al dueño/contacto de la propiedad."
    : "• **«externo»** si quieres que se los solicite al dueño/contacto de la propiedad. Si aún no está vinculado, primero te daré un enlace para conectarlo.";
  return [
    "¿Quién prefieres que aporte esos documentos?",
    "",
    "**Responde**:",
    "• **«interno»** si tú me los darás.",
    externalLine,
  ].join("\n");
}

/**
 * Mensaje post-intake: primero EXPLICA qué documentos se necesitan y luego
 * pregunta quién los aportará. El cuerpo (checklist + privacidad) es común a
 * todos los canales; sólo la pregunta final cambia si no hay contacto externo.
 */
export function buildCaseDocumentRequestTargetPrompt(
  opCase: OperationalCase
): string {
  const canUseExternal = hasOperationalCaseVerifiedExternalContact({
    externalContact: opCase.external_contact_jsonb,
    context: caseContext(opCase),
  });
  return [
    buildCaseScopeLead(opCase),
    "",
    "Para avanzar necesito estos documentos de la propiedad:",
    "",
    ...buildDocumentChecklistLines(),
    "",
    DOCUMENT_PRIVACY_LINE,
    "",
    buildDocumentTargetChoiceQuestion({ canUseExternal }),
  ].join("\n");
}

/**
 * Mensaje único post-intake: combina la confirmación de la propiedad (con sus
 * datos) + la lista de documentos requeridos + la pregunta de destino, SIN
 * repetir el "lead" de alcance (que sí es útil en re-prompts standalone). Es el
 * mensaje que se envía justo al completar el intake conversacional.
 */
export function buildPostIntakeDocumentRequestMessage(
  opCase: OperationalCase
): string {
  const canUseExternal = hasOperationalCaseVerifiedExternalContact({
    externalContact: opCase.external_contact_jsonb,
    context: caseContext(opCase),
  });
  return [
    buildTelegramIntakeCompletionMessage(opCase),
    "",
    "Para avanzar necesitaré los siguientes documentos:",
    "",
    ...buildDocumentChecklistLines(),
    "",
    DOCUMENT_PRIVACY_LINE,
    "",
    buildDocumentTargetChoiceQuestion({ canUseExternal }),
  ].join("\n");
}

/**
 * Re-prompt determinístico cuando el asesor re-expresa intención de inicio
 * («quiero opcionar una propiedad») sobre un caso que YA pasó el intake. No
 * reabrimos intake ni delegamos al LLM (que improvisaría un formulario de
 * intake): le recordamos que el caso ya está registrado y cuál es la acción
 * esperada del paso actual. Es channel-agnóstico (sólo compone texto).
 */
export function buildOperationalCaseContinuationReprompt(
  opCase: OperationalCase
): string {
  const lead = buildCaseScopeLead(opCase);
  if (opCase.current_step === "awaiting_documents") {
    const target = explicitCaseDocumentRequestTarget(opCase);
    if (target == null) {
      // Aún no se eligió interno/externo: re-pregunta el destino documental.
      return buildCaseDocumentRequestTargetPrompt(opCase);
    }
    if (target === "external_contact") {
      return [
        lead,
        "",
        "Este caso ya está registrado y estamos esperando que el contacto externo envíe los documentos. Te aviso en cuanto reciba algo.",
      ].join("\n");
    }
    return [
      lead,
      "",
      "Este caso ya está registrado y está en la etapa de documentos. Cuando puedas, súbeme:",
      "",
      ...buildDocumentChecklistLines(),
      "",
      DOCUMENT_PRIVACY_LINE,
      "",
      "Puedes enviarlos aquí mismo como archivos y confirmar con **«listo»** cuando termines.",
    ].join("\n");
  }
  return [
    lead,
    "",
    "Este caso ya está registrado y sigue en curso. Continúo con el proceso desde el punto actual; te aviso el siguiente paso.",
  ].join("\n");
}

/**
 * Acuse al confirmar la ruta documental. El cuerpo es común; la variante de
 * canal sólo aclara DÓNDE subir (Telegram/web/panel) sin filtrar el nombre de
 * un canal en el copy base.
 */
export function buildDocumentRouteConfirmationAck(params: {
  target: OperationalCaseDocumentRequestTarget;
  channel: "web" | "telegram";
}): string {
  if (params.target === "external_contact") {
    return "Perfecto: se los solicitaré al dueño/contacto externo y te aviso en cuanto responda.";
  }
  // Channel-neutral: advisors operate via chat (web, Telegram, or future channels).
  void params.channel;
  return "Perfecto. Envíalos aquí mismo como archivos. Cuando tengas cargados todos los documentos disponibles, avísame con **«listo»** y empiezo a revisarlos.";
}

export type DocumentFlowReminderPurpose =
  | "documents_checklist_post_intake"
  | "internal_upload_instructions"
  | "external_documents_routed";

/**
 * Registra en el audit trail que se solicitó documentación al asesor/contacto.
 * Idempotente por propósito: no duplica el mismo recordatorio reciente.
 */
export async function recordDocumentFlowReminder(params: {
  db: DbClient;
  caseId: string;
  purpose: DocumentFlowReminderPurpose;
  channel: "web" | "telegram";
  source: string;
  audience?: "internal_user" | "external_contact";
}): Promise<void> {
  const recent = await getRecentOperationalCaseEvents(params.db, params.caseId, 12);
  const alreadyLogged = recent.some((event) => {
    if (event.event_type !== "reminder_sent") return false;
    const payload = event.payload_jsonb;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
    return (payload as Record<string, unknown>).purpose === params.purpose;
  });
  if (alreadyLogged) return;

  await insertOperationalCaseEvent(params.db, {
    caseId: params.caseId,
    eventType: "reminder_sent",
    actor: "system",
    stepKey: "awaiting_documents",
    payload: {
      kind: "reminder_sent",
      purpose: params.purpose,
      channel: params.channel,
      source: params.source,
      step_key: "awaiting_documents",
      audience: params.audience ?? "internal_user",
    },
  });
}

export type ParseDocumentRequestTargetChoiceResult = {
  target: OperationalCaseDocumentRequestTarget | null;
  reason?: "both_not_supported" | "ambiguous" | "external_unavailable";
};

function normalizeChoiceText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function parseCaseDocumentRequestTargetChoice(params: {
  opCase: OperationalCase;
  message: string;
}): ParseDocumentRequestTargetChoiceResult {
  const normalized = normalizeChoiceText(params.message);
  if (!normalized) return { target: null, reason: "ambiguous" };

  if (/\b(ambos|ambas|los dos|las dos|interno y externo|externo e interno)\b/.test(normalized)) {
    return { target: null, reason: "both_not_supported" };
  }

  const wantsInternal =
    /\b(interno|interna|yo los subo|yo subo|equipo interno|asesor)\b/.test(
      normalized
    );
  const wantsExternal =
    /\b(externo|externa|dueno|dueño|propietario|contacto externo|pidelo al dueno|pidelo al propietario)\b/.test(
      normalized
    );

  if (wantsInternal && !wantsExternal) return { target: "internal_user" };
  if (wantsExternal && !wantsInternal) {
    const canUseExternal = hasOperationalCaseVerifiedExternalContact({
      externalContact: params.opCase.external_contact_jsonb,
      context: caseContext(params.opCase),
    });
    if (!canUseExternal) return { target: null, reason: "external_unavailable" };
    return { target: "external_contact" };
  }
  return { target: null, reason: "ambiguous" };
}

export async function ensureCaseDocumentRequestTarget(params: {
  db: DbClient;
  opCase: OperationalCase;
  decidedBy?: DocumentRequestTargetDecisionSource;
}): Promise<OperationalCase> {
  const { db, opCase } = params;
  const context = caseContext(opCase);
  const resolved = resolveCaseDocumentRequestTarget(opCase);
  const current = operationalCaseDocumentRequestTargetFromContext(context);
  if (current === resolved) return opCase;
  return setCaseDocumentRequestTarget({
    db,
    opCase,
    target: resolved,
    decidedBy: params.decidedBy ?? "default",
  });
}

export async function setCaseDocumentRequestTarget(params: {
  db: DbClient;
  opCase: OperationalCase;
  target: OperationalCaseDocumentRequestTarget;
  decidedBy?: DocumentRequestTargetDecisionSource;
  reason?: string;
  source?: string;
}): Promise<OperationalCase> {
  const context = caseContext(params.opCase);
  const previous = operationalCaseDocumentRequestTargetFromContext(context);
  const decidedBy = params.decidedBy ?? "user";
  if (previous === params.target) {
    // Ya fijado: no reescribe contexto ni duplica evento.
    return params.opCase;
  }
  const now = new Date().toISOString();
  const updated = await updateOperationalCase(
    params.db,
    params.opCase.id,
    params.opCase.version,
    {
      context: {
        ...context,
        document_request_target: params.target,
        document_request_target_decided_at: now,
        document_request_target_decided_by: decidedBy,
      },
    }
  );
  const next = updated ?? params.opCase;
  await recordStepBranchSelected({
    db: params.db,
    caseId: next.id,
    stepKey: next.current_step,
    branchValue: params.target,
    decidedBy,
    previousValue: previous,
    reason: params.reason,
    source: params.source,
  });
  return next;
}

/** Pure gate: should we persist internal_user from an advisor upload? */
export function canInferInternalDocumentTargetOnUpload(
  opCase: OperationalCase
): boolean {
  return (
    operationalCaseDocumentRequestTargetFromContext(caseContext(opCase)) ==
      null &&
    shouldPromptCaseDocumentRequestTarget(opCase) &&
    opCase.current_step === "awaiting_documents"
  );
}

/**
 * When the advisor uploads documents before answering interno/externo, infer
 * internal_user deterministically (files arrive from the advisor's own chat).
 * Shared by Telegram and web for channel parity. Idempotent if already set.
 */
export async function inferInternalDocumentTargetOnUpload(params: {
  db: DbClient;
  opCase: OperationalCase;
  source: string;
  reason?: string;
  /** Extra payload fields for the legacy inferred event (Telegram message_id…). */
  eventExtras?: Record<string, unknown>;
}): Promise<{ opCase: OperationalCase; inferred: boolean }> {
  if (!canInferInternalDocumentTargetOnUpload(params.opCase)) {
    return { opCase: params.opCase, inferred: false };
  }

  const inferred = await setCaseDocumentRequestTarget({
    db: params.db,
    opCase: params.opCase,
    target: "internal_user",
    decidedBy: "inferred",
    source: params.source,
    reason: params.reason ?? "advisor_uploaded_documents_before_choice",
  });
  const withStatus =
    (await updateOperationalCase(params.db, inferred.id, inferred.version, {
      status: "waiting_internal",
    })) ?? inferred;

  // Compat E2E / proyección: besides step_branch_selected from setCase…,
  // keep the legacy kind for settings-test flow progress.
  await insertOperationalCaseEvent(params.db, {
    caseId: withStatus.id,
    eventType: "state_changed",
    actor: "system",
    stepKey: withStatus.current_step ?? undefined,
    payload: {
      kind: "document_request_target_inferred",
      source: params.source,
      target: "internal_user",
      reason: params.reason ?? "advisor_uploaded_documents_before_choice",
      ...(params.eventExtras ?? {}),
    },
  });

  return { opCase: withStatus, inferred: true };
}

/**
 * Gate barato: ¿el mensaje parece una respuesta a la pregunta interno/externo?
 * No requiere el caso; sólo detecta intención de elegir destino documental.
 * Sirve para enrutar la respuesta al caso correcto ANTES del routing genérico,
 * evitando una desambiguación multi-caso innecesaria.
 */
export function messageLooksLikeDocumentTargetChoice(message: string): boolean {
  const normalized = normalizeChoiceText(message);
  if (!normalized) return false;
  return /\b(interno|interna|externo|externa|ambos|ambas|los dos|las dos|dueno|dueño|propietario|equipo interno|contacto externo)\b/.test(
    normalized
  );
}

/**
 * Dado un conjunto de bindings pendientes (ya ordenados por `updated_at desc`),
 * resuelve a qué caso pertenece una respuesta interno/externo. Sólo considera
 * casos que efectivamente esperan esa decisión (`shouldPromptCaseDocumentRequestTarget`).
 *
 * - 0 candidatos → `{ matchedCase: null }` (el caller sigue el flujo normal).
 * - 1 candidato → ese caso.
 * - >1 candidatos → el más reciente (primer binding del listado), marcado como
 *   `ambiguous` por si el caller quiere registrar telemetría.
 */
export async function resolveDocumentTargetReplyAgainstBindings(params: {
  db: DbClient;
  message: string;
  pendingBindings: OperationalCaseConversationBinding[];
}): Promise<{ matchedCase: OperationalCase | null; ambiguous: boolean }> {
  if (!messageLooksLikeDocumentTargetChoice(params.message)) {
    return { matchedCase: null, ambiguous: false };
  }
  const candidates: OperationalCase[] = [];
  const seen = new Set<string>();
  for (const binding of params.pendingBindings) {
    if (seen.has(binding.case_id)) continue;
    seen.add(binding.case_id);
    const opCase = await getOperationalCase(params.db, binding.case_id);
    if (opCase && shouldPromptCaseDocumentRequestTarget(opCase)) {
      candidates.push(opCase);
    }
  }
  if (candidates.length === 0) return { matchedCase: null, ambiguous: false };
  return { matchedCase: candidates[0]!, ambiguous: candidates.length > 1 };
}

function isOpenOperationalCase(opCase: OperationalCase): boolean {
  return (
    opCase.status !== "paused" &&
    opCase.status !== "completed" &&
    opCase.status !== "failed"
  );
}

function isInternalDocumentCollectionCase(opCase: OperationalCase): boolean {
  const target = operationalCaseDocumentRequestTargetFromContext(
    caseContext(opCase)
  );
  return (
    target === "internal_user" &&
    (opCase.current_step === "awaiting_documents" ||
      opCase.current_step === "documents_received") &&
    isOpenOperationalCase(opCase)
  );
}

/**
 * Recolección interna de fotos de publicación (photos_requested).
 * Comparte ownership/batch con documentos, pero NO exige document_request_target
 * ni clasificación OCR: las fotos las aporta el asesor al pendiente interno.
 */
export function isInternalPhotosCollectionCase(
  opCase: OperationalCase
): boolean {
  return (
    opCase.current_step === "photos_requested" && isOpenOperationalCase(opCase)
  );
}

/** Caso que acepta media interna (documentos legales o fotos de listing). */
export function isInternalMediaCollectionCase(
  opCase: OperationalCase
): boolean {
  return (
    isInternalDocumentCollectionCase(opCase) ||
    isInternalPhotosCollectionCase(opCase)
  );
}

/** Timestamp de la decisión de destino documental, como epoch ms (0 si falta). */
function internalCollectionDecidedAt(opCase: OperationalCase): number {
  const value = caseContext(opCase).document_request_target_decided_at;
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Recencia para ordenar candidatos de media interna (docs o fotos). */
function internalMediaCollectionRecency(opCase: OperationalCase): number {
  const decided = internalCollectionDecidedAt(opCase);
  const updated =
    typeof opCase.updated_at === "string" ? Date.parse(opCase.updated_at) : NaN;
  const updatedMs = Number.isFinite(updated) ? updated : 0;
  return Math.max(decided, updatedMs);
}

/**
 * Casos internos que están recabando media (documentos o fotos) entre los
 * bindings pendientes, ordenados del más reciente al más antiguo. Fuente única
 * para resolver subidas (media o texto) hacia el caso correcto sin pedir
 * aclaración multi-caso innecesaria.
 */
async function collectInternalMediaCollectionCases(params: {
  db: DbClient;
  pendingBindings: OperationalCaseConversationBinding[];
}): Promise<OperationalCase[]> {
  const candidates: OperationalCase[] = [];
  const seen = new Set<string>();
  for (const binding of params.pendingBindings) {
    if (seen.has(binding.case_id)) continue;
    seen.add(binding.case_id);
    const opCase = await getOperationalCase(params.db, binding.case_id);
    if (opCase && isInternalMediaCollectionCase(opCase)) {
      candidates.push(opCase);
    }
  }
  candidates.sort(
    (a, b) => internalMediaCollectionRecency(b) - internalMediaCollectionRecency(a)
  );
  return candidates;
}

/**
 * Fase 1 (media-first): resuelve el caso interno destino de un mensaje que trae
 * ARCHIVO adjunto (documentos legales o fotos de listing). No requiere gate de
 * texto: la sola presencia de media en ruta interna es señal inequívoca.
 * Prefiere el caso de recolección más reciente.
 */
export async function resolveInternalDocumentUploadCaseForMedia(params: {
  db: DbClient;
  pendingBindings: OperationalCaseConversationBinding[];
}): Promise<OperationalCase | null> {
  const candidates = await collectInternalMediaCollectionCases(params);
  return candidates[0] ?? null;
}

/**
 * Resuelve a qué caso pertenece un mensaje de TEXTO relacionado con la subida
 * interna de documentos o fotos: texto lateral ("adjunto…") o cierre de lote
 * ("listo"). Evita desambiguación multi-caso o caer al LLM general.
 *
 * Estrategia:
 *   1) Gate barato determinístico (`looksLikeDocumentBatchComplete` /
 *      `looksLikeDocumentUploadSideText`) — aplica a docs y fotos.
 *   2) Fallback LLM SOLO para recolección documental (`awaiting_documents` /
 *      `documents_received`). En `photos_requested` no improvisamos con LLM.
 */
export async function resolveInternalDocumentMessageCase(params: {
  db: DbClient;
  message: string;
  pendingBindings: OperationalCaseConversationBinding[];
  /** Inyectable para tests; en producción usa el clasificador OpenRouter. */
  classifierModel?: OperationalConversationClassifierModel;
  /** Permite desactivar el fallback LLM (p. ej. tests deterministas). */
  useLlmFallback?: boolean;
}): Promise<{
  matchedCase: OperationalCase | null;
  reason: "batch_complete" | "upload_side_text" | null;
}> {
  const candidates = await collectInternalMediaCollectionCases(params);
  if (candidates.length === 0) return { matchedCase: null, reason: null };
  const target = candidates[0]!;

  if (looksLikeDocumentBatchComplete(params.message)) {
    return { matchedCase: target, reason: "batch_complete" };
  }
  if (looksLikeDocumentUploadSideText(params.message)) {
    return { matchedCase: target, reason: "upload_side_text" };
  }

  // Fotos: sólo gates determinísticos (listo / texto lateral). Sin LLM.
  if (isInternalPhotosCollectionCase(target)) {
    return { matchedCase: null, reason: null };
  }

  const useLlm = params.useLlmFallback ?? true;
  const trimmed = params.message.trim();
  if (!useLlm || !trimmed || trimmed.length > 160) {
    return { matchedCase: null, reason: null };
  }

  const classification = await classifyOperationalConversationMessage(
    {
      message: trimmed,
      stage: "awaiting_documents",
      caseSummary: buildInternalCollectionCaseSummary(target),
    },
    params.classifierModel
  );
  if (!classification) return { matchedCase: null, reason: null };
  // Intención clara de abrir un caso distinto: no adoptar este caso.
  if (
    classification.route === "property_optioning" &&
    classification.intent === "start_case"
  ) {
    return { matchedCase: null, reason: null };
  }
  if (classification.intent === "mark_ready") {
    return { matchedCase: target, reason: "batch_complete" };
  }
  if (classification.intent === "deliver_documents") {
    return { matchedCase: target, reason: "upload_side_text" };
  }
  return { matchedCase: null, reason: null };
}

function buildInternalCollectionCaseSummary(opCase: OperationalCase): string {
  const context = caseContext(opCase);
  return [
    firstContextString(context, ["property_title", "title", "property_name"]),
    firstContextString(context, ["property_zone", "zona", "zone"]),
    firstContextString(context, ["operation_type"]),
    firstContextString(context, ["property_type"]),
  ]
    .filter((value): value is string => Boolean(value))
    .join(" · ");
}


export async function resolveCharacteristicsReplyAgainstBindings(params: {
  db: DbClient;
  message: string;
  pendingBindings: OperationalCaseConversationBinding[];
}): Promise<{ matchedCase: OperationalCase | null; ambiguous: boolean }> {
  const text = params.message.trim();
  if (!text || looksLikeDocumentBatchComplete(text) || looksLikeNewCaseIntent(text)) {
    return { matchedCase: null, ambiguous: false };
  }

  const candidates: OperationalCase[] = [];
  const seen = new Set<string>();
  for (const binding of params.pendingBindings) {
    if (seen.has(binding.case_id)) continue;
    seen.add(binding.case_id);
    const opCase = await getOperationalCase(params.db, binding.case_id);
    if (!opCase) continue;
    if (!isInternalDocumentCollectionCase(opCase)) continue;
    if (opCase.current_step !== "documents_received" || opCase.status !== "waiting_internal") {
      continue;
    }
    if (await isAwaitingCharacteristicsResponse(params.db, opCase)) {
      candidates.push(opCase);
    }
  }

  if (candidates.length === 0) return { matchedCase: null, ambiguous: false };
  return { matchedCase: candidates[0]!, ambiguous: candidates.length > 1 };
}

export type ApplyDocumentRequestTargetChoiceResult =
  | {
      handled: true;
      updatedCase: OperationalCase;
      responseText: string;
      /** El caller debe ejecutar el tick E2E post-decisión (sólo casos E2E externos). */
      shouldRunPostChoiceE2ETick: boolean;
      /**
       * Presente cuando el asesor eligió «externo» sin contacto verificado: el
       * caller debe construir el deep link de vinculación con este token y
       * entregar el mensaje de setup (en lugar de `responseText`).
       */
      externalContactSetupToken?: string;
    }
  | { handled: false; updatedCase: OperationalCase };

/**
 * Handler determinístico, compartido entre canales, de la respuesta del asesor
 * a la pregunta interno/externo. Centraliza el parseo, la persistencia del
 * `document_request_target`, la transición de estado y los textos de ack/error.
 *
 * Devuelve `handled: false` sólo cuando el caso no está esperando esta decisión.
 * Cuando sí la espera, SIEMPRE produce un `responseText` (ack, error o re-prompt),
 * de modo que el caller pueda responder y cortar sin delegar al LLM.
 */
export async function applyDocumentRequestTargetChoice(params: {
  db: DbClient;
  opCase: OperationalCase;
  message: string;
  channel: "web" | "telegram";
}): Promise<ApplyDocumentRequestTargetChoiceResult> {
  const { db, message } = params;
  if (!shouldPromptCaseDocumentRequestTarget(params.opCase)) {
    return { handled: false, updatedCase: params.opCase };
  }

  const parsedChoice = parseCaseDocumentRequestTargetChoice({
    opCase: params.opCase,
    message,
  });

  if (parsedChoice.target) {
    let updatedCase = await setCaseDocumentRequestTarget({
      db,
      opCase: params.opCase,
      target: parsedChoice.target,
      decidedBy: "user",
    });
    const isExternal = parsedChoice.target === "external_contact";
    const isE2E = updatedCase.context_jsonb?.e2e_controlled === true;
    const nextActionAt = isExternal && !isE2E ? new Date().toISOString() : null;
    const withStatus =
      (await updateOperationalCase(db, updatedCase.id, updatedCase.version, {
        status: isExternal ? "active" : "waiting_internal",
        nextActionAt,
      })) ?? updatedCase;
    updatedCase = withStatus;
    await recordDocumentFlowReminder({
      db,
      caseId: updatedCase.id,
      purpose: isExternal ? "external_documents_routed" : "internal_upload_instructions",
      channel: params.channel,
      source: "document_request_target_choice",
      audience: isExternal ? "external_contact" : "internal_user",
    });
    return {
      handled: true,
      updatedCase,
      responseText: buildDocumentRouteConfirmationAck({
        target: parsedChoice.target,
        channel: params.channel,
      }),
      shouldRunPostChoiceE2ETick: isExternal && isE2E,
    };
  }

  if (parsedChoice.reason === "both_not_supported") {
    return {
      handled: true,
      updatedCase: params.opCase,
      responseText:
        "Por ahora el modo «ambos» aún no está habilitado. Elige una ruta: «interno» o «externo».",
      shouldRunPostChoiceE2ETick: false,
    };
  }
  if (parsedChoice.reason === "external_unavailable") {
    // «externo» sin contacto verificado: no rechazamos la intención. Entramos al
    // subflujo de vinculación (deep link de Telegram) y dejamos el caso en setup
    // pendiente. El caller construye el enlace con el token y lo entrega.
    const { updatedCase, token } = await beginExternalContactLink(db, params.opCase);
    return {
      handled: true,
      updatedCase,
      responseText: buildExternalContactSetupMessage({ deepLink: null }),
      shouldRunPostChoiceE2ETick: false,
      externalContactSetupToken: token,
    };
  }
  return {
    handled: true,
    updatedCase: params.opCase,
    responseText: buildCaseDocumentRequestTargetPrompt(params.opCase),
    shouldRunPostChoiceE2ETick: false,
  };
}
