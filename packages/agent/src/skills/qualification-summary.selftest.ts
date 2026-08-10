import assert from "node:assert/strict";
import { summarizeSkillQualificationEvidence } from "./qualification-summary";

const summary = summarizeSkillQualificationEvidence({
  response: "Qualification completed.",
  toolCalls: ["lookup_property", "notify_user", "lookup_property"],
  appliedSkills: [
    { id: "shared-foundation", role: "included" },
    { id: "draft-under-test", role: "primary" },
  ],
  pendingConfirmation: null,
});

assert.deepEqual(summary.toolCalls.sequence, [
  "lookup_property",
  "notify_user",
  "lookup_property",
]);
assert.deepEqual(summary.toolCalls.unique, ["lookup_property", "notify_user"]);
assert.deepEqual(summary.toolCalls.counts, {
  lookup_property: 2,
  notify_user: 1,
});
assert.equal(summary.toolCalls.total, 3);
assert.deepEqual(summary.appliedSkillIds, [
  "shared-foundation",
  "draft-under-test",
]);
assert.deepEqual(summary.agentOutput, {
  text: "Qualification completed.",
  nonEmpty: true,
  characterCount: 24,
});
assert.equal(summary.pendingConfirmation, false);

const empty = summarizeSkillQualificationEvidence({
  response: "   ",
  toolCalls: ["", "  "],
  pendingConfirmation: { toolName: "dangerous_action" },
});
assert.equal(empty.toolCalls.total, 0);
assert.equal(empty.agentOutput.nonEmpty, false);
assert.equal(empty.pendingConfirmation, true);

console.log("skills/qualification-summary.selftest: ok");
