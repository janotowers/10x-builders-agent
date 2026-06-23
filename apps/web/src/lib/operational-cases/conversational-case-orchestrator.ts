/**
 * Núcleo agnóstico de canal para la conversación operacional.
 *
 * Telegram y el chat web son adapters distintos sobre el MISMO backend de
 * casos. Este módulo concentra la parte que ambos comparten:
 *   1. Detección de intención operacional (determinística + LLM).
 *   2. Resolución/creación del caso conversacional (`ensureConversationalCase`),
 *      adoptando la sesión E2E del laboratorio cuando aplica.
 *   3. Política de aprobación de tools del caso (pura, por `current_step`).
 *
 * Lo específico de cada canal (UX de aclaración por texto, bindings por
 * `chat_id`, callbacks de Telegram, subida de archivos) vive en su adapter, NO
 * aquí. El chat web usa `resolveConversationalCaseForChannel` en el paso 2.
 *
 * Deuda técnica menor: el webhook de Telegram aún duplica este paso 2 inline
 * (misma lógica, más side-effects de canal). Ver
 * `docs/operational-cases/future-considerations.md` §10.
 */
import {
  findLatestConversationalOperationalCase,
  getActiveE2ELabSession,
  getOperationalCase,
  linkE2ELabSessionToCase,
} from "@agents/db";
import { isPropertyOptioningIntent } from "@agents/agent";
import type { OperationalCase, ToolApprovalPolicy } from "@agents/types";
import { ensureConversationalCase } from "./ensure-conversational-case";
import {
  looksLikeNewCaseIntent,
  shouldForceNewConversationalCaseOnExplicitStartIntent,
} from "./conversational-case-routing";
import { isUsableE2ELabSessionCase } from "./e2e-lab-routing-isolation";
import { classifyOperationalConversationMessage } from "./operational-conversation-classifier";

type DbClient = Parameters<typeof getActiveE2ELabSession>[0];

const PROPERTY_OPTIONING_CASE_TYPE = "property_optioning";

/**
 * Política de aprobación de tools para un caso operacional, derivada solo de
 * `current_step`. Es pura e idéntica en cualquier canal: durante `intake`
 * dejamos que el agente cree/actualice intake sin fricción pero bloqueamos
 * transiciones de estado; fuera de intake solo el update de intake es
 * auto-ejecutable.
 */
export function buildOperationalCaseToolApprovalPolicy(
  opCase: Pick<OperationalCase, "current_step"> | null | undefined
): ToolApprovalPolicy | undefined {
  if (!opCase) return undefined;

  const policy: ToolApprovalPolicy = {
    operational_case_update_intake: "auto_execute",
  };

  if (opCase.current_step === "intake") {
    policy.operational_case_create = "auto_execute";
    policy.operational_case_update_state = "deny";
  }

  return policy;
}

export interface ResolveConversationalCaseResult {
  case: OperationalCase | null;
  created: boolean;
  toolApprovalPolicy: ToolApprovalPolicy | undefined;
  /** True cuando se detectó intención explícita de flujo operacional. */
  explicitIntent: boolean;
  /** True cuando la intención operacional se detectó por reglas (no LLM). */
  deterministicIntent: boolean;
}

/**
 * Decide, para un turno entrante de CUALQUIER canal real (chat web o Telegram),
 * si hay intención de abrir/continuar un caso `property_optioning` y, de ser
 * así, resuelve o crea el caso conversacional correspondiente.
 *
 * Devuelve siempre el resultado de detección de intención explícita para que el
 * caller pueda reutilizar la MISMA señal en pasos posteriores de routing. Si
 * `case` viene `null`, no se pudo resolver/crear caso y el caller puede
 * continuar con su fallback.
 *
 * No produce efectos colaterales de canal (no manda mensajes ni crea bindings
 * por `chat_id`); `ensureConversationalCase` ya registra el binding del canal
 * recibido. El adapter del canal decide qué responder.
 */
