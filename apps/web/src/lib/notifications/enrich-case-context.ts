import type { OperationalCase } from "@agents/types";
import {
  operationalCaseDisplayTitle,
  operationalCaseStepLabel,
  OPERATIONAL_CASE_STATUS_LABELS,
} from "@/lib/operational-cases/instance-list-ui";

export type PendingCaseContext = {
  caseId: string | null;
  caseTitle: string | null;
  caseStep: string | null;
  caseStepLabel: string | null;
  caseStatus: string | null;
  caseStatusLabel: string | null;
};

export function caseContextFromOperationalCase(
  opCase: OperationalCase | null | undefined
): PendingCaseContext {
  if (!opCase) {
    return {
      caseId: null,
      caseTitle: null,
      caseStep: null,
      caseStepLabel: null,
      caseStatus: null,
      caseStatusLabel: null,
    };
  }
  return {
    caseId: opCase.id,
    caseTitle: operationalCaseDisplayTitle(opCase),
    caseStep: opCase.current_step ?? null,
    caseStepLabel: opCase.current_step
      ? operationalCaseStepLabel(opCase.current_step)
      : null,
    caseStatus: opCase.status,
    caseStatusLabel:
      OPERATIONAL_CASE_STATUS_LABELS[opCase.status] ?? opCase.status,
  };
}

export async function loadCaseContextMap(
  db: ReturnType<typeof import("@agents/db").createServerClient>,
  caseIds: string[]
): Promise<Map<string, PendingCaseContext>> {
  const uniqueIds = [...new Set(caseIds.filter((id) => id.length > 0))];
  const map = new Map<string, PendingCaseContext>();
  if (uniqueIds.length === 0) return map;

  const { data, error } = await db
    .from("operational_cases")
    .select("id, status, current_step, context_jsonb")
    .in("id", uniqueIds);
  if (error) {
    console.warn("[enrich-case-context] case lookup failed:", error);
    return map;
  }

  for (const row of data ?? []) {
    const opCase = row as OperationalCase;
    map.set(opCase.id, caseContextFromOperationalCase(opCase));
  }
  return map;
}

export function formatPendingCaseContextLine(context: PendingCaseContext): string | null {
  const parts: string[] = [];
  if (context.caseTitle) parts.push(`Caso: ${context.caseTitle}`);
  if (context.caseId) parts.push(`ID: ${context.caseId}`);
  if (context.caseStepLabel) parts.push(`Paso: ${context.caseStepLabel}`);
  if (context.caseStatusLabel) parts.push(`Estado: ${context.caseStatusLabel}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}
