import assert from "node:assert/strict";
import {
  canFinalizePublicationClosure,
  shouldIdleFallbackSetWaitingInternal,
  shouldSendCorrectiveListingPublishedSummary,
} from "./publication-closure-recovery";

assert.equal(shouldSendCorrectiveListingPublishedSummary([]), false);

assert.equal(
  shouldSendCorrectiveListingPublishedSummary([
    { payload_jsonb: { kind: "listing_published_summary_sent" } },
  ]),
  false
);

assert.equal(
  shouldSendCorrectiveListingPublishedSummary([
    { payload_jsonb: { kind: "publication_closure_reopened" } },
  ]),
  true
);

assert.equal(
  shouldSendCorrectiveListingPublishedSummary([
    { payload_jsonb: { kind: "publication_closure_reopened" } },
    { payload_jsonb: { kind: "listing_published_summary_resent" } },
  ]),
  false
);

// --- canFinalizePublicationClosure ---

const finalizeBase = {
  idleReason: "all_destinations_resolved",
  allDestinationsResolved: true,
  machineWorkInFlight: false,
  hasInFlightLedgerOperation: false,
  completionOk: true,
  currentStep: "package_ready",
};

// Happy path from package_ready.
assert.equal(canFinalizePublicationClosure(finalizeBase).ok, true);

// Regression: agent advanced the step to `published` before the runner's
// idle pass. Closure must still finalize (used to be stuck as
// waiting_internal / published).
assert.equal(
  canFinalizePublicationClosure({ ...finalizeBase, currentStep: "published" })
    .ok,
  true
);

// Never finalize from earlier steps.
assert.equal(
  canFinalizePublicationClosure({ ...finalizeBase, currentStep: "contract_pending" })
    .ok,
  false
);
assert.equal(
  canFinalizePublicationClosure({ ...finalizeBase, currentStep: null }).ok,
  false
);

// Destination still pending → no close.
assert.equal(
  canFinalizePublicationClosure({
    ...finalizeBase,
    allDestinationsResolved: false,
  }).ok,
  false
);
assert.equal(
  canFinalizePublicationClosure({ ...finalizeBase, idleReason: "waiting_hitl" })
    .ok,
  false
);

// Work in flight → no close.
assert.equal(
  canFinalizePublicationClosure({ ...finalizeBase, machineWorkInFlight: true })
    .ok,
  false
);
assert.equal(
  canFinalizePublicationClosure({
    ...finalizeBase,
    hasInFlightLedgerOperation: true,
  }).ok,
  false
);

// Strict completion gate failed → no close.
assert.equal(
  canFinalizePublicationClosure({ ...finalizeBase, completionOk: false }).ok,
  false
);

// --- shouldIdleFallbackSetWaitingInternal ---

// Never downgrade an already-closed case back to waiting_internal.
assert.equal(
  shouldIdleFallbackSetWaitingInternal({
    status: "completed",
    currentStep: "published",
  }),
  false
);
// Open cases keep the existing waiting_internal behavior.
assert.equal(
  shouldIdleFallbackSetWaitingInternal({
    status: "active",
    currentStep: "package_ready",
  }),
  true
);
assert.equal(
  shouldIdleFallbackSetWaitingInternal({
    status: "waiting_internal",
    currentStep: "published",
  }),
  true
);

console.log("publication-closure-recovery.selftest: ok");
