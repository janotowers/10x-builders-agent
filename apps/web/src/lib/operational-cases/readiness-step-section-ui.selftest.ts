import assert from "node:assert/strict";
import {
  listUntestedReadinessToolIdsForStep,
  readinessTestShowActionRowStatusPill,
  skillN1Progress,
  skillTestSectionCollapseWhenAlreadyProven,
  skillTestSectionDefaultOpen,
  skillTestSectionState,
  skillTestSectionSummary,
  stepTestSectionCollapseWhenAlreadyProven,
  stepTestSectionDefaultOpen,
  stepTestSectionState,
  stepTestSectionSummary,
} from "./readiness-step-section-ui";

const skillBlocked = {
  test_status: "blocked_by_tools" as const,
  skill_tools: [
    { tool_id: "easybroker_search_listings", test_status: "tested_ok" },
    { tool_id: "easybroker_search_closed_deals", test_status: "ready_untested" },
  ],
};

assert.equal(skillTestSectionState(skillBlocked), "collapsedLocked");
assert.equal(skillTestSectionDefaultOpen(skillBlocked), false);

const progress = skillN1Progress(skillBlocked);
assert.equal(progress.total, 2);
assert.equal(progress.testedOk, 1);
assert.equal(progress.pendingIds.length, 1);

assert.match(skillTestSectionSummary(skillBlocked), /Integraciones 1\/2/);

const skillDone = {
  test_status: "tested_ok" as const,
  skill_tools: [],
};
assert.equal(skillTestSectionDefaultOpen(skillDone), false);
assert.equal(skillTestSectionSummary(skillDone), "Completada");
assert.ok(!skillTestSectionSummary(skillDone).includes("abrir"));
assert.equal(readinessTestShowActionRowStatusPill("tested_ok"), false);
assert.equal(readinessTestShowActionRowStatusPill("ready_to_test"), true);
assert.equal(readinessTestShowActionRowStatusPill("awaiting_n4"), true);

const stepDone = {
  test_status: "tested_ok" as const,
  step_skills: [skillDone],
  step_test_progress: { scenarios_total: 1, scenarios_passed: 1 },
};
assert.equal(stepTestSectionDefaultOpen(stepDone), false);
assert.equal(
  stepTestSectionSummary(stepDone),
  "1/1 escenarios probados"
);

const stepFailed = {
  test_status: "tested_failed" as const,
  step_skills: [],
};
assert.equal(stepTestSectionDefaultOpen(stepFailed), true);
assert.ok(!stepTestSectionSummary(stepDone).includes("abrir"));

const skillReady = {
  test_status: "ready_to_test" as const,
  skill_tools: [{ tool_id: "notify_user", test_status: "tested_ok" }],
};
assert.equal(skillTestSectionState(skillReady), "expandedReady");
assert.equal(skillTestSectionDefaultOpen(skillReady), true);

const skillFailed = {
  test_status: "tested_failed" as const,
  skill_tools: [],
};
assert.equal(skillTestSectionDefaultOpen(skillFailed), true);

assert.equal(
  skillTestSectionCollapseWhenAlreadyProven(undefined, "tested_ok"),
  true
);
assert.equal(
  skillTestSectionCollapseWhenAlreadyProven("ready_to_test", "tested_ok"),
  false
);
assert.equal(
  stepTestSectionCollapseWhenAlreadyProven("awaiting_n4", "tested_ok"),
  false
);

const stepBlocked = {
  test_status: "blocked" as const,
  step_skills: [skillBlocked],
  step_tools: [],
};
assert.equal(stepTestSectionState(stepBlocked), "collapsedLocked");
assert.ok(listUntestedReadinessToolIdsForStep(stepBlocked).length >= 1);

console.log("readiness-step-section-ui.selftest: ok");
