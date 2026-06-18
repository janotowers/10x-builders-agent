import {
  getOperationalCase,
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

type DocumentRequestTargetDecisionSource = "default" | "user" | "agent" | "test";

function caseContext(opCase: OperationalCase): Record<string, unknown> {
  return opCase.context_jsonb && typeof opCase.context_jsonb === "object"
    ? (opCase.context_jsonb as Record<string, unknown>)
    : {};
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

export function buildCaseDocumentRequestTargetPrompt(
  opCase: OperationalCase
): string {
  const canUseExternal = hasOperationalCaseVerifiedExternalContact({
    externalContact: opCase.external_contact_jsonb,
    context: caseContext(opCase),
  });
  if (!canUseExternal) {
    return [
      "Antes de pedir documentos, dime cómo quieres recabarlos.",
      "",
      "No veo un contacto externo verificado para este caso, así que por ahora usaré la ruta interna.",
      "Confirma con: «interno».",
    ].join("\n");
  }
  return [
    "Antes de pedir documentos, necesito tu decisión:",
    "",
    "1) Interno (tú/equipo inmobiliario suben documentos).",
    "2) Externo (se solicitan al dueño/contacto externo).",
    "",
    "Respóndeme solo con «interno» o «externo».",
  ].join("\n");
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

export type ApplyDocumentRequestTargetChoiceResult =
  | {
      handled: true;
      updatedCase: OperationalCase;
      responseText: string;
      /** El caller debe ejecutar el tick E2E post-decisión (sólo casos E2E externos). */
      shouldRunPostChoiceE2ETick: boolean;
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
    return {
      handled: true,
      updatedCase,
      responseText:
        parsedChoice.target === "internal_user"
          ? "Perfecto: usaré ruta interna. Sube los documentos por web/Telegram interno y cuando termines escribe «listo»."
          : "Perfecto: usaré ruta externa y solicitaré los documentos al contacto propietario.",
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
    return {
      handled: true,
      updatedCase: params.opCase,
      responseText:
        "No veo un contacto externo verificado para este caso. Elige «interno», o primero registra un contacto externo válido.",
      shouldRunPostChoiceE2ETick: false,
    };
  }
  return {
    handled: true,
    updatedCase: params.opCase,
    responseText: buildCaseDocumentRequestTargetPrompt(params.opCase),
    shouldRunPostChoiceE2ETick: false,
  };
}
