import assert from "node:assert/strict";
import type {
  AccountSkill,
  DurableTask,
  WorkflowDefinition,
} from "@agents/types";
import { buildStudioInventory } from "./studio-inventory";

function def(
  overrides: Partial<WorkflowDefinition> &
    Pick<WorkflowDefinition, "id" | "case_type" | "version" | "status">
): WorkflowDefinition {
  return {
    owner_scope: "user",
    user_id: "user-1",
    organization_id: null,
    workflow_key: overrides.case_type,
    industry: null,
    domain_tags: [],
    business_spec_jsonb: {},
    implementation_spec_jsonb: {},
    graph_jsonb: {
      states: [],
      transitions: [],
      step_bindings: [],
      work_templates: [],
      postconditions: [],
      approvals: [],
      impact_dependencies: {},
      completion: { terminal_states: [], required_evidence: [] },
    },
    definition_hash: `hash-${overrides.id}`,
    derived_from_definition_id: null,
    derived_from_version: null,
    visibility: "private",
    published_at: overrides.status === "published" ? "2026-08-01T00:00:00Z" : null,
    published_by: null,
    provenance_jsonb: {},
    created_at: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

function durable(
  overrides: Partial<DurableTask> & Pick<DurableTask, "id" | "title">
): DurableTask {
  return {
    user_id: "user-1",
    objective: "Objetivo de prueba",
    status: "active",
    retention_policy_jsonb: {},
    input_contract_jsonb: {},
    spec_jsonb: {},
    acceptance_criteria_jsonb: [],
    work_templates_jsonb: [],
    result_contract_jsonb: {},
    result_jsonb: null,
    schedule_ref: null,
    provenance_jsonb: {},
    version: 1,
    created_at: "2026-08-02T00:00:00Z",
    updated_at: "2026-08-02T00:00:00Z",
    ...overrides,
  };
}

function skill(
  overrides: Partial<AccountSkill> & Pick<AccountSkill, "id" | "slug">
): AccountSkill {
  return {
    user_id: "user-1",
    body_md: "---\nname: x\n---\n",
    status: "active",
    version: 1,
    metadata_jsonb: {},
    created_at: "2026-08-03T00:00:00Z",
    updated_at: "2026-08-03T00:00:00Z",
    ...overrides,
  } as AccountSkill;
}

const v5 = def({
  id: "priv-5",
  case_type: "property_optioning",
  version: 5,
  status: "published",
});
const v2 = def({
  id: "priv-2",
  case_type: "property_optioning",
  version: 2,
  status: "published",
});
const draft = def({
  id: "priv-6",
  case_type: "property_optioning",
  version: 6,
  status: "draft",
});

const scheduledDurable = durable({
  id: "dt-sched",
  title: "Reporte semanal",
  schedule_ref: "sched-1",
});
const freeDurable = durable({
  id: "dt-free",
  title: "Una sola vez",
});

const cards = buildStudioInventory({
  ownDefinitions: [v5, v2, draft],
  durableTasks: [scheduledDurable, freeDurable],
  accountSkills: [
    skill({
      id: "sk-1",
      slug: "property-optioning-coach",
      metadata_jsonb: { display_title: "Coach" },
    }),
    skill({
      id: "sk-2",
      slug: "my-custom-skill",
      metadata_jsonb: { display_title: "Custom", skill_subtype: "simple" },
    }),
  ],
  scheduledTasks: [
    {
      id: "sched-1",
      display_title: "Lunes 9am",
      cron_expr: "0 9 * * 1",
      timezone: "America/Mexico_City",
      status: "active",
      durable_task_id: "dt-sched",
      updated_at: "2026-08-04T00:00:00Z",
    },
  ],
  globalSkillSlugs: ["property-optioning-coach"],
  showTests: false,
});

const workflowCards = cards.filter((card) => card.kind === "case_workflow");
assert.equal(workflowCards.length, 1, "una tarjeta por familia");
assert.equal(workflowCards[0]!.id, "priv-5", "cabeza = vigente publicada");
assert.match(workflowCards[0]!.statusLabel, /Vigente/);
assert.match(workflowCards[0]!.subtitle, /1 histórica/);

const durableCards = cards.filter((card) => card.kind === "durable_task");
assert.equal(
  durableCards.length,
  1,
  "durable con schedule se deduplica"
);
assert.equal(durableCards[0]!.id, "dt-free");

const scheduleCards = cards.filter((card) => card.kind === "schedule");
assert.equal(scheduleCards.length, 1);
assert.match(scheduleCards[0]!.href, /durable_task=dt-sched/);
assert.match(scheduleCards[0]!.href, /schedule=sched-1/);

const skillCards = cards.filter((card) => card.kind === "reusable_skill");
assert.equal(skillCards.length, 2);
const override = skillCards.find((card) => card.id === "sk-1");
const native = skillCards.find((card) => card.id === "sk-2");
assert.ok(override);
assert.equal(override.provenanceKind, "account_override");
assert.match(override.provenanceLabel ?? "", /Personalizada/);
assert.match(override.href, /account_skill=property-optioning-coach/);
assert.ok(native);
assert.equal(native.provenanceKind, "account_native");
assert.match(native.provenanceLabel ?? "", /Creada en Diseño/);

console.log("studio-inventory.selftest: ok");
