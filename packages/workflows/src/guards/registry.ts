import type { WorkflowTransitionProposer } from "@agents/types";

/**
 * Guard registry (Technical Plan §5.2/§20): guards are pure functions over
 * the case snapshot, registered by name. Definitions reference names only,
 * so generated workflows can only compose vetted checks.
 */

export type GuardInput = {
  caseType: string | null;
  caseState: { currentStep: string | null; status: string | null };
  proposal: {
    toStep?: string | null;
    toStatus?: string | null;
    proposer: WorkflowTransitionProposer;
    /** Keys of a context patch accompanying the proposal, when any. */
    contextPatchKeys?: string[];
  };
  facts: {
    context?: Record<string, unknown> | null;
    recentEventTypes?: string[];
  };
  /** Declared state order from the pinned graph (`states` array order). */
  stateOrder: string[];
};

export type GuardResult = {
  guard: string;
  pass: boolean;
  reason?: string;
};

export type GuardFn = (input: GuardInput) => GuardResult;

const registry = new Map<string, GuardFn>();

export function registerGuard(name: string, fn: GuardFn): void {
  if (registry.has(name)) {
    throw new Error(`guard "${name}" already registered`);
  }
  registry.set(name, fn);
}

export function getGuard(name: string): GuardFn | null {
  return registry.get(name) ?? null;
}

export function registeredGuardNames(): Set<string> {
  return new Set(registry.keys());
}
