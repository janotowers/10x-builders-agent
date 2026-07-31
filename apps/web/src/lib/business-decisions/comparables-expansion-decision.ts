import {
  getInternalUserNotification,
  getOperationalCase,
  insertOperationalCaseEvent,
  resolveUnreadInternalNotificationsByKindForCaseWithReminders,
  type DbClient,
} from "@agents/db";
import { advisedUpdateCase } from "../operational-cases/advised-case-update";
import {
  tryAdvanceComparablesAfterPersist,
  type PricingProposal,
} from "@agents/agent";
import { notifyUserRespectingActiveInternalChannel } from "@/lib/operational-cases/deliver-internal-case-follow-up";
import { cleanResidualRemainder } from "./residual-intent";

type ComparablesExpansionIntent =
  | "use_current_comparables"
  | "use_avaclick_primary"
  | "expand_search"
  | "manual_unavailable"
  | "unclear";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const COMPARABLES_DECISION_PREFIXES: Array<{
  intent: Exclude<ComparablesExpansionIntent, "unclear">;
  pattern: RegExp;
}> = [
  {
    intent: "use_current_comparables",
    pattern:
      /^(1|uno|opcion 1|avanzar con los comparables|comparables actuales|aceptar comparables)\b/,
  },
  {
    intent: "use_avaclick_primary",
    pattern:
      /^(2|dos|opcion 2|usar avaclick|avaclick|avanzar con avaclick|avanza usando avaclick|avanzar usando avaclick|usando avaclick)\b/,
  },
  {
    intent: "expand_search",
    pattern: /^(3|tres|opcion 3|ampliar|expandir|expand search)\b/,
  },
  {
    intent: "manual_unavailable",
    pattern: /^(4|cuatro|opcion 4|manual|cargar comparables)\b/,
  },
];

function normalizeComparablesDecisionText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

export function parseComparablesExpansionDecision(
  text: string
): ComparablesExpansionIntent {
  const normalized = normalizeComparablesDecisionText(text);
  if (!normalized) return "unclear";
  for (const { intent, pattern } of COMPARABLES_DECISION_PREFIXES) {
    if (pattern.test(normalized)) return intent;
  }
  return "unclear";
}

/**
 * Slice 0.1 — remanente no consumido por el prefijo de decisión ("3 y avísame
 * cuando esté" → "y avísame cuando esté"). La normalización NFD preserva la
 * longitud por carácter en español, así que el corte aplica sobre el texto
 * original recortado.
 */
export function computeComparablesExpansionResidual(text: string): string | null {
  const trimmed = text.trim();
  const normalized = normalizeComparablesDecisionText(text);
  if (!normalized) return null;
  for (const { intent, pattern } of COMPARABLES_DECISION_PREFIXES) {
    const match = normalized.match(pattern);
    if (match && match.index != null) {
      const remainder = trimmed.slice(match.index + match[0].length);
      const cleaned = cleanResidualRemainder(remainder);
      if (!cleaned) return null;
      // "2, avanza usando Avaclick" — el resto solo reitera la misma decisión.
      if (parseComparablesExpansionDecision(cleaned) === intent) return null;
      return remainder;
    }
  }
  return null;
}

