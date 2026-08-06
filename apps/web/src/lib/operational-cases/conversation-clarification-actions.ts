/**
 * Acciones de aclaración continuar-vs-nueva (arranque explícito con caso
 * activo). Mismo contrato en Telegram y web: botones/chips + texto libre.
 *
 * Patrón alineado con HITL (`freeText` canónico + callback Telegram), pero
 * sin notification_id: la respuesta es un mensaje normal que
 * `parseClarificationSelection` ya entiende.
 */
import { isPropertyOptioningIntent } from "@agents/agent";
import type { HitlTelegramReplyMarkup } from "@/lib/notify/hitl-telegram-markup";
import type { OperationalCase } from "@agents/types";
import { buildIntakeProgressPrompt } from "./conversational-intake-orchestrator";
import { buildOperationalCaseContinuationReprompt } from "./document-request-target";
import {
  extractConservativeIntakePatch,
  normalizeIntakePatchValues,
} from "./property-optioning-intake-extraction";

/** Arranque sin datos de intake: no reinyectar tras "continuar". */
export function isBarePropertyStartIntent(message: string): boolean {
  const text = message.trim();
  if (!text || !isPropertyOptioningIntent(text)) return false;
  const patch = normalizeIntakePatchValues(extractConservativeIntakePatch(text));
  return Object.keys(patch).length === 0;
}

/**
 * Tras "continuar" en clarify: retoma el paso del caso (documentos, intake
 * incompleto, etc.). Nunca un "¿En qué te ayudo?" genérico — el flujo ya
 * define la siguiente acción.
 */
export function buildClarificationContinueResponse(
  opCase: OperationalCase
): string {
  const intakeIncomplete =
    opCase.current_step === "intake" &&
    opCase.context_jsonb?.intake_status !== "complete";
  if (intakeIncomplete) {
    return buildIntakeProgressPrompt({
      context: opCase.context_jsonb,
      missingFields:
        (opCase.context_jsonb?.missing_required as unknown[]) ?? [],
    });
  }
  return buildOperationalCaseContinuationReprompt(opCase);
}

export const CLARIFY_CONTINUE_FREE_TEXT = "continuar";
export const CLARIFY_NEW_FREE_TEXT = "nueva";

/** Prefijos de callback Telegram (`prefix:bindingId`). */
export const CLARIFY_CONTINUE_CALLBACK_PREFIX = "clarify_continue";
export const CLARIFY_NEW_CALLBACK_PREFIX = "clarify_new";

export type ClarificationChoiceAction = {
  id: "continue_case" | "new_case";
  label: string;
  variant: "primary" | "secondary";
  freeText: string;
  telegramCallbackPrefix: string;
};

export const CLARIFICATION_CONTINUE_NEW_ACTIONS: ClarificationChoiceAction[] = [
  {
    id: "continue_case",
    label: "Continuar ese",
    variant: "primary",
    freeText: CLARIFY_CONTINUE_FREE_TEXT,
    telegramCallbackPrefix: CLARIFY_CONTINUE_CALLBACK_PREFIX,
  },
  {
    id: "new_case",
    label: "Empezar otro",
    variant: "secondary",
    freeText: CLARIFY_NEW_FREE_TEXT,
    telegramCallbackPrefix: CLARIFY_NEW_CALLBACK_PREFIX,
  },
];

export function buildClarificationContinueNewTelegramMarkup(params: {
  bindingId: string;
}): HitlTelegramReplyMarkup {
  const bindingId = params.bindingId.trim();
  return {
    inline_keyboard: [
      CLARIFICATION_CONTINUE_NEW_ACTIONS.map((action) => ({
        text: action.label,
        callback_data: `${action.telegramCallbackPrefix}:${bindingId}`,
      })),
    ],
  };
}

/** Payload web: chips que envían el freeText como mensaje normal. */
export function buildClarificationContinueNewWebPayload(params: {
  bindingId: string;
  caseId: string;
}): Record<string, unknown> {
  return {
    source: "operational_case",
    kind: "conversation_clarification",
    clarification_kind: "continue_vs_new",
    binding_id: params.bindingId,
    case_id: params.caseId,
    actions: CLARIFICATION_CONTINUE_NEW_ACTIONS.map((action) => ({
      id: action.id,
      label: action.label,
      variant: action.variant,
      freeText: action.freeText,
    })),
  };
}

export function freeTextForClarificationCallback(
  action: string
): string | null {
  if (action === CLARIFY_CONTINUE_CALLBACK_PREFIX) {
    return CLARIFY_CONTINUE_FREE_TEXT;
  }
  if (action === CLARIFY_NEW_CALLBACK_PREFIX) {
    return CLARIFY_NEW_FREE_TEXT;
  }
  return null;
}
