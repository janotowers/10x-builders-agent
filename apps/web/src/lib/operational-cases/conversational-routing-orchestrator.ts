/**
 * Motor de routing/clarificación conversacional, compartido entre canales.
 *
 * Protege contra asociar un mensaje al caso equivocado cuando el usuario tiene
 * varios casos conversacionales en curso. Originalmente esta lógica vivía sólo
 * en el webhook de Telegram; aquí queda como núcleo agnóstico de canal:
 *
 *  1. Resolución de una respuesta a una aclaración pendiente
 *     (`clarification_needed`): "sí" / "no" / número / "ninguno".
 *  2. Enrutamiento de un mensaje nuevo contra los bindings pendientes del canal,
 *     decidiendo entre asociar a un caso, pedir aclaración, o no asociar.
 *
 * Es agnóstico de canal: NO envía mensajes. Aplica los efectos en DB
 * (estado de bindings) y devuelve `responseText` para que cada adapter lo
 * entregue por su medio. El texto de aclaración es válido para ambos canales.
 */
import {
  createServerClient,
  getOperationalCase,
  setConversationBindingStatus,
} from "@agents/db";
import { isAdoptableConversationalCaseForE2ELab } from "./e2e-lab-routing-isolation";
import type {
  OperationalCase,
  OperationalCaseConversationBinding,
} from "@agents/types";
import {
  resolveTelegramConversationRoute,
  shouldBindTelegramMessageToConversationalCase,
} from "./conversational-case-routing";
import { buildConversationCaseIdentity } from "./conversation-case-identity";

type DbClient = ReturnType<typeof createServerClient>;

type IgnoredBindingReason =
  | "case_not_found"
  | "case_not_routable"
  | "case_type_mismatch"
  | "e2e_requires_controlled_case";

export interface IgnoredConversationBinding {
  binding: OperationalCaseConversationBinding;
  reason: IgnoredBindingReason;
}

export interface RoutableBindingsResolution {
  routableBindings: OperationalCaseConversationBinding[];
  candidateCasesById: Map<string, OperationalCase>;
  ignoredBindings: IgnoredConversationBinding[];
}

function isRoutableCaseForConversation(opCase: OperationalCase): boolean {
  return !(
    opCase.status === "paused" ||
    opCase.status === "completed" ||
    opCase.status === "failed"
  );
}

export function resolveRoutableConversationBindingsSync(params: {
  pendingBindings: OperationalCaseConversationBinding[];
  candidateCasesById: Map<string, OperationalCase>;
  e2eLabSessionActive: boolean;
  caseType?: string;
}): RoutableBindingsResolution {
  const routableBindings: OperationalCaseConversationBinding[] = [];
  const ignoredBindings: IgnoredConversationBinding[] = [];
  const routableCasesById = new Map<string, OperationalCase>();
  for (const binding of params.pendingBindings) {
    const opCase = params.candidateCasesById.get(binding.case_id);
    if (!opCase) {
      ignoredBindings.push({ binding, reason: "case_not_found" });
      continue;
    }
    if (!isRoutableCaseForConversation(opCase)) {
      ignoredBindings.push({ binding, reason: "case_not_routable" });
      continue;
    }
    if (params.caseType && opCase.case_type !== params.caseType) {
      ignoredBindings.push({ binding, reason: "case_type_mismatch" });
      continue;
    }
    if (
      !isAdoptableConversationalCaseForE2ELab(
        opCase,
        params.e2eLabSessionActive
      )
    ) {
      ignoredBindings.push({ binding, reason: "e2e_requires_controlled_case" });
      continue;
    }
    routableBindings.push(binding);
    if (!routableCasesById.has(opCase.id)) {
      routableCasesById.set(opCase.id, opCase);
    }
  }
  return {
    routableBindings,
    candidateCasesById: routableCasesById,
    ignoredBindings,
  };
}

export async function resolveRoutableConversationBindings(params: {
  db: DbClient;
  pendingBindings: OperationalCaseConversationBinding[];
  e2eLabSessionActive: boolean;
  caseType?: string;
}): Promise<RoutableBindingsResolution> {
  const { db, pendingBindings } = params;
  const candidateCaseRows = await Promise.all(
    pendingBindings.map((binding) => getOperationalCase(db, binding.case_id))
  );
  const candidateCasesById = new Map<string, OperationalCase>();
  candidateCaseRows.forEach((row) => {
    if (row) candidateCasesById.set(row.id, row);
  });
  return resolveRoutableConversationBindingsSync({
    pendingBindings,
    candidateCasesById,
    e2eLabSessionActive: params.e2eLabSessionActive,
    caseType: params.caseType,
  });
}

