import assert from "node:assert/strict";
import {
  statusFilterLooksApplied,
  statusFilterTraceToken,
} from "./steps.mjs";

/**
 * Lightweight fixture page stub for status-filter verification logic.
 * Avoids launching Playwright; only exercises the evaluate() contract.
 */
function makePageStub(evaluateResult) {
  return {
    async evaluate() {
      return evaluateResult;
    },
  };
}

{
  const page = makePageStub({
    selectedCandidates: ["solo cerradas"],
    chipCandidates: [],
  });
  const result = await statusFilterLooksApplied(page);
  assert.equal(result.verified, true);
  assert.equal(result.selected_label, "Solo cerradas");
}

{
  const page = makePageStub({
    selectedCandidates: [],
    chipCandidates: ["solo cerradas"],
  });
  const result = await statusFilterLooksApplied(page);
  assert.equal(result.verified, true);
}

{
  const page = makePageStub({
    selectedCandidates: [],
    chipCandidates: ["estatus", "activas"],
  });
  const result = await statusFilterLooksApplied(page);
  assert.equal(result.verified, false);
  assert.equal(result.selected_label, null);
}

{
  // Presence of the label alone in body text is NOT enough — evaluate only
  // returns selected/chip candidates, so empty arrays remain unverified.
  const page = makePageStub({
    selectedCandidates: [],
    chipCandidates: [],
  });
  const result = await statusFilterLooksApplied(page);
  assert.equal(result.verified, false);
}

assert.equal(
  statusFilterTraceToken({
    requested: true,
    verified: true,
    selected_label: "Solo cerradas",
  }),
  "status:Solo cerradas"
);
assert.equal(
  statusFilterTraceToken({
    requested: true,
    verified: false,
    selected_label: null,
  }),
  "status:unverified"
);
assert.equal(
  statusFilterTraceToken({
    requested: false,
    verified: false,
  }),
  null
);
// Final-state derivation: an early unverified snapshot must not stick if
// the later status_filter is verified.
assert.equal(
  statusFilterTraceToken({
    requested: true,
    verified: true,
    selected_label: "Solo cerradas",
    applied: true,
  }),
  "status:Solo cerradas"
);

console.log("status-filter.selftest: ok");
