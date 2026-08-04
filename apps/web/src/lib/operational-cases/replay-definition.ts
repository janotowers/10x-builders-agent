import {
  getOperationalCase,
  getPublishedDefinition,
  insertEvidenceRecord,
  type DbClient,
} from "@agents/db";
import type { OperationalCaseEvent } from "@agents/types";
import {
  replayCaseThroughDefinition,
  type ReplayResult,
} from "@agents/workflows";

/**
 * Slice 1.6-3: replays a case's full event stream through the production
 * transition evaluator against its pinned definition and asserts the
 * terminal step matches the case row. Each run persists an evidence record
 * pinned to the definition hash (Slice 1.5).
 */

export type CaseReplayOutcome = {
  caseId: string;
  definitionId: string;
  definitionVersion: number;
  definitionHash: string;
  result: ReplayResult;
  evidenceId: string | null;
};

async function listAllCaseEvents(
  db: DbClient,
  caseId: string
): Promise<OperationalCaseEvent[]> {
  const { data, error } = await db
    .from("operational_case_events")
    .select("*")
    .eq("case_id", caseId)
    .order("created_at", { ascending: true })
    .limit(2000);
  if (error) throw error;
  return (data ?? []) as OperationalCaseEvent[];
}

export async function replayDefinitionForCase(
  db: DbClient,
  caseId: string,
  options?: {
    recordEvidence?: boolean;
    /** Gate del evidence record; por defecto "historical_replay" (S1.6-3). Las corridas del lab usan "lab_run_replay". */
    gate?: string;
  }
): Promise<CaseReplayOutcome | null> {
  const opCase = await getOperationalCase(db, caseId);
  if (!opCase) return null;
  if (!opCase.workflow_definition_id || opCase.workflow_definition_version == null) {
    return null; // unpinned case: nothing to replay against
  }
  const definition = await getPublishedDefinition(
    db,
    opCase.workflow_definition_id,
    opCase.workflow_definition_version
  );
  if (!definition) return null;

  const events = await listAllCaseEvents(db, caseId);
  const result = replayCaseThroughDefinition({
    graph: definition.graph_jsonb,
    caseType: opCase.case_type,
    events,
    finalStep: opCase.current_step,
    finalContext:
      (opCase.context_jsonb as Record<string, unknown> | null) ?? {},
    // Ancla en el estado inicial del grafo (states[0], convención del
    // paquete): un caso sin transiciones grabadas que sigue en su estado
    // inicial replaya OK en vez de terminar en null y fallar en falso.
    initialStep: definition.graph_jsonb.states[0]?.key ?? null,
  });

  let evidenceId: string | null = null;
  if (options?.recordEvidence !== false) {
    const evidence = await insertEvidenceRecord(db, {
      userId: opCase.user_id,
      subjectKind: "workflow_definition",
      subjectId: definition.id,
      gate: options?.gate ?? "historical_replay",
      artifactHash: definition.definition_hash,
      result: result.ok && result.divergences.length === 0 ? "pass" : "fail",
      detail: {
        case_id: caseId,
        case_type: opCase.case_type,
        terminal_step: result.terminalStep,
        expected_terminal_step: result.expectedTerminalStep,
        terminal_match: result.ok,
        transition_count: result.transitions.length,
        divergence_count: result.divergences.length,
        unrecorded_gaps: result.unrecordedGaps,
        divergences: result.divergences.slice(0, 20),
      },
    });
    evidenceId = evidence.id;
  }

  return {
    caseId,
    definitionId: definition.id,
    definitionVersion: definition.version,
    definitionHash: definition.definition_hash,
    result,
    evidenceId,
  };
}

/** Replays the tenant's most recent pinned cases (driver for test:replay). */
export async function replayRecentCases(
  db: DbClient,
  params: { limit?: number; recordEvidence?: boolean }
): Promise<CaseReplayOutcome[]> {
  const { data, error } = await db
    .from("operational_cases")
    .select("id")
    .not("workflow_definition_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(Math.max(1, Math.min(params.limit ?? 20, 100)));
  if (error) throw error;
  const outcomes: CaseReplayOutcome[] = [];
  for (const row of data ?? []) {
    const outcome = await replayDefinitionForCase(db, row.id as string, {
      recordEvidence: params.recordEvidence,
    });
    if (outcome) outcomes.push(outcome);
  }
  return outcomes;
}
