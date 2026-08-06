import { shortOperationalCaseId } from "@agents/db";
import type { OperationalCase } from "@agents/types";
import { DEFAULT_OPERATIONAL_STEP_LABELS } from "./operational-step-labels";

export interface ConversationCaseIdentity {
  caseTypeLabel: string;
  summary: string;
  technical: string;
  shortId: string;
  /** "[E2E]" para casos de laboratorio, "[Real]" para casos productivos. */
  mode: string;
  /** Paso operativo en lenguaje humano (no técnico). */
  stepLabel: string;
}

function firstNonEmptyString(
  values: Array<unknown>,
  fallback: string
): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return fallback;
}

const CASE_TYPE_LABELS: Record<string, string> = {
  property_optioning: "Opcionamiento de propiedad",
  lead_follow_up: "Seguimiento de leads",
};

/** Etiqueta humana del tipo de caso (fallback al slug técnico si no hay mapa). */
export function humanCaseTypeLabel(caseType: string | null | undefined): string {
  if (!caseType) return "Caso operacional";
  return CASE_TYPE_LABELS[caseType] ?? caseType;
}

/**
 * Detalle / debug: nombre natural + slug técnico entre paréntesis.
 * Misma convención que `formatOperationalStepForDisplay`.
 */
export function formatOperationalCaseTypeForDisplay(
  caseType: string | null | undefined
): string {
  if (!caseType?.trim()) return "(sin tipo)";
  const key = caseType.trim();
  const friendly = humanCaseTypeLabel(key);
  if (!friendly || friendly === key || friendly === "Caso operacional") {
    return key;
  }
  return `${friendly} (${key})`;
}

/** Paso operativo en lenguaje humano. Compartido por copys conversacionales. */
export function conversationalStepLabel(step: string | null | undefined): string {
  if (!step?.trim()) return "Proceso en curso";
  const key = step.trim();
  return DEFAULT_OPERATIONAL_STEP_LABELS[key] ?? key;
}

/**
 * Frase de estado para el broker (no imperativo de sistema).
 * Usada en clarify y leads conversacionales; evita "Solicitar documentos".
 */
export function conversationalStepStatusPhrase(
  opCase: Pick<OperationalCase, "status" | "current_step">
): string {
  if (opCase.status === "waiting_external") return "esperando al propietario";
  if (opCase.status === "waiting_internal") {
    switch (opCase.current_step) {
      case "intake":
        return "en registro inicial";
      case "awaiting_documents":
        return "esperando documentos";
      case "property_data_review":
      case "documents_received":
        return "esperando tu revisión";
      default:
        return "esperando tu acción";
    }
  }
  switch (opCase.current_step) {
    case "intake":
      return "en registro inicial";
    case "awaiting_documents":
      return "esperando documentos";
    case "comparables_in_progress":
      return "en análisis de mercado";
    case "package_ready":
      return "preparando publicación";
    default:
      return "en curso";
  }
}

/** "[E2E]" si el caso es de laboratorio controlado; "[Real]" en otro caso. */
export function operationalCaseModeLabel(opCase: OperationalCase): string {
  return opCase.context_jsonb?.e2e_controlled === true ? "[E2E]" : "[Real]";
}

export function buildConversationCaseIdentity(params: {
  opCase: OperationalCase;
  caseTypeDisplayName?: string | null;
}): ConversationCaseIdentity {
  const context = params.opCase.context_jsonb ?? {};
  const caseTypeLabel =
    params.caseTypeDisplayName?.trim() ||
    humanCaseTypeLabel(params.opCase.case_type);
  const summary = firstNonEmptyString(
    [
      context.title,
      context.property_title,
      context.property_name,
      context.address,
      context.zona,
      context.zone,
      context.location,
    ],
    "Sin título de caso"
  );
  const technical = `${params.opCase.status} / ${params.opCase.current_step ?? "sin_step"}`;
  return {
    caseTypeLabel,
    summary,
    technical,
    shortId: shortOperationalCaseId(params.opCase.id),
    mode: operationalCaseModeLabel(params.opCase),
    stepLabel: conversationalStepLabel(params.opCase.current_step),
  };
}
