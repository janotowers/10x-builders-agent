import assert from "node:assert/strict";
import type { AccountSkill, WorkflowDefinition } from "@agents/types";
import {
  accountSkillProvenanceLabel,
  buildSkillUsageIndex,
  classifyAccountSkillProvenance,
  classifySkillProvenance,
  formatSkillStudioUsageLabel,
  formatSkillUsedBy,
  skillProvenanceLabel,
} from "./skill-provenance";
import { friendlyCaseTypeLabel } from "./workflow-studio/definition-catalog";

assert.equal(
  classifyAccountSkillProvenance({
    slug: "property-optioning-coach",
    globalSkillSlugs: ["property-optioning-coach"],
  }),
  "account_override"
);
assert.equal(
  classifyAccountSkillProvenance({
    slug: "my-studio-skill",
    globalSkillSlugs: ["property-optioning-coach"],
  }),
  "account_native"
);
assert.equal(
  classifySkillProvenance({
    slug: "property-optioning-coach",
    accountSkill: null,
    globalSkillSlugs: ["property-optioning-coach"],
  }),
  "global"
);
assert.equal(
  skillProvenanceLabel("global"),
  "Global de producto"
);
assert.equal(
  accountSkillProvenanceLabel("account_override"),
  "Personalizada (reemplaza la global de producto)"
);
assert.equal(
  accountSkillProvenanceLabel("account_native"),
  "Creada en Diseño"
);

const definition = {
  id: "d1",
  case_type: "property_optioning",
  graph_jsonb: {
    states: [{ key: "intake", label: "Intake" }],
    transitions: [],
    step_bindings: [
      { state: "intake", skill: "optioning-intake", required_assets: [] },
    ],
    work_templates: [],
    postconditions: [],
    approvals: [],
    impact_dependencies: {},
    completion: { terminal_states: [], required_evidence: [] },
  },
} as unknown as WorkflowDefinition;

const index = buildSkillUsageIndex({
  definitions: [definition],
  caseTypeRoots: [
    {
      caseType: "property_optioning",
      defaultSkillSlug: "property-optioning-coach",
    },
  ],
});
assert.ok(index.get("property-optioning-coach")?.roles.includes("root"));
assert.ok(index.get("optioning-intake")?.roles.includes("step"));
assert.equal(
  formatSkillUsedBy(index.get("property-optioning-coach"), friendlyCaseTypeLabel),
  "Usada por: Opcionamiento de propiedad"
);
assert.equal(
  formatSkillStudioUsageLabel(
    index.get("property-optioning-coach"),
    friendlyCaseTypeLabel
  ),
  "Skill raíz · Usada por: Opcionamiento de propiedad"
);
assert.equal(
  formatSkillStudioUsageLabel(
    index.get("optioning-intake"),
    friendlyCaseTypeLabel
  ),
  "Skill de paso · Usada por: Opcionamiento de propiedad"
);
assert.equal(
  formatSkillStudioUsageLabel(undefined, friendlyCaseTypeLabel),
  null,
  "skill sin vínculo a caso no inventa uso"
);

// Tipado mínimo de AccountSkill para classifySkillProvenance con override.
const accountSkill = {
  slug: "property-optioning-coach",
  metadata_jsonb: {},
} as AccountSkill;
assert.equal(
  classifySkillProvenance({
    slug: "property-optioning-coach",
    accountSkill,
    globalSkillSlugs: ["property-optioning-coach"],
  }),
  "account_override"
);

console.log("skill-provenance.selftest: ok");
