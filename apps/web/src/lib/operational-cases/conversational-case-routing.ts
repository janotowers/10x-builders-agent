import {
  isPropertyOptioningIntent,
  isShortMonthPeriodFollowUp,
  recentMessagesSuggestCompanyData,
} from "@agents/agent";
import type {
  AgentMessage,
  OperationalCase,
  OperationalCaseConversationBinding,
} from "@agents/types";
import { looksLikeDocumentBatchComplete } from "./document-batch-completion";
import { looksLikeDocumentUploadSideText } from "./case-document-collection";
import { operationalCaseDocumentRequestTargetFromContext } from "@agents/types";

function normalize(value: string) {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const ANALYTICS_COUNT_RE =
  /\b(cuantos|cuantas|cuanto|cuanta|total|conteo|numero|cantidad|promedio|conversion|tasa)\b/;
const ANALYTICS_METRIC_NOUN_RE =
  /\b(leads?|prospectos?|citas?|ventas?|cierres?|mensajes?|usuarios?)\b/;
/**
 * Sustantivos de métrica que NO colisionan con el vocabulario inmobiliario
 * ("casa en venta", "renta"). Solo estos habilitan la detección relajada por
 * periodo, para no robarle mensajes legítimos a un caso de opcionamiento.
 */
const ANALYTICS_UNAMBIGUOUS_NOUN_RE =
  /\b(leads?|prospectos?|citas?|mensajes?|usuarios?|kpis?|metricas?)\b/;
const ANALYTICS_REQUEST_VERB_RE =
  /\b(dame|dime|muestrame|muestra|ensename|listame|traeme|reporte|reportame|tuvimos|hubo|registramos|generamos)\b/;
const ANALYTICS_PERIOD_RE =
  /\b(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre|hoy|ayer|20\d{2})\b/;

/**
 * Consulta de métricas del negocio. Tres señales, de más estricta a más
 * relajada: conteo explícito ("cuántos leads"), verbo de petición de datos
 * ("dame los leads"), o sustantivo inequívoco + periodo ("leads de junio").
 * La entrada debe venir normalizada (sin acentos, minúsculas).
 */
function looksLikeBusinessAnalyticsQuestion(text: string) {
  if (ANALYTICS_COUNT_RE.test(text) && ANALYTICS_METRIC_NOUN_RE.test(text)) {
    return true;
  }
  if (
    ANALYTICS_REQUEST_VERB_RE.test(text) &&
    ANALYTICS_METRIC_NOUN_RE.test(text)
  ) {
    return true;
  }
  return (
    ANALYTICS_PERIOD_RE.test(text) && ANALYTICS_UNAMBIGUOUS_NOUN_RE.test(text)
  );
}

/** Variante para texto crudo (normaliza internamente). Para callers externos. */
export function looksLikeAnalyticsRequestMessage(raw: string): boolean {
  return looksLikeBusinessAnalyticsQuestion(normalize(raw));
}

/**
 * Tokens concretos de DATOS de propiedad (sin el fallback de longitud). Sirve
 * para distinguir "Casa en venta en Las Fuentes…" (datos de intake) de una
 * frase de inicio vacía como "Quiero opcionar" (que NO trae datos).
 */
function looksLikePropertyDataDetails(text: string) {
  return /\b(propiedad|casa|depto|departamento|inmueble|terreno|direccion|dirección|dueno|dueño|propietario|precio|reforma|colonia|zona|operacion|operación|venta|renta|tipo|area|área|m2|metros|recamaras|recámaras|banos|baños|estacionamiento)\b/.test(
    text
  );
}

function looksLikePropertyOptioningContinuation(text: string) {
  return looksLikePropertyDataDetails(text) || text.length <= 180;
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

/**
 * Fallback when there is NO pending binding to clarify against (or the user
 * already chose "nueva"): a fresh start phrase must not silently adopt a case
 * already past intake. Prefer asking continue-vs-new via routing when bindings
 * exist (web step 1.5 / Telegram gate before ensure).
 */
export function shouldForceNewConversationalCaseOnExplicitStartIntent(
  message: string,
  existingCase: Pick<OperationalCase, "current_step"> | null | undefined
): boolean {
  if (!existingCase) return false;
  if (looksLikeNewCaseIntent(message)) return true;
  if (!isPropertyOptioningIntent(message)) return false;
  return existingCase.current_step !== "intake";
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

  // Respuesta a la pregunta interno/externo: no pedir aclaración multi-caso.
  // (Check local para no importar document-request-target → ciclo.)
  if (
    params.opCase.context_jsonb?.created_from === "agent_conversation" &&
    params.opCase.current_step === "awaiting_documents" &&
    operationalCaseDocumentRequestTargetFromContext(
      params.opCase.context_jsonb
    ) == null &&
    /\b(interno|interna|externo|externa|ambos|ambas|los dos|las dos|dueno|dueño|propietario|equipo interno|contacto externo)\b/.test(
      text
    )
  ) {
    return true;
  }

  // Cierre de lote de fotos («listo») o texto lateral de subida en photos_requested.
  if (params.opCase.current_step === "photos_requested") {
    return (
      looksLikeDocumentBatchComplete(params.message) ||
      looksLikeDocumentUploadSideText(params.message) ||
      /\b(foto|fotos|imagen|imagenes|imágenes|album|álbum)\b/.test(text)
    );
  }

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

function bindingCandidateTitle(
  binding: OperationalCaseConversationBinding,
  opCase: OperationalCase | null | undefined
): string {
  const context = opCase?.context_jsonb ?? {};
  const candidates = [
    context.property_title,
    context.title,
    context.property_name,
    context.address,
    context.property_zone,
    context.zona,
    context.zone,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return binding.case_type;
}

function formatBindingCandidate(
  binding: OperationalCaseConversationBinding,
  opCase: OperationalCase | null | undefined
) {
  const technical = `${opCase?.status ?? "unknown"} / ${opCase?.current_step ?? "sin_step"}`;
  const title = bindingCandidateTitle(binding, opCase);
  const shortId = opCase?.id ? `…${opCase.id.slice(-8)}` : "";
  return `${binding.case_type} · ${title} · ${technical}${shortId ? ` · ${shortId}` : ""}`;
}

export function resolveTelegramConversationRoute(params: {
  message: string;
  bindings: OperationalCaseConversationBinding[];
  candidateCasesById: Map<string, OperationalCase>;
  explicitIntent: boolean;
  recentMessages?: readonly AgentMessage[];
  /** Adjuntos del turno: señal fuerte de que el mensaje sí es del caso. */
  hasAttachments?: boolean;
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
  if (
    isShortMonthPeriodFollowUp(params.message) &&
    recentMessagesSuggestCompanyData(params.recentMessages ?? [])
  ) {
    return {
      route: "general",
      confidence: "low",
      reason: "analytics_period_followup",
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
    // Precedencia de intake: si el único caso activo aún recolecta intake y el
    // mensaje trae DATOS de propiedad (no una frase de inicio vacía ni una
    // intención explícita de "otra propiedad"), continúa ese caso en vez de
    // pedir aclaración. El guard de "explicit intent" abajo es para casos que
    // YA pasaron intake, no para el que apenas estamos llenando.
    // Excepción: una frase de ARRANQUE determinística ("Quiero opcionar una
    // propiedad") contiene la palabra "propiedad" y pasaría el heurístico de
    // datos, adoptando en silencio un draft viejo — debe caer al clarify
    // continuar-vs-nueva de abajo. Un reply con datos reales ("Casa en venta
    // en Las Fuentes…") no es frase de arranque y sí continúa.
    const intakeIncomplete =
      opCase?.current_step === "intake" &&
      opCase.context_jsonb?.intake_status !== "complete";
    if (
      opCase &&
      intakeIncomplete &&
      !isPropertyOptioningIntent(params.message) &&
      !looksLikeNewCaseIntent(params.message) &&
      looksLikePropertyDataDetails(text)
    ) {
      return {
        route: "case",
        confidence: "high",
        reason: "single_binding_intake_continuation",
        caseId: opCase.id,
        bindingId: binding.id,
        candidateSummaries,
      };
    }
    // "Quiero opcionar" con caso(s) activos no debe adoptar silenciosamente el
    // único binding. Pedimos confirmar: continuar ese caso o iniciar uno nuevo.
    if (params.explicitIntent && opCase) {
      return {
        route: "clarify",
        confidence: "medium",
        reason: "explicit_intent_with_active_bindings",
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
    // Contexto conversacional: si el hilo reciente es de métricas y este
    // mensaje no trae datos de propiedad ni adjuntos, es continuación
    // analítica ("dame los leads de junio", "y la semana pasada?") — no debe
    // caer en el aclarador del caso.
    if (
      !params.hasAttachments &&
      !looksLikePropertyDataDetails(text) &&
      recentMessagesSuggestCompanyData(params.recentMessages ?? [])
    ) {
      return {
        route: "general",
        confidence: "low",
        reason: "analytics_context_continuation",
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

  const matchingContinuationBindings = activeBindings.filter((binding) => {
    const opCase = params.candidateCasesById.get(binding.case_id);
    return Boolean(
      opCase &&
        shouldBindTelegramMessageToConversationalCase({
          message: text,
          opCase,
        })
    );
  });
  if (matchingContinuationBindings.length === 1) {
    const binding = matchingContinuationBindings[0]!;
    const opCase = params.candidateCasesById.get(binding.case_id);
    if (opCase) {
      return {
        route: "case",
        confidence: "high",
        reason: "single_matching_binding_continuation",
        caseId: opCase.id,
        bindingId: binding.id,
        candidateSummaries,
      };
    }
  }

  // Mismo guard de contexto analítico para el aclarador multi-caso (un
  // arranque explícito de opcionamiento sí debe seguir aclarando).
  if (
    !params.explicitIntent &&
    !params.hasAttachments &&
    !looksLikePropertyDataDetails(text) &&
    recentMessagesSuggestCompanyData(params.recentMessages ?? [])
  ) {
    return {
      route: "general",
      confidence: "low",
      reason: "analytics_context_continuation",
      candidateSummaries,
    };
  }

  return {
    route: "clarify",
    confidence: "medium",
    reason: params.explicitIntent
      ? "explicit_intent_with_active_bindings"
      : "multiple_binding_candidates",
    candidateSummaries,
    candidates,
  };
}
