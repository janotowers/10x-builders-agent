import type {
  OperationalCase,
  OperationalCaseConversationBinding,
} from "@agents/types";

function normalize(value: string) {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeBusinessAnalyticsQuestion(text: string) {
  return (
    /\b(cuantos|cuantas|cuanto|cuanta|total|conteo|numero|cantidad|promedio|conversion|tasa)\b/.test(
      text
    ) &&
    /\b(leads?|prospectos?|citas?|ventas?|cierres?|mensajes?|usuarios?)\b/.test(
      text
    )
  );
}

function looksLikePropertyOptioningContinuation(text: string) {
  return (
    /\b(propiedad|casa|depto|departamento|inmueble|terreno|direccion|dirección|dueno|dueño|propietario|precio|reforma|colonia|zona|operacion|operación|venta|renta|tipo|area|área|m2|metros|recamaras|recámaras|banos|baños|estacionamiento)\b/.test(
      text
    ) ||
    text.length <= 180
  );
}

function looksLikePropertyDataReviewResponse(text: string) {
  return (
    /\b(confirmo|correcto|corregir|corrige|correccion|corrección|aclaro|aclaracion|aclaración)\b/.test(
      text
    ) ||
    /\b(operacion|operación|tipo|zona|direccion|dirección|area|área|m2|metros|venta|renta|terreno|casa|departamento|recamaras|recámaras|banos|baños|estacionamientos?)\b/.test(
      text
    )
  );
}

/**
 * Detects an explicit intent to open a NEW case while another may be active,
 * e.g. "quiero opcionar otra propiedad", "es para un nuevo caso", "otra casa".
 * Deterministic on purpose so it can gate forcing a fresh case without an LLM.
 */
export function looksLikeNewCaseIntent(message: string): boolean {
  const text = normalize(message);
  if (!text) return false;
  const mentionsNewQualifier =
    /\b(otra|otro|nueva|nuevo|adicional|adicionales|distinta|distinto|diferente)\b/.test(
      text
    );
  if (!mentionsNewQualifier) return false;
  return /\b(propiedad|propiedades|casa|casas|depto|departamento|departamentos|inmueble|inmuebles|terreno|terrenos|caso|operacion|operación)\b/.test(
    text
  );
}

export function shouldBindTelegramMessageToConversationalCase(params: {
  message: string;
  opCase: OperationalCase;
}) {
  const text = normalize(params.message);
  if (!text) return false;
  if (looksLikeBusinessAnalyticsQuestion(text)) return false;

  const context = params.opCase.context_jsonb ?? {};
  const intakeIncomplete =
    params.opCase.current_step === "intake" &&
    context.intake_status !== "complete";
  if (intakeIncomplete) return looksLikePropertyOptioningContinuation(text);

  const reviewingPropertyData =
    params.opCase.status === "waiting_internal" &&
    (params.opCase.current_step === "documents_received" ||
      params.opCase.current_step === "property_data_review");
  if (reviewingPropertyData) return looksLikePropertyDataReviewResponse(text);

  return (
    params.opCase.current_step === "intake" &&
    looksLikePropertyOptioningContinuation(text)
  );
}

export type ConversationRouteDecision =
  | {
      route: "case";
      confidence: "high" | "medium";
      reason: string;
      caseId: string;
      bindingId?: string;
      candidateSummaries: string[];
    }
  | {
      route: "general";
      confidence: "low";
      reason: string;
      candidateSummaries: string[];
    }
  | {
      route: "clarify";
      confidence: "medium";
      reason: string;
      candidateSummaries: string[];
      candidates: Array<{
        caseId: string;
        bindingId?: string;
        label: string;
      }>;
    };

function isRoutableCase(opCase: OperationalCase | null | undefined) {
  return Boolean(
    opCase &&
      opCase.status !== "paused" &&
      opCase.status !== "completed" &&
      opCase.status !== "failed"
  );
}

function looksLikeListingIntent(text: string) {
  return (
    /\b(publicar|subir|listar)\b/.test(text) &&
    /\b(easybroker|portal|portales|publicacion|publicación)\b/.test(text)
  );
}

function formatBindingCandidate(
  binding: OperationalCaseConversationBinding,
  opCase: OperationalCase | null | undefined
) {
  const technical = `${opCase?.status ?? "unknown"} / ${opCase?.current_step ?? "sin_step"}`;
  const title =
    typeof opCase?.context_jsonb?.title === "string" && opCase.context_jsonb.title.trim()
      ? opCase.context_jsonb.title.trim()
      : binding.case_type;
  const shortId = opCase?.id ? `…${opCase.id.slice(-8)}` : "";
  return `${binding.case_type} · ${title} · ${technical}${shortId ? ` · ${shortId}` : ""}`;
}

export function resolveTelegramConversationRoute(params: {
  message: string;
  bindings: OperationalCaseConversationBinding[];
  candidateCasesById: Map<string, OperationalCase>;
  explicitIntent: boolean;
}): ConversationRouteDecision {
  const text = normalize(params.message);
  if (!text) {
    return {
      route: "general",
      confidence: "low",
      reason: "empty_message",
      candidateSummaries: [],
    };
  }
  if (looksLikeBusinessAnalyticsQuestion(text)) {
    return {
      route: "general",
      confidence: "low",
      reason: "analytics_query",
      candidateSummaries: [],
    };
  }

  const dedupedBindingsByCaseId = new Map<string, OperationalCaseConversationBinding>();
  for (const binding of params.bindings) {
    if (
      binding.status !== "awaiting_user" &&
      binding.status !== "clarification_needed"
    ) {
      continue;
    }
    const opCase = params.candidateCasesById.get(binding.case_id);
    if (!isRoutableCase(opCase)) continue;
    if (!dedupedBindingsByCaseId.has(binding.case_id)) {
      dedupedBindingsByCaseId.set(binding.case_id, binding);
    }
  }
  const activeBindings = [...dedupedBindingsByCaseId.values()];
  const candidateSummaries = activeBindings.map((binding) =>
    formatBindingCandidate(binding, params.candidateCasesById.get(binding.case_id))
  );

  if (activeBindings.length === 0) {
    return {
      route: "general",
      confidence: "low",
      reason: params.explicitIntent ? "intent_without_binding" : "no_pending_binding",
      candidateSummaries,
    };
  }

  if (activeBindings.length === 1) {
    const binding = activeBindings[0]!;
    const opCase = params.candidateCasesById.get(binding.case_id);
    if (params.explicitIntent && opCase) {
      return {
        route: "case",
        confidence: "high",
        reason: "explicit_intent_with_single_binding",
        caseId: opCase.id,
        bindingId: binding.id,
        candidateSummaries,
      };
    }
    if (opCase && shouldBindTelegramMessageToConversationalCase({ message: text, opCase })) {
      return {
        route: "case",
        confidence: "high",
        reason: "single_binding_continuation_match",
        caseId: opCase.id,
        bindingId: binding.id,
        candidateSummaries,
      };
    }
    if (looksLikeListingIntent(text) || text.length > 240) {
      return {
        route: "general",
        confidence: "low",
        reason: "looks_like_other_intent",
        candidateSummaries,
      };
    }
    if (opCase) {
      return {
        route: "clarify",
        confidence: "medium",
        reason: "single_binding_ambiguous_followup",
        candidateSummaries,
        candidates: [
          {
            caseId: opCase.id,
            bindingId: binding.id,
            label: formatBindingCandidate(binding, opCase),
          },
        ],
      };
    }
  }

  const candidates = activeBindings
    .map((binding) => {
      const opCase = params.candidateCasesById.get(binding.case_id);
      if (!opCase) return null;
      return {
        caseId: opCase.id,
        bindingId: binding.id,
        label: formatBindingCandidate(binding, opCase),
      };
    })
    .filter((value) => value !== null);

  return {
    route: "clarify",
    confidence: "medium",
    reason: "multiple_binding_candidates",
    candidateSummaries,
    candidates,
  };
}