export async function resolveConversationalCaseForChannel(params: {
  db: DbClient;
  userId: string;
  channel: "web" | "telegram";
  message: string;
  /**
   * Fuerza abrir un caso nuevo (no adoptar el activo) y trata el turno como
   * intención explícita de flujo operacional. Se usa tras una aclaración del
   * tipo "continuar caso existente vs registrar otra propiedad".
   */
  forceNewCase?: boolean;
}): Promise<ResolveConversationalCaseResult> {
  const message = params.message?.trim();
  if (!message) {
    return {
      case: null,
      created: false,
      toolApprovalPolicy: undefined,
      explicitIntent: false,
      deterministicIntent: false,
    };
  }

  let forceNewCase = params.forceNewCase === true;
  const deterministicIntent = isPropertyOptioningIntent(message);
  let explicitIntent = forceNewCase || deterministicIntent;
  if (!explicitIntent) {
    const classification = await classifyOperationalConversationMessage({
      message,
      stage: "no_case",
    });
    explicitIntent = Boolean(
      classification &&
        classification.route === PROPERTY_OPTIONING_CASE_TYPE &&
        classification.intent === "start_case" &&
        classification.confidence !== "low"
    );
  }
  if (!explicitIntent) {
    return {
      case: null,
      created: false,
      toolApprovalPolicy: undefined,
      explicitIntent,
      deterministicIntent,
    };
  }

  const activeE2ELabSession = await getActiveE2ELabSession(params.db, {
    userId: params.userId,
    caseType: PROPERTY_OPTIONING_CASE_TYPE,
  });
  const activeE2ELabSessionCaseId =
    typeof activeE2ELabSession?.case_id === "string" &&
    activeE2ELabSession.case_id.trim().length > 0
      ? activeE2ELabSession.case_id.trim()
      : null;

  let conversationalCase: OperationalCase | null = null;
  if (activeE2ELabSessionCaseId && !forceNewCase) {
    const sessionCase = await getOperationalCase(
      params.db,
      activeE2ELabSessionCaseId
    );
    const usableSessionCase = isUsableE2ELabSessionCase({
      opCase: sessionCase,
      userId: params.userId,
      caseType: PROPERTY_OPTIONING_CASE_TYPE,
    });
    if (activeE2ELabSession && !usableSessionCase) {
      forceNewCase = true;
    } else if (sessionCase) {
      if (
        shouldForceNewConversationalCaseOnExplicitStartIntent(
          message,
          sessionCase
        )
      ) {
        forceNewCase = true;
      } else {
        conversationalCase = sessionCase;
      }
    }
  }

  let created = false;
  if (!conversationalCase) {
    if (!forceNewCase && deterministicIntent) {
      const latestConversationalCase =
        await findLatestConversationalOperationalCase(params.db, {
          userId: params.userId,
          caseType: PROPERTY_OPTIONING_CASE_TYPE,
          statuses: ["active", "waiting_internal", "waiting_external"],
        });
      if (
        shouldForceNewConversationalCaseOnExplicitStartIntent(
          message,
          latestConversationalCase
        )
      ) {
        forceNewCase = true;
      }
    }
    const ensured = await ensureConversationalCase(params.db, {
      userId: params.userId,
      caseType: PROPERTY_OPTIONING_CASE_TYPE,
      channel: params.channel,
      e2eControlled: Boolean(activeE2ELabSession),
      forceNew:
        forceNewCase ||
        looksLikeNewCaseIntent(message) ||
        Boolean(activeE2ELabSession && !activeE2ELabSessionCaseId),
    });
    conversationalCase = ensured?.case ?? null;
    created = ensured?.created ?? false;
  }

  if (!conversationalCase) {
    return {
      case: null,
      created,
      toolApprovalPolicy: undefined,
      explicitIntent,
      deterministicIntent,
    };
  }

  if (
    activeE2ELabSession &&
    conversationalCase.context_jsonb?.e2e_controlled === true &&
    activeE2ELabSession.case_id !== conversationalCase.id
  ) {
    await linkE2ELabSessionToCase(params.db, {
      sessionId: activeE2ELabSession.id,
      caseId: conversationalCase.id,
    });
  } else if (
    activeE2ELabSession &&
    conversationalCase.context_jsonb?.e2e_controlled !== true
  ) {
    console.warn(
      "[conversational-case-orchestrator] skipped linking e2e session to non-e2e case",
      {
        sessionId: activeE2ELabSession.id,
        caseId: conversationalCase.id,
      }
    );
  }

  return {
    case: conversationalCase,
    created,
    toolApprovalPolicy: buildOperationalCaseToolApprovalPolicy(conversationalCase),
    explicitIntent,
    deterministicIntent,
  };
}
