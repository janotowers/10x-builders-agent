import type {
  WorkflowGraph,
  WorkflowTransitionProposer,
} from "@agents/types";
import { registerBuiltinGuards } from "./guards/builtins";
import { getGuard, type GuardInput, type GuardResult } from "./guards/registry";

/**
 * TransitionEvaluator (Technical Plan §20): answers legal / illegal /
 * requires_approval for every proposed transition against the case's pinned
 * definition. Ships advisory-only (S1.4); enforcement flips per tenant (S1.7).
 */

export type TransitionProposal = {
  toStep?: string | null;
  toStatus?: string | null;
  proposer: WorkflowTransitionProposer;
  contextPatchKeys?: string[];
};

export type TransitionCaseState = {
  currentStep: string | null;
  status: string | null;
};

export type TransitionFacts = {
  context?: Record<string, unknown> | null;
  recentEventTypes?: string[];
};

export type TransitionVerdict = {
  verdict: "legal" | "illegal" | "requires_approval";
  guardResults: GuardResult[];
  /** Set when illegality does not come from a named guard. */
  reason?:
    | "undeclared_transition"
    | "unauthorized_proposer"
    | "unknown_guard"
    | "guard_failed";
  /** The declared transition consulted, when one matched. */
  transition?: { from: string; to: string } | null;
};

/** Guards evaluated on every proposal regardless of declared transitions. */
const GLOBAL_GUARDS = [
  "step_order_no_regression",
  "publication_keys_protected",
  "completion_pairing",
] as const;

export function evaluateTransition(params: {
  graph: WorkflowGraph;
  caseType: string | null;
  caseState: TransitionCaseState;
  proposal: TransitionProposal;
  facts?: TransitionFacts;
}): TransitionVerdict {
  registerBuiltinGuards();
  const { graph, caseType, caseState, proposal } = params;
  const facts = params.facts ?? {};
  const stateOrder = graph.states.map((state) => state.key);

  const guardInput: GuardInput = {
    caseType,
    caseState,
    proposal,
    facts,
    stateOrder,
  };

  const guardResults: GuardResult[] = [];
  const runGuard = (name: string): GuardResult => {
    const fn = getGuard(name);
    if (!fn) {
      const missing: GuardResult = {
        guard: name,
        pass: false,
        reason: "guard_not_registered",
      };
      guardResults.push(missing);
      return missing;
    }
    const result = fn(guardInput);
    guardResults.push(result);
    return result;
  };

  for (const name of GLOBAL_GUARDS) {
    runGuard(name);
  }

  const currentStep = caseState.currentStep;
  const toStep = proposal.toStep ?? null;
  const stepChanges = Boolean(toStep && toStep !== currentStep);

  let matched: { from: string; to: string } | null = null;
  if (stepChanges && toStep) {
    if (!currentStep) {
      // Case not yet stepped: entering the initial state is legal; anything
      // else is an undeclared entry (advisory data will show real usage).
      if (toStep !== stateOrder[0]) {
        return failure("undeclared_transition", guardResults, null);
      }
    } else {
      const transition = graph.transitions.find(
        (t) => t.from === currentStep && t.to === toStep
      );
      if (!transition) {
        return failure("undeclared_transition", guardResults, null);
      }
      matched = { from: transition.from, to: transition.to };
      if (!transition.authorized_proposers.includes(proposal.proposer)) {
        return failure("unauthorized_proposer", guardResults, matched);
      }
      for (const name of transition.guards) {
        runGuard(name);
      }
      const failedTransitionGuard = guardResults.some(
        (result) => !result.pass && result.reason === "guard_not_registered"
      );
      if (failedTransitionGuard) {
        return failure("unknown_guard", guardResults, matched);
      }
      if (transition.approval_required) {
        const failed = guardResults.some((result) => !result.pass);
        if (failed) return failure("guard_failed", guardResults, matched);
        return {
          verdict: "requires_approval",
          guardResults,
          transition: matched,
        };
      }
    }
  }

  const anyFailed = guardResults.some((result) => !result.pass);
  if (anyFailed) {
    const unknown = guardResults.some(
      (result) => result.reason === "guard_not_registered"
    );
    return failure(unknown ? "unknown_guard" : "guard_failed", guardResults, matched);
  }
  return { verdict: "legal", guardResults, transition: matched };
}

function failure(
  reason: NonNullable<TransitionVerdict["reason"]>,
  guardResults: GuardResult[],
  transition: { from: string; to: string } | null
): TransitionVerdict {
  return { verdict: "illegal", guardResults, reason, transition };
}
