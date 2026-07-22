/**
 * Deterministic read-only case queries (Fase 3).
 *
 * Pure parsers/formatters so the pending-decision router can answer known
 * side questions ("¿cuál fue el precio ideal?", "¿cómo va el caso?") from
 * case context WITHOUT resolving notifications or mutating state. Anything
 * that does not match these strict interrogative shapes falls through to the
 * normal conversational routing/agent.
 */

import type { PendingCaseContext } from "@/lib/notifications/enrich-case-context";

export type CaseQueryIntent = "price" | "status";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function positiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Decision verbs must never be swallowed by the read-only query gate. */
const DECISION_VERB =
  /\b(aprobar|apruebo|aprobado|aprueba|rechaz\w*|ajust\w*|cambi\w*|sube|baja|modific\w*|corrig\w*|publica\w*|cancel\w*)\b/i;

// (?!\w) instead of \b: JS \b fails after accented chars ("qué" → é ∉ \w).
const QUESTION_LEAD =
  /^(?:¿)?\s*(?:qu[eé]|cu[aá]l(?:es)?|c[oó]mo|cu[aá]ndo|d[oó]nde|qui[eé]n(?:es)?|cu[aá]nt[oa]s?|por\s+qu[eé]|para\s+qu[eé]|me\s+(?:recuerdas|puedes\s+(?:decir|recordar))|recu[eé]rdame|dime)(?!\w)/i;

function hasQuestionSignal(text: string): boolean {
  return /^¿/.test(text) || /\?\s*$/.test(text) || QUESTION_LEAD.test(text);
}

const PRICE_QUERY_TOPIC = /\bprecios?\b/i;

const STATUS_QUERY_SHAPE =
  /(?:^|\b)(?:c[oó]mo\s+va(?:mos)?\b|en\s+qu[eé]\s+paso\b|qu[eé]\s+paso\s+(?:vamos|estamos|sigue)\b|\bestatus\b|\bstatus\b|estado\s+del\s+(?:caso|proceso|tr[aá]mite)\b|qu[eé]\s+sigue\b|c[oó]mo\s+vamos\b)/i;

/**
 * Strict read-only query detection. Decisions ("APROBAR PRECIO",
 * "AJUSTAR PRECIO salida=23000") and data replies never match: any decision
 * verb or `campo=valor` patch disables the query gate.
 */
export function parseCaseQueryIntent(text: string): CaseQueryIntent | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (DECISION_VERB.test(trimmed)) return null;
  if (/\b\w+\s*=\s*\S/.test(trimmed)) return null;

  if (STATUS_QUERY_SHAPE.test(trimmed)) return "status";
  if (PRICE_QUERY_TOPIC.test(trimmed) && hasQuestionSignal(trimmed)) {
    return "price";
  }
  return null;
}

/**
 * A pending contract_data_review claims any text by default. This detector
 * lets clearly interrogative, data-free messages escape to the agent instead
 * of dead-ending in "No pude registrar los datos contractuales".
 * Conservative on purpose: any data signal (email, digits, sí/no answer near
 * a contract keyword) keeps the current claiming behavior.
 */
export function looksLikeSideQuestionNotData(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (!hasQuestionSignal(trimmed)) return false;
  const hasEmail = /[^\s@]+@[^\s@]+\.[^\s@]+/.test(trimmed);
  const hasDigits = /\d/.test(trimmed);
  // (?!\w) instead of trailing \b: "sí" ends in an accented char (é/í ∉ \w).
  const hasBooleanContractAnswer =
    /\b(s[ií]|no)(?!\w)[^.!]{0,40}\b(comisi[oó]n|exclusiv|colabor|compart)/i.test(
      trimmed
    ) ||
    /\b(comisi[oó]n|exclusiv\w*|colabor\w*|compart\w*)(?!\w)[^.!]{0,40}\b(s[ií]|no)(?!\w)/i.test(
      trimmed
    );
  return !hasEmail && !hasDigits && !hasBooleanContractAnswer;
}

function formatMxn(value: number): string {
  return `$${Math.round(value).toLocaleString("es-MX")}`;
}

function formatDateEsMx(iso: string): string | null {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString("es-MX", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/**
 * Read-only answer from `context.pricing_proposal`. Returns null when the
 * proposal lacks the three amounts (caller falls through to the agent).
 */
export function formatPricingProposalQueryAnswer(
  proposal: unknown
): string | null {
  if (!isRecord(proposal)) return null;
  const { salida, ideal, minimo } = proposal;
  if (
    !positiveNumber(salida) ||
    !positiveNumber(ideal) ||
    !positiveNumber(minimo)
  ) {
    return null;
  }
  const approved = proposal.approval_status === "approved";
  const approvedAt =
    approved && typeof proposal.approved_at === "string"
      ? formatDateEsMx(proposal.approved_at)
      : null;
  const statusLine = approved
    ? approvedAt
      ? `Estado: aprobados (el ${approvedAt}).`
      : "Estado: aprobados."
    : "Estado: pendientes de aprobación.";
  return [
    "Precios del caso:",
    `- Salida (publicación): ${formatMxn(salida)}`,
    `- Ideal: ${formatMxn(ideal)}`,
    `- Mínimo: ${formatMxn(minimo)}`,
    statusLine,
  ].join("\n");
}

const PENDING_KIND_LABELS: Record<string, string> = {
  price_approval: "Aprobación de precio",
  listing_description_review: "Revisión de descripción comercial",
  contract_data_review: "Datos contractuales faltantes",
  contract_review: "Revisión de contrato",
  contract_pending: "Revisión de contrato",
  titularidad_review: "Revisión de titularidad",
  comparables_search_expansion_decision: "Decisión sobre búsqueda de comparables",
  property_data_quality_review: "Revisión de datos de la propiedad",
  publication_approval: "Aprobación de publicación",
};

function humanizeKind(kind: string): string {
  return (
    PENDING_KIND_LABELS[kind] ??
    kind.replace(/_/g, " ").replace(/^\w/, (char) => char.toUpperCase())
  );
}

/** Read-only case status summary (never mutates state). */
export function formatCaseStatusQueryAnswer(params: {
  context: PendingCaseContext;
  pendingKinds: string[];
}): string {
  const { context, pendingKinds } = params;
  const lines: string[] = [];
  lines.push(
    context.caseTitle ? `Estado del caso «${context.caseTitle}»:` : "Estado del caso:"
  );
  const stepDisplay = context.caseStepLabel ?? context.caseStep;
  if (stepDisplay) {
    lines.push(
      context.caseStep && context.caseStepLabel && context.caseStep !== context.caseStepLabel
        ? `- Paso actual: ${context.caseStepLabel} (${context.caseStep})`
        : `- Paso actual: ${stepDisplay}`
    );
  }
  if (context.caseStatusLabel ?? context.caseStatus) {
    lines.push(`- Estado: ${context.caseStatusLabel ?? context.caseStatus}`);
  }
  const uniqueKinds = [...new Set(pendingKinds)];
  lines.push(
    uniqueKinds.length > 0
      ? `- Pendientes por decidir: ${uniqueKinds.map(humanizeKind).join(", ")}`
      : "- Pendientes por decidir: ninguno"
  );
  return lines.join("\n");
}
