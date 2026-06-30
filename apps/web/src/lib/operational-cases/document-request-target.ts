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
  if (!params.canUseExternal) {
    return [
      "¿Quién prefieres que aporte esos documentos?",
      "",
      "• «interno» — tú o tu equipo los suben.",
      "• «externo» — se los solicito al dueño/contacto. Si aún no está vinculado, primero te daré un enlace para conectarlo.",
      "",
      "Respóndeme solo con «interno» o «externo».",
    ].join("\n");
  }
  return [
    "¿Quién prefieres que aporte esos documentos?",
    "",
    "• «interno» — tú o tu equipo los suben.",
    "• «externo» — se los solicito al dueño/contacto.",
    "",
    "Respóndeme solo con «interno» o «externo».",
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
      'Puedes enviarlos aquí mismo o desde el panel del caso y confirmar con «listo» cuando termines.',
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
  const whereToUpload =
    params.channel === "telegram"
      ? "Puedes enviarlos aquí mismo como archivos o subirlos desde el panel del caso."
      : "Puedes adjuntarlos en este chat o subirlos desde el panel del caso.";
  return [
    "Perfecto.",
    whereToUpload,
    'Cuando tengas cargados todos los documentos disponibles, avísame con «listo» y empiezo a revisarlos.',
  ].join(" ");
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
  const now = new Date().toISOString();
  const updated = await updateOperationalCase(db, opCase.id, opCase.version, {
    context: {
      ...context,
      document_request_target: resolved,
      document_request_target_decided_at: now,
      document_request_target_decided_by: params.decidedBy ?? "default",
    },
  });
  return updated ?? opCase;
}

export async function setCaseDocumentRequestTarget(params: {
  db: DbClient;
  opCase: OperationalCase;
  target: OperationalCaseDocumentRequestTarget;
  decidedBy?: DocumentRequestTargetDecisionSource;
}): Promise<OperationalCase> {
  const context = caseContext(params.opCase);
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
        document_request_target_decided_by: params.decidedBy ?? "user",
      },
    }
  );
  return updated ?? params.opCase;
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

function isInternalDocumentCollectionCase(opCase: OperationalCase): boolean {
  const target = operationalCaseDocumentRequestTargetFromContext(
    caseContext(opCase)
  );
  return (
    target === "internal_user" &&
    (opCase.current_step === "awaiting_documents" ||
      opCase.current_step === "documents_received") &&
    opCase.status !== "paused" &&
    opCase.status !== "completed" &&
    opCase.status !== "failed"
  );
}

/** Timestamp de la decisión de destino documental, como epoch ms (0 si falta). */
function internalCollectionDecidedAt(opCase: OperationalCase): number {
  const value = caseContext(opCase).document_request_target_decided_at;
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Casos internos que están recabando documentos entre los bindings pendientes,
 * ordenados del más reciente al más antiguo por la decisión de destino. Fuente
 * única para resolver subidas (media o texto) hacia el caso correcto sin pedir
 * aclaración multi-caso innecesaria.
 */
async function collectInternalDocumentCollectionCases(params: {
  db: DbClient;
  pendingBindings: OperationalCaseConversationBinding[];
}): Promise<OperationalCase[]> {
  const candidates: OperationalCase[] = [];
  const seen = new Set<string>();
  for (const binding of params.pendingBindings) {
    if (seen.has(binding.case_id)) continue;
    seen.add(binding.case_id);
    const opCase = await getOperationalCase(params.db, binding.case_id);
    if (opCase && isInternalDocumentCollectionCase(opCase)) {
      candidates.push(opCase);
    }
  }
  candidates.sort(
    (a, b) => internalCollectionDecidedAt(b) - internalCollectionDecidedAt(a)
  );
  return candidates;
}

/**
 * Fase 1 (media-first): resuelve el caso interno destino de un mensaje que trae
 * ARCHIVO adjunto. No requiere ningún gate de texto: la sola presencia de media
 * en ruta interna es señal inequívoca, de modo que un caption (p. ej. el del
 * primer elemento de un álbum) nunca preempta la ingestión. Prefiere el caso
 * interno con decisión de destino más reciente.
 */
export async function resolveInternalDocumentUploadCaseForMedia(params: {
  db: DbClient;
  pendingBindings: OperationalCaseConversationBinding[];
}): Promise<OperationalCase | null> {
  const candidates = await collectInternalDocumentCollectionCases(params);
  return candidates[0] ?? null;
}

/**
 * Resuelve a qué caso pertenece un mensaje de TEXTO relacionado con la subida de
 * documentos en ruta interna: texto lateral ("adjunto documentos") o cierre de
 * lote ("listo"). Evita desambiguación multi-caso o caer al LLM general.
 *
 * Estrategia de 2 niveles (sin regex frágil que haya que ir engordando):
 *   1) Gate barato determinístico de alta confianza (`looksLikeDocumentBatchComplete`
 *      / `looksLikeDocumentUploadSideText`).
 *   2) Fallback LLM (`stage: "awaiting_documents"`) SOLO cuando hay un caso
 *      interno recabando documentos y el gate barato no resolvió. Interpreta
 *      frases impredecibles ("ahí te van", "te paso lo que junté") y distingue
 *      la intención de abrir un caso nuevo (en cuyo caso NO adopta).
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
  const candidates = await collectInternalDocumentCollectionCases(params);
  if (candidates.length === 0) return { matchedCase: null, reason: null };
  const target = candidates[0]!;

  if (looksLikeDocumentBatchComplete(params.message)) {
    return { matchedCase: target, reason: "batch_complete" };
  }
  if (looksLikeDocumentUploadSideText(params.message)) {
    return { matchedCase: target, reason: "upload_side_text" };
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