export async function handleComparablesExpansionDecision(
  db: DbClient,
  params: {
    userId: string;
    notificationId: string;
    text: string;
    source: "web" | "telegram";
    /**
     * Si es `true`, el avance a propuesta de precio NO envía la notificación
     * `price_approval` dentro de este handler: el caller es responsable de
     * dispararla después (usando `notifyPriceApprovalForCase` con la
     * `pricingProposal` devuelta). Sirve para controlar el orden de mensajes
     * en canales de chat (Telegram) donde la confirmación de la decisión debe
     * llegar antes que la propuesta de precio.
     */
    deferPriceApprovalNotify?: boolean;
  }
) {
  const notification = await getInternalUserNotification(db, params.notificationId);
  if (!notification || notification.user_id !== params.userId) {
    return { ok: false, status: "not_found", message: "No encontre el pendiente." };
  }
  if (notification.kind !== "comparables_search_expansion_decision") {
    return {
      ok: false,
      status: "wrong_kind",
      message: "Este pendiente no corresponde a una decision de comparables.",
    };
  }
  if (!notification.case_id) {
    return {
      ok: false,
      status: "missing_case",
      message: "El pendiente no esta asociado a un caso.",
    };
  }
  const opCase = await getOperationalCase(db, notification.case_id);
  if (!opCase || opCase.user_id !== params.userId) {
    return { ok: false, status: "case_not_found", message: "No encontre el caso." };
  }

  const parsedComparablesDecision = parseComparablesExpansionDecision(params.text);
  if (parsedComparablesDecision === "unclear") {
    return {
      ok: false,
      status: "unclear",
      message: "No pude interpretar esa opción. Elige 1, 2 o 3 para continuar.",
    };
  }
  if (parsedComparablesDecision === "manual_unavailable") {
    return {
      ok: false,
      status: "manual_unavailable",
      message:
        "Esa opción ya no está disponible. Usa: 1) avanzar con comparables actuales, 2) Avaclick como base principal, 3) ampliar búsqueda.",
    };
  }
  if (opCase.current_step !== "comparables_in_progress") {
    return {
      ok: true,
      status: "already_processed",
      message: "Esta decision ya no es necesaria porque el caso avanzó de paso.",
      case_id: opCase.id,
      notification_id: notification.id,
    };
  }

  const context = isRecord(opCase.context_jsonb) ? opCase.context_jsonb : {};
  const comparablesAnalysis = isRecord(context.comparables_analysis)
    ? context.comparables_analysis
    : null;
  const avaclickValuation =
    comparablesAnalysis && isRecord(comparablesAnalysis.external_valuation)
      ? comparablesAnalysis.external_valuation
      : null;
  const hasAvaclickValuation = typeof avaclickValuation?.sale_average_mxn === "number";
  const dataQuality =
    comparablesAnalysis && isRecord(comparablesAnalysis.data_quality)
      ? comparablesAnalysis.data_quality
      : null;
  const usableComparablesCount =
    typeof dataQuality?.usable_count === "number" &&
    Number.isFinite(dataQuality.usable_count)
      ? dataQuality.usable_count
      : 0;
  const hasUsableComparables = usableComparablesCount > 0;

  const nextActionAt = new Date().toISOString();
  let updatePayload:
    | {
        status: "active";
        currentStep: "comparables_in_progress";
        nextActionAt: string;
        context: Record<string, unknown>;
      }
    | null = null;

  if (parsedComparablesDecision === "use_current_comparables") {
    if (!hasUsableComparables) {
      return {
        ok: false,
        status: "missing_usable",
        message:
          "Aun no tengo comparables usables para avanzar con muestra limitada. Elige ampliar busqueda.",
      };
    }
    updatePayload = {
      status: "active",
      currentStep: "comparables_in_progress",
      nextActionAt,
      context: {
        ...context,
        comparables_decision: "accept_limited_sample",
        comparables_decision_at: nextActionAt,
        comparables_decision_source: params.source,
      },
    };
  } else if (parsedComparablesDecision === "use_avaclick_primary") {
    if (!hasAvaclickValuation) {
      return {
        ok: false,
        status: "missing_avaclick",
        message:
          "Aun no tengo una valuacion Avaclick valida para este caso. Primero debo ejecutarla correctamente.",
      };
    }
    updatePayload = {
      status: "active",
      currentStep: "comparables_in_progress",
      nextActionAt,
      context: {
        ...context,
        comparables_decision: "use_avaclick_primary",
        comparables_decision_at: nextActionAt,
        comparables_decision_source: params.source,
      },
    };
  } else if (parsedComparablesDecision === "expand_search") {
    updatePayload = {
      status: "active",
      currentStep: "comparables_in_progress",
      nextActionAt,
      context: {
        ...context,
        comparables_decision: "expand_search",
        comparables_decision_at: nextActionAt,
        comparables_decision_source: params.source,
      },
    };
  }

  if (!updatePayload) {
    return {
      ok: false,
      status: "invalid_decision",
      message: "No pude procesar la decisión. Intenta de nuevo.",
    };
  }

  const updated = await advisedUpdateCase(db, opCase, opCase.version, updatePayload);
  if (!updated) {
    return {
      ok: false,
      status: "version_conflict",
      message: "El caso cambió mientras procesaba tu decisión. Intenta de nuevo.",
    };
  }

  let decisionCase = updated;
  // Cuando el caller difiere la notificación, devolvemos la propuesta para que
  // dispare `price_approval` después (control de orden de mensajes en chat).
  let deferredPriceApprovalProposal: PricingProposal | null = null;
  if (
    parsedComparablesDecision === "use_current_comparables" ||
    parsedComparablesDecision === "use_avaclick_primary"
  ) {
    const advanceResult = await tryAdvanceComparablesAfterPersist({
      db,
      opCase: updated,
      userId: updated.user_id,
      source:
        parsedComparablesDecision === "use_avaclick_primary"
          ? `comparables_decision_${params.source}_use_avaclick`
          : `comparables_decision_${params.source}_use_current`,
      // Diferido: no pasamos notifyUser, así el avance persiste la propuesta y
      // el evento `price_proposal_prepared` sin enviar aún `price_approval`.
      notifyUser: params.deferPriceApprovalNotify
        ? undefined
        : notifyUserRespectingActiveInternalChannel,
      allowLimitedSample: parsedComparablesDecision === "use_current_comparables",
      preferAvaclickPrimary: parsedComparablesDecision === "use_avaclick_primary",
    });
    if (!advanceResult.case || !advanceResult.pricingProposal) {
      return {
        ok: false,
        status: "advance_failed",
        message:
          parsedComparablesDecision === "use_avaclick_primary"
            ? "Registré tu decisión, pero no pude preparar precio usando Avaclick en este intento. Puedes elegir ampliar búsqueda o reintentar."
            : "Registré tu decisión, pero no pude avanzar a preparación de precio en este intento. Puedes elegir ampliar búsqueda o reintentar.",
        case_id: updated.id,
        notification_id: notification.id,
      };
    }
    decisionCase = advanceResult.case;
    if (params.deferPriceApprovalNotify) {
      deferredPriceApprovalProposal = advanceResult.pricingProposal;
    }
  }

  await insertOperationalCaseEvent(db, {
    caseId: decisionCase.id,
    eventType: "human_decision",
    actor: "user",
    stepKey: "comparables_in_progress",
    payload: {
      kind: "comparables_search_expansion_decision_response",
      source: params.source,
      notification_id: notification.id,
      text: params.text,
      decision: parsedComparablesDecision,
    },
  });
  await resolveUnreadInternalNotificationsByKindForCaseWithReminders(db, {
    userId: params.userId,
    caseId: decisionCase.id,
    kind: "comparables_search_expansion_decision",
    status: "actioned",
  });

  const message =
    parsedComparablesDecision === "use_avaclick_primary"
      ? "Perfecto. Registro tu decisión: usar Avaclick como base principal para preparar la propuesta de precio y solicitar aprobación interna."
      : parsedComparablesDecision === "use_current_comparables"
        ? "Entendido. Registro tu decisión de avanzar con los comparables actuales y prepararé la propuesta de precio con muestra limitada para aprobación interna."
        : "Entendido. Registro tu decisión de ampliar búsqueda y relanzo el análisis de comparables.";

  return {
    ok: true,
    status: "processed",
    message,
    case_id: decisionCase.id,
    notification_id: notification.id,
    decision: parsedComparablesDecision,
    // Presente solo cuando el caller pidió diferir la notificación de precio y
    // el avance produjo una propuesta: debe llamar a `notifyPriceApprovalForCase`.
    deferredPriceApproval: deferredPriceApprovalProposal
      ? { pricingProposal: deferredPriceApprovalProposal }
      : null,
  };
}
