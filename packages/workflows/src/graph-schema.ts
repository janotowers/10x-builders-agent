import { z } from "zod";
import type { WorkflowGraph } from "@agents/types";

// Zod schema for the §5.2 executable graph shape. Guards and postcondition
// checks are names resolved against the code registry — never inline code.

const proposerSchema = z.enum(["model", "decision_handler", "runtime"]);

const stateSchema = z.object({
  key: z.string().min(1),
  label: z.string().optional(),
  kind: z.enum(["operational", "terminal"]),
});

const transitionSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  guards: z.array(z.string().min(1)),
  authorized_proposers: z.array(proposerSchema).min(1),
  approval_required: z.string().nullable(),
});

const stepBindingSchema = z.object({
  state: z.string().min(1),
  skill: z.string().nullable(),
  bigquery_context: z.boolean().optional(),
});

const workTemplateSchema = z.object({
  on_enter_state: z.string().min(1),
  work_type: z.string().min(1),
  required_capability: z.string().optional(),
  depends_on: z.array(z.string()).optional(),
  verification_contract: z.record(z.string(), z.unknown()).optional(),
});

const postconditionSchema = z.object({
  state: z.string().min(1),
  checks: z.array(z.string().min(1)),
});

const approvalSchema = z.object({
  kind: z.string().min(1),
  evidence_inputs: z.array(z.string()),
});

const completionSchema = z.object({
  terminal_states: z.array(z.string().min(1)).min(1),
  required_evidence: z.array(z.string()),
});

export const workflowGraphSchema = z.object({
  states: z.array(stateSchema).min(1),
  transitions: z.array(transitionSchema),
  step_bindings: z.array(stepBindingSchema),
  work_templates: z.array(workTemplateSchema),
  postconditions: z.array(postconditionSchema),
  approvals: z.array(approvalSchema),
  impact_dependencies: z.record(z.string(), z.array(z.string())),
  completion: completionSchema,
});

export function parseWorkflowGraph(value: unknown): WorkflowGraph {
  return workflowGraphSchema.parse(value) as WorkflowGraph;
}

export type WorkflowGraphValidationIssue = {
  code:
    | "schema_invalid"
    | "unknown_state_reference"
    | "duplicate_state"
    | "cycle_detected"
    | "unreachable_state"
    | "dead_end_state"
    | "unknown_guard";
  detail: string;
};

/**
 * Structural validation gates (§5.4 subset for Phase 1): schema validity,
 * unique/known state references, acyclicity, reachability from the initial
 * state (first entry of `states`), no non-terminal dead ends, and — when a
 * registry is provided — every referenced guard registered.
 */
export function validateWorkflowGraph(
  value: unknown,
  options?: { knownGuards?: ReadonlySet<string> }
): { ok: boolean; graph: WorkflowGraph | null; issues: WorkflowGraphValidationIssue[] } {
  const issues: WorkflowGraphValidationIssue[] = [];
  const parsed = workflowGraphSchema.safeParse(value);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push({
        code: "schema_invalid",
        detail: `${issue.path.join(".") || "<root>"}: ${issue.message}`,
      });
    }
    return { ok: false, graph: null, issues };
  }
  const graph = parsed.data as WorkflowGraph;
  const stateKeys = graph.states.map((state) => state.key);
  const stateSet = new Set(stateKeys);
  if (stateSet.size !== stateKeys.length) {
    issues.push({ code: "duplicate_state", detail: "duplicate state keys" });
  }

  const referencedStates = [
    ...graph.transitions.flatMap((t) => [t.from, t.to]),
    ...graph.step_bindings.map((b) => b.state),
    ...graph.work_templates.map((w) => w.on_enter_state),
    ...graph.postconditions.map((p) => p.state),
    ...graph.completion.terminal_states,
  ];
  for (const key of referencedStates) {
    if (!stateSet.has(key)) {
      issues.push({
        code: "unknown_state_reference",
        detail: `state "${key}" referenced but not declared`,
      });
    }
  }

  // Cycle detection (DFS) over declared transitions.
  const adjacency = new Map<string, string[]>();
  for (const t of graph.transitions) {
    const list = adjacency.get(t.from) ?? [];
    list.push(t.to);
    adjacency.set(t.from, list);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const hasCycleFrom = (node: string): boolean => {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const next of adjacency.get(node) ?? []) {
      if (hasCycleFrom(next)) return true;
    }
    visiting.delete(node);
    visited.add(node);
    return false;
  };
  for (const key of stateKeys) {
    if (hasCycleFrom(key)) {
      issues.push({ code: "cycle_detected", detail: `cycle reachable from "${key}"` });
      break;
    }
  }

  // Reachability from the initial state.
  const initial = stateKeys[0];
  const reachable = new Set<string>([initial]);
  const queue = [initial];
  while (queue.length > 0) {
    const node = queue.shift() as string;
    for (const next of adjacency.get(node) ?? []) {
      if (!reachable.has(next)) {
        reachable.add(next);
        queue.push(next);
      }
    }
  }
  for (const key of stateKeys) {
    if (!reachable.has(key)) {
      issues.push({ code: "unreachable_state", detail: `state "${key}" unreachable from "${initial}"` });
    }
  }

  // Non-terminal states must have at least one outgoing transition.
  const terminalSet = new Set(graph.completion.terminal_states);
  for (const state of graph.states) {
    if (state.kind === "terminal" || terminalSet.has(state.key)) continue;
    if ((adjacency.get(state.key) ?? []).length === 0) {
      issues.push({ code: "dead_end_state", detail: `non-terminal state "${state.key}" has no outgoing transition` });
    }
  }

  if (options?.knownGuards) {
    for (const t of graph.transitions) {
      for (const guard of t.guards) {
        if (!options.knownGuards.has(guard)) {
          issues.push({ code: "unknown_guard", detail: `guard "${guard}" not registered` });
        }
      }
    }
  }

  return { ok: issues.length === 0, graph, issues };
}
