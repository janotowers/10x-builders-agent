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

export type ClarificationSelection =
  | { kind: "yes" }
  | { kind: "no" }
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
  return null;
}

export type ClarificationReplyResult =
  | {
      status: "resolved_case";
      case: OperationalCase | null;
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
}): string {
  const { candidates, candidateCasesById } = params;
  if (candidates.length === 1) {
    const primaryCase = candidateCasesById.get(candidates[0]!.caseId);
    if (primaryCase) {
      const identity = buildConversationCaseIdentity({ opCase: primaryCase });
      return (
        `Tu mensaje podría corresponder al caso pendiente de ${identity.caseTypeLabel}:\n` +
        `• ${identity.summary}\n` +
        `• Técnico: ${identity.technical}\n` +
        `• Caso: ${identity.shortId}\n\n` +
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
          return `${identity.caseTypeLabel} · ${identity.summary} · ${identity.technical} · Caso ${identity.shortId}`;
        })()
      : candidate.label || `Caso ${candidate.caseId}`;
    return `${idx + 1}. ${label}`;
  });
  return (
    "Tu mensaje podría corresponder a varios casos en curso:\n" +
    `${lines.join("\n")}\n\n` +
    `Responde con el número del caso (1-${candidates.length}) o "ninguno".`
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
}): Promise<ConversationalRouteResult> {
  const { db, message, pendingBindings, explicitIntent } = params;
  const candidateCaseRows = await Promise.all(
    pendingBindings.map((binding) => getOperationalCase(db, binding.case_id))
  );
  const candidateCasesById = new Map<string, OperationalCase>();
  candidateCaseRows.forEach((row) => {
    if (row) candidateCasesById.set(row.id, row);
  });

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
        },
        lastUserMessageAt: new Date().toISOString(),
      });
      return {
        route: "clarify",
        responseText: buildClarificationPrompt({
          candidates: routeDecision.candidates,
          candidateCasesById,
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
