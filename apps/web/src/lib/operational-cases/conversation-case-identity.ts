import { shortOperationalCaseId } from "@agents/db";
import type { OperationalCase } from "@agents/types";

export interface ConversationCaseIdentity {
  caseTypeLabel: string;
  summary: string;
  technical: string;
  shortId: string;
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

export function buildConversationCaseIdentity(params: {
  opCase: OperationalCase;
  caseTypeDisplayName?: string | null;
}): ConversationCaseIdentity {
  const context = params.opCase.context_jsonb ?? {};
  const caseTypeLabel =
    params.caseTypeDisplayName?.trim() || params.opCase.case_type || "Caso operacional";
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
  };
}
