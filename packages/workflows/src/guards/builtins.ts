import { registerGuard, type GuardInput, type GuardResult } from "./registry";

// Ports of the four hardcoded guard families (Slice 1.3). Originals stay in
// place in `operational-cases-adapters.ts` during the advisory window; they
// retire from their hardcoded call sites in S1.7+ after enforcement.

/**
 * Canonical list of publication context keys owned by the publication runner
 * and destination adapters. Source of truth moves here so both the runtime
 * adapter and the evaluator share one list (packages/agent imports it).
 * Mirrors `PUBLICATION_PROTECTED_CONTEXT_KEYS` in
 * packages/agent/src/operational-cases/publication-workflow.ts.
 */
export const WORKFLOW_PUBLICATION_PROTECTED_CONTEXT_KEYS = [
  "publication",
  "published",
  "publish_approvals",
  "photo_manifest",
  "e2e_control_status",
  "package_ready_lab_auto_continue_listing_id",
  "package_ready_machine_work_in_flight",
] as const;

function result(guard: string, pass: boolean, reason?: string): GuardResult {
  return pass ? { guard, pass } : { guard, pass, reason };
}

/**
 * Port of `blockedPropertyOptioningStepRegressionReason`: a proposal may not
 * move to a state ranked earlier than the current one. Rank comes from the
 * pinned graph's `states` order (equals PROPERTY_OPTIONING_STEP_ORDER for the
 * v1 property_optioning definition). Unknown steps pass (same as runtime).
 */
export function stepOrderNoRegression(input: GuardInput): GuardResult {
  const name = "step_order_no_regression";
  const { currentStep } = input.caseState;
  const toStep = input.proposal.toStep;
  if (!toStep || !currentStep) return result(name, true);
  const currentRank = input.stateOrder.indexOf(currentStep);
  const nextRank = input.stateOrder.indexOf(toStep);
  if (currentRank === -1 || nextRank === -1) return result(name, true);
  if (nextRank < currentRank) {
    return result(name, false, "step_regression_blocked");
  }
  return result(name, true);
}

/**
 * Port of `blockedAwaitingDocumentsTransitionReason`: leaving
 * awaiting_documents towards documents_received requires a recent
 * `external_response` case event. Known divergence D4 (§X.1): the
 * internal_user branch conflicts with this rule; ported as-is for v1 parity —
 * fixing it is an explicit v2 transitions decision, not a silent change.
 */
export function externalResponseExists(input: GuardInput): GuardResult {
  const name = "external_response_exists";
  const recent = input.facts.recentEventTypes ?? [];
  if (recent.includes("external_response")) return result(name, true);
  return result(name, false, "awaiting_documents_requires_external_response");
}

/**
 * Port of `containsProtectedPublicationKeys` rejection: a context patch may
 * not write publication-owned keys from a state proposal.
 */
export function publicationKeysProtected(input: GuardInput): GuardResult {
  const name = "publication_keys_protected";
  const keys = input.proposal.contextPatchKeys ?? [];
  const offending = keys.filter((key) =>
    (WORKFLOW_PUBLICATION_PROTECTED_CONTEXT_KEYS as readonly string[]).includes(key)
  );
  if (offending.length === 0) return result(name, true);
  return result(name, false, `protected_context_keys:${offending.join(",")}`);
}

/**
 * Port of the published/completed pairing rule: `current_step=published` and
 * `status=completed` are one atomic pair for property_optioning. The richer
 * summary gate (`canCompleteListingPublishedSummaryFromContext`) remains in
 * the adapter during advisory; this guard enforces the pairing shape only.
 */
export function completionPairing(input: GuardInput): GuardResult {
  const name = "completion_pairing";
  const toStep = input.proposal.toStep ?? input.caseState.currentStep;
  const toStatus = input.proposal.toStatus ?? input.caseState.status;
  const touchesPublished = input.proposal.toStep === "published";
  const touchesCompleted = input.proposal.toStatus === "completed";
  if (!touchesPublished && !touchesCompleted) return result(name, true);
  if (toStep === "published" && toStatus === "completed") return result(name, true);
  return result(
    name,
    false,
    "published_and_completed_must_pair"
  );
}

/**
 * Comparables advance threshold (§X.1 item 4): the runtime requires
 * `unique_comparable_count >= 3` (MIN_DEFENSIBLE_UNIQUE_COMPARABLES in
 * comparables-analysis.ts), not the flow's stated `usable_count > 0`.
 */
export const MIN_DEFENSIBLE_UNIQUE_COMPARABLES = 3;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function defensibleComparablesSample(input: GuardInput): GuardResult {
  const name = "defensible_comparables_sample";
  const context = input.facts.context ?? {};
  const analysis = isRecord(context.comparables_analysis)
    ? context.comparables_analysis
    : null;
  const dataQuality =
    analysis && isRecord(analysis.data_quality) ? analysis.data_quality : null;
  const uniqueCount =
    dataQuality && typeof dataQuality.unique_comparable_count === "number"
      ? dataQuality.unique_comparable_count
      : dataQuality && typeof dataQuality.usable_count === "number"
        ? dataQuality.usable_count
        : 0;
  if (uniqueCount >= MIN_DEFENSIBLE_UNIQUE_COMPARABLES) return result(name, true);
  return result(
    name,
    false,
    `insufficient_unique_comparables:${uniqueCount}<${MIN_DEFENSIBLE_UNIQUE_COMPARABLES}`
  );
}

let registered = false;

/** Idempotent registration of the built-in guards. */
export function registerBuiltinGuards(): void {
  if (registered) return;
  registered = true;
  registerGuard("step_order_no_regression", stepOrderNoRegression);
  registerGuard("external_response_exists", externalResponseExists);
  registerGuard("publication_keys_protected", publicationKeysProtected);
  registerGuard("completion_pairing", completionPairing);
  registerGuard("defensible_comparables_sample", defensibleComparablesSample);
}
