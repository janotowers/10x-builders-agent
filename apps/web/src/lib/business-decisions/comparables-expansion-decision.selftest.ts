import assert from "node:assert/strict";
import { parseComparablesExpansionDecision } from "./comparables-expansion-decision";

assert.equal(parseComparablesExpansionDecision("1"), "use_current_comparables");
assert.equal(
  parseComparablesExpansionDecision("usar avaclick como base"),
  "use_avaclick_primary"
);
assert.equal(parseComparablesExpansionDecision("ampliar busqueda"), "expand_search");
assert.equal(parseComparablesExpansionDecision("opcion 4 manual"), "manual_unavailable");
assert.equal(parseComparablesExpansionDecision("no entiendo"), "unclear");

console.log("comparables-expansion-decision.selftest.ts: ok");
