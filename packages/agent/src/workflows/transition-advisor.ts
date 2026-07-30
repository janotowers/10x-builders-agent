import type { DbClient } from "@agents/db";
import {
  getPublishedDefinition,
  getWorkflowEnforcementMode,
  insertOperationalCaseEvent,
} from "@agents/db";
import type {
  OperationalCase,
  WorkflowDefinition,
  WorkflowEnforcementMode,
  WorkflowTransitionProposer,
} from "@agents/types";
import {
  createWorkflowDefinitionLoader,
  evaluateTransition,
  type TransitionVerdict,
} from "@agents/workflows";

/**
 * Slice 1.4: advisory wiring shared by the three proposal sites (model tool
 * adapter, decision handlers, runtime/cron transitions). Every proposed
 * transition is evaluated against the case's pinned definition; divergences
 * append a case event. Behavior only changes in "enforcing" mode (S1.7).
 */

export type CaseTransitionAdvice = {
  mode: WorkflowEnforcementMode;
  verdict: TransitionVerdict | null;
  definition: WorkflowDefinition | null;
  /** True when the caller must reject the proposal (enforcing + illegal). */
  reject: boolean;
};

const NO_ADVICE: CaseTransitionAdvice = {
  mode: "off",
  verdict: null,
  definition: null,
  reject: false,
};

// Published definitions are immutable → cache per (id, version) per process.
let loader: ReturnType<typeof createWorkflowDefinitionLoader> | null = null;
let loaderDb: DbClient | null = null;

function definitionLoader(db: DbClient) {
  if (!loader || loaderDb !== db) {
    loaderDb = db;
    loader = createWorkflowDefinitionLoader((definitionId, version) =>
      getPublishedDefinition(db, definitionId, version)
    );
  }
  return loader;
}

export async function adviseCaseTransition(params: {
  db: DbClient;
  opCase: Pick<
    OperationalCase,
    | "id"
    | "user_id"
    | "case_type"
    | "status"
    | "current_step"
    | "context_jsonb"
    | "workflow_definition_id"
    | "workflow_definition_version"
  >;
  proposal: {
    toStep?: string | null;
    toStatus?: string | null;
    proposer: WorkflowTransitionProposer;
    contextPatchKeys?: string[];
  };
  recentEventTypes?: string[];
  /** Site label for triage: adapter | decision_handler | runtime. */
  site: string;
}): Promise<CaseTransitionAdvice> {
  const { db, opCase, proposal } = params;
  try {
    if (
      !opCase.workflow_definition_id ||
      opCase.workflow_definition_version == null
    ) {
      return NO_ADVICE; // unpinned case (private type without definition)
    }
    const mode = await getWorkflowEnforcementMode(db, opCase.user_id);
    if (mode === "off") return NO_ADVICE;

    const definition = await definitionLoader(db)(
      opCase.workflow_definition_id,
      opCase.workflow_definition_version
    );
    if (!definition) return NO_ADVICE;

    const verdict = evaluateTransition({
      graph: definition.graph_jsonb,
      caseType: opCase.case_type,
      caseState: {
        currentStep: opCase.current_step,
        status: opCase.status,
      },
      proposal,
      facts: {
        context: opCase.context_jsonb ?? {},
        recentEventTypes: params.recentEventTypes ?? [],
      },
    });

    if (verdict.verdict !== "legal") {
      const rejecting = mode === "enforcing" && verdict.verdict === "illegal";
      // Closed event_type CHECK (finding 9): reuse state_changed +
      // payload.kind discriminator, matching the 0.4-6 pattern.
      await insertOperationalCaseEvent(db, {
        caseId: opCase.id,
        eventType: "state_changed",
        actor: "system",
        payload: {
          kind: rejecting ? "transition_rejected" : "transition_divergence",
          mode,
          site: params.site,
          verdict: verdict.verdict,
          reason: verdict.reason ?? null,
          failed_guards: verdict.guardResults
            .filter((g) => !g.pass)
            .map((g) => ({ guard: g.guard, reason: g.reason ?? null })),
          from_step: opCase.current_step,
          to_step: proposal.toStep ?? null,
          to_status: proposal.toStatus ?? null,
          proposer: proposal.proposer,
          definition_id: definition.id,
          definition_version: definition.version,
          definition_hash: definition.definition_hash,
        },
      });
    }

    return {
      mode,
      verdict,
      definition,
      reject: mode === "enforcing" && verdict.verdict === "illegal",
    };
  } catch (error) {
    // Advisory evaluation must never break the proposal path.
    console.error(
      `[workflow-advisor] evaluation failed case=${opCase.id} site=${params.site}:`,
      error instanceof Error ? error.message : error
    );
    return NO_ADVICE;
  }
}
