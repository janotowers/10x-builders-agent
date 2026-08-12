import assert from "node:assert/strict";
import {
  DEFAULT_STUDIO_ESCALATION_MODEL_ID,
  DEFAULT_STUDIO_PRIMARY_MODEL_ID,
  DEFAULT_WORKFLOW_OPERATIONAL_JUDGE_MODEL_ID,
  STUDIO_MODEL_TASKS,
  resolveStudioModelId,
  type StudioModelTask,
} from "./model";

const primaryMiniTasks: readonly StudioModelTask[] = [
  "authoring_router",
  "authoring_discovery",
  "case_workflow_compiler",
  "durable_task_compiler",
  "reusable_skill_compiler",
];

for (const task of primaryMiniTasks) {
  assert.equal(resolveStudioModelId(task, {}), DEFAULT_STUDIO_PRIMARY_MODEL_ID);
}

for (const task of ["skill_repair", "capability_coder"] as const) {
  assert.equal(
    resolveStudioModelId(task, {}),
    DEFAULT_STUDIO_ESCALATION_MODEL_ID
  );
}

assert.deepEqual(STUDIO_MODEL_TASKS, [
  "authoring_router",
  "authoring_discovery",
  "case_workflow_compiler",
  "durable_task_compiler",
  "reusable_skill_compiler",
  "skill_repair",
  "operational_judge",
  "capability_coder",
]);

assert.equal(
  resolveStudioModelId("authoring_router", {
    WORKFLOW_AUTHORING_ROUTER_MODEL_ID: " vendor/router ",
    WORKFLOW_COMPILER_MODEL_ID: "vendor/compiler",
  }),
  "vendor/router"
);
assert.equal(
  resolveStudioModelId("authoring_discovery", {
    WORKFLOW_AUTHORING_DISCOVERY_MODEL_ID: " ",
    WORKFLOW_COMPILER_MODEL_ID: " vendor/compiler ",
  }),
  "vendor/compiler"
);
assert.equal(
  resolveStudioModelId("case_workflow_compiler", {
    WORKFLOW_CASE_COMPILER_MODEL_ID: " vendor/case ",
    WORKFLOW_COMPILER_MODEL_ID: "vendor/compiler",
  }),
  "vendor/case"
);
assert.equal(
  resolveStudioModelId("durable_task_compiler", {
    WORKFLOW_DURABLE_TASK_COMPILER_MODEL_ID: " vendor/durable ",
  }),
  "vendor/durable"
);
assert.equal(
  resolveStudioModelId("reusable_skill_compiler", {
    WORKFLOW_AUTHORING_SKILL_MODEL_ID: " vendor/skill ",
  }),
  "vendor/skill"
);
assert.equal(
  resolveStudioModelId("skill_repair", {
    WORKFLOW_AUTHORING_SKILL_MODEL_ID: " vendor/legacy-skill ",
    WORKFLOW_AUTHORING_SKILL_REPAIR_MODEL_ID: " vendor/repair ",
    WORKFLOW_COMPILER_MODEL_ID: "vendor/compiler",
  }),
  "vendor/repair"
);
assert.equal(
  resolveStudioModelId("skill_repair", {
    WORKFLOW_AUTHORING_SKILL_REPAIR_MODEL_ID: " ",
    WORKFLOW_AUTHORING_SKILL_MODEL_ID: " vendor/legacy-skill ",
    WORKFLOW_COMPILER_MODEL_ID: "vendor/compiler",
  }),
  "vendor/legacy-skill"
);
assert.equal(
  resolveStudioModelId("capability_coder", {
    WORKFLOW_CAPABILITY_CODER_MODEL_ID: " ",
    WORKFLOW_COMPILER_MODEL_ID: "vendor/compiler",
  }),
  DEFAULT_STUDIO_ESCALATION_MODEL_ID
);

assert.equal(
  resolveStudioModelId(
    "authoring_discovery",
    {
      WORKFLOW_AUTHORING_DISCOVERY_ESCALATION_MODEL_ID: " vendor/discovery-high ",
      WORKFLOW_AUTHORING_ESCALATION_MODEL_ID: "vendor/shared-high",
    },
    "escalation"
  ),
  "vendor/discovery-high"
);
assert.equal(
  resolveStudioModelId(
    "case_workflow_compiler",
    {
      WORKFLOW_CASE_COMPILER_ESCALATION_MODEL_ID: " ",
      WORKFLOW_AUTHORING_ESCALATION_MODEL_ID: " vendor/shared-high ",
    },
    "escalation"
  ),
  "vendor/shared-high"
);
assert.equal(
  resolveStudioModelId("durable_task_compiler", {}, "escalation"),
  DEFAULT_STUDIO_ESCALATION_MODEL_ID
);

const judgeEnv = {
  WORKFLOW_OPERATIONAL_JUDGE_MODEL_ID: " ",
  WORKFLOW_COMPILER_MODEL_ID: " vendor/judge-fallback ",
  WORKFLOW_AUTHORING_ESCALATION_MODEL_ID: "vendor/shared-high",
};
assert.equal(
  resolveStudioModelId("operational_judge", judgeEnv, "primary"),
  "vendor/judge-fallback"
);
assert.equal(
  resolveStudioModelId("operational_judge", judgeEnv, "escalation"),
  "vendor/judge-fallback"
);
assert.equal(
  resolveStudioModelId("operational_judge", {}),
  DEFAULT_WORKFLOW_OPERATIONAL_JUDGE_MODEL_ID
);

console.log("model-studio-policy.selftest: ok");