export type ClarificationSelection =
  | { kind: "yes" }
  | { kind: "no" }
  | { kind: "new_case" }
  | { kind: "index"; index: number };

export function parseClarificationSelection(
  text: string
): ClarificationSelection | null {
  const normalized = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
  if (!normalized) return null;
  // Selección numerada de una lista de aclaración multi-caso ("1", "caso 2",
  // "opcion 3", "el 2"). 1-based para coincidir con la lista mostrada.
  const numberMatch = normalized.match(
    /^(?:caso|opcion|opción|el|la|numero|número|#)?\s*(\d{1,2})$/
  );
  if (numberMatch) {
    const index = Number.parseInt(numberMatch[1]!, 10);
    if (Number.isFinite(index) && index >= 1) {
      return { kind: "index", index };
    }
  }
  if (
    /^(si|sí|ok|dale|va|correcto|afirmativo|confirmo|usar ese caso|completar ese caso)$/.test(
      normalized
    )
  ) {
    return { kind: "yes" };
  }
  if (
    /^(no|ninguno|ninguna|negativo|otro|otra cosa|no es ese caso|no corresponde)$/.test(
      normalized
    )
  ) {
    return { kind: "no" };
  }
  if (
    /^(nueva|nuevo|nueva propiedad|nuevo caso|crear nuevo caso|registrar otra propiedad|iniciar registro de otra propiedad|iniciar nuevo proceso de opcion|iniciar nuevo proceso de opción)$/.test(
      normalized
    )
  ) {
    return { kind: "new_case" };
  }
  return null;
}

export type ClarificationReplyResult =
  | {
      status: "resolved_case";
      case: OperationalCase | null;
      effectiveMessage: string | null;
    }
  | {
      status: "resolved_new_case";
      effectiveMessage: string | null;
    }
  | { status: "resolved_no"; responseText: string }
  | { status: "invalid_index"; responseText: string }
  | { status: "unrecognized" };

/**
 * Procesa una respuesta del usuario a una aclaración pendiente. Replica el
 * comportamiento del webhook de Telegram, sin enviar mensajes.
 *
 * - `resolved_case`: el usuario eligió un caso (por "sí" o número). El binding
 *   vuelve a `awaiting_user` y se devuelve el caso + el mensaje original
 *   pendiente para que el caller continúe el turno sobre ESE caso.
 * - `resolved_no`: el usuario rechazó la asociación. Binding a `awaiting_user`.
 * - `invalid_index`: número fuera de rango; no se cambia el binding.
 * - `unrecognized`: el mensaje no es una selección; el caller sigue el flujo
 *   normal (intención/ruteo).
 */
export async function resolveConversationalClarificationReply(params: {
  db: DbClient;
  binding: OperationalCaseConversationBinding;
  message: string;
}): Promise<ClarificationReplyResult> {
  const { db, binding, message } = params;
  const selection = parseClarificationSelection(message);
  const candidateRoutes = Array.isArray(binding.candidate_routes_jsonb)
    ? binding.candidate_routes_jsonb
    : [];

  let chosenCaseId: string | null = null;
  if (selection?.kind === "index") {
    const candidate = candidateRoutes[selection.index - 1] as
      | { caseId?: unknown }
      | undefined;
    const candidateCaseId =
      candidate && typeof candidate.caseId === "string"
        ? candidate.caseId
        : null;
    if (!candidateCaseId) {
      return {
        status: "invalid_index",
        responseText: `No encontré esa opción. Responde con un número entre 1 y ${candidateRoutes.length}, o "ninguno".`,
      };
    }
    chosenCaseId = candidateCaseId;
  } else if (selection?.kind === "yes") {
    const primaryCandidate = candidateRoutes[0] as
      | { caseId?: unknown }
      | undefined;
    chosenCaseId =
      primaryCandidate && typeof primaryCandidate.caseId === "string"
        ? primaryCandidate.caseId
        : binding.case_id;
  }

  if (chosenCaseId) {
    const pendingMessageText =
      typeof binding.pending_message_jsonb?.text === "string"
        ? binding.pending_message_jsonb.text.trim()
        : "";
    const clarifiedCase = await getOperationalCase(db, chosenCaseId);
    await setConversationBindingStatus(db, {
      bindingId: binding.id,
      status: "awaiting_user",
      pendingMessage: {},
      candidateRoutes: [],
      metadataMerge: {
        clarification_last_decision:
          selection?.kind === "index" ? `index:${selection.index}` : "yes",
        clarification_resolved_at: new Date().toISOString(),
        clarification_resolved_case_id: chosenCaseId,
      },
      lastUserMessageAt: new Date().toISOString(),
    });
    return {
      status: "resolved_case",
      case: clarifiedCase,
      effectiveMessage: pendingMessageText || null,
    };
  }

  const allowNewCaseSelection =
    params.binding.metadata_jsonb &&
    typeof params.binding.metadata_jsonb === "object" &&
    !Array.isArray(params.binding.metadata_jsonb) &&
    (params.binding.metadata_jsonb as Record<string, unknown>)
      .clarification_allow_new_case === true;
  if (selection?.kind === "new_case" && allowNewCaseSelection) {
    const pendingMessageText =
      typeof binding.pending_message_jsonb?.text === "string"
        ? binding.pending_message_jsonb.text.trim()
        : "";
    await setConversationBindingStatus(db, {
      bindingId: binding.id,
      status: "awaiting_user",
      pendingMessage: {},
      candidateRoutes: [],
      metadataMerge: {
        clarification_last_decision: "new_case",
        clarification_resolved_at: new Date().toISOString(),
      },
      lastUserMessageAt: new Date().toISOString(),
    });
    return {
      status: "resolved_new_case",
      effectiveMessage: pendingMessageText || null,
    };
  }

  if (selection?.kind === "no") {
    await setConversationBindingStatus(db, {
      bindingId: binding.id,
      status: "awaiting_user",
      pendingMessage: {},
      candidateRoutes: [],
      metadataMerge: {
        clarification_last_decision: "no",
        clarification_resolved_at: new Date().toISOString(),
      },
      lastUserMessageAt: new Date().toISOString(),
    });
    return {
      status: "resolved_no",
      responseText:
        "Perfecto. No asocié ese mensaje al caso pendiente. Si quieres abrir otro flujo, dímelo explícitamente (por ejemplo: publicar en EasyBroker u opcionar otra propiedad).",
    };
  }

  return { status: "unrecognized" };
}

/** Construye el texto de aclaración (válido para web y Telegram). */
export function buildClarificationPrompt(params: {
  candidates: Array<{ caseId: string; bindingId?: string; label: string }>;
  candidateCasesById: Map<string, OperationalCase>;
  /**
   * Activa la opción explícita de "registrar otra propiedad" junto con la
   * selección de caso.
   */
  allowNewCaseOption?: boolean;
  /**
   * Si es true, incluso con 1 candidato se usa formato numerado (1..N) para
   * poder ofrecer también la opción `nueva`.
   */
  forceListSelection?: boolean;
}): string {
  const { candidates, candidateCasesById } = params;
  if (candidates.length === 1 && !params.forceListSelection) {
    const primaryCase = candidateCasesById.get(candidates[0]!.caseId);
    if (primaryCase) {
      const identity = buildConversationCaseIdentity({ opCase: primaryCase });
      return (
        `Tu mensaje podría corresponder a este caso en curso:\n` +
        `• ${identity.mode} ${identity.summary}\n` +
        `• ${identity.caseTypeLabel} · ${identity.stepLabel}\n` +
        `• Caso ${identity.shortId}\n\n` +
        "¿Quieres que lo asocie a ese caso? Responde: sí / no."
      );
    }
  }
  const lines = candidates.map((candidate, idx) => {
    const candidateCase = candidateCasesById.get(candidate.caseId);
    const label = candidateCase
      ? (() => {
          const identity = buildConversationCaseIdentity({
            opCase: candidateCase,
          });
          return `${identity.mode} ${identity.summary} · ${identity.caseTypeLabel} · ${identity.stepLabel} · Caso ${identity.shortId}`;
        })()
      : candidate.label || `Caso ${candidate.caseId}`;
    return `${idx + 1}. ${label}`;
  });
  if (params.allowNewCaseOption && candidates.length === 1) {
    return (
      "Tienes un proceso de propiedad en curso:\n" +
      `${lines[0]}\n\n` +
      'Responde "1" para continuar ese caso, o escribe "nueva" para iniciar el registro de otra propiedad.'
    );
  }
  return (
    "Tu mensaje podría corresponder a varios casos en curso:\n" +
    `${lines.join("\n")}\n\n` +
    (params.allowNewCaseOption
      ? `Responde con el número del caso (1-${candidates.length}) o escribe "nueva" para iniciar el registro de otra propiedad.`
      : `Responde con el número del caso (1-${candidates.length}) o "ninguno".`)
  );
}

export type ConversationalRouteResult =
  | { route: "case"; case: OperationalCase }
  | { route: "clarify"; responseText: string }
  | { route: "none" };

/**
 * Enruta un mensaje nuevo contra los bindings pendientes del canal. Replica el
 * comportamiento del webhook de Telegram (decisión + persistencia), sin enviar
 * mensajes. El caller decide qué hacer con el caso o el texto de aclaración.
 */
export async function routeConversationalMessageAgainstBindings(params: {
  db: DbClient;
  channel: "web" | "telegram";
  message: string;
  pendingBindings: OperationalCaseConversationBinding[];
  explicitIntent: boolean;
  candidateCasesById?: Map<string, OperationalCase>;
}): Promise<ConversationalRouteResult> {
  const { db, message, pendingBindings, explicitIntent } = params;
  let candidateCasesById = params.candidateCasesById;
  if (!candidateCasesById) {
    const candidateCaseRows = await Promise.all(
      pendingBindings.map((binding) => getOperationalCase(db, binding.case_id))
    );
    candidateCasesById = new Map<string, OperationalCase>();
    candidateCaseRows.forEach((row) => {
      if (row) candidateCasesById!.set(row.id, row);
    });
  }

  const routeDecision = resolveTelegramConversationRoute({
    message,
    bindings: pendingBindings,
    candidateCasesById,
    explicitIntent,
  });

  if (routeDecision.route === "case") {
    const matched = candidateCasesById.get(routeDecision.caseId) ?? null;
    if (matched && routeDecision.bindingId) {
      await setConversationBindingStatus(db, {
        bindingId: routeDecision.bindingId,
        status: "awaiting_user",
        metadataMerge: {
          last_route_reason: routeDecision.reason,
          last_route_confidence: routeDecision.confidence,
        },
        lastUserMessageAt: new Date().toISOString(),
      });
    }
    if (matched) return { route: "case", case: matched };
    return { route: "none" };
  }

  if (routeDecision.route === "clarify" && routeDecision.candidates.length > 0) {
    const primary = routeDecision.candidates[0]!;
    const primaryCase = candidateCasesById.get(primary.caseId);
    if (primaryCase) {
      const shouldOfferNewCaseOption =
        routeDecision.reason === "explicit_intent_with_active_bindings";
      await setConversationBindingStatus(db, {
        bindingId: primary.bindingId ?? pendingBindings[0]!.id,
        status: "clarification_needed",
        pendingMessage: {
          text: message,
          received_at: new Date().toISOString(),
        },
        candidateRoutes: routeDecision.candidates,
        metadataMerge: {
          clarification_reason: routeDecision.reason,
          clarification_case_id: primaryCase.id,
          clarification_allow_new_case: shouldOfferNewCaseOption,
        },
        lastUserMessageAt: new Date().toISOString(),
      });
      return {
        route: "clarify",
        responseText: buildClarificationPrompt({
          candidates: routeDecision.candidates,
          candidateCasesById,
          allowNewCaseOption: shouldOfferNewCaseOption,
          forceListSelection: shouldOfferNewCaseOption,
        }),
      };
    }
    return { route: "none" };
  }

  // Fallback: ruta general. Sólo asocia si el mensaje claramente continúa el
  // único caso pendiente (heurística determinística compartida).
  const fallbackBinding = pendingBindings[0];
  const fallbackCase = fallbackBinding
    ? candidateCasesById.get(fallbackBinding.case_id)
    : null;
  if (
    fallbackBinding &&
    fallbackCase &&
    shouldBindTelegramMessageToConversationalCase({
      message,
      opCase: fallbackCase,
    })
  ) {
    return { route: "case", case: fallbackCase };
  }

  return { route: "none" };
}
