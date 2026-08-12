import assert from "node:assert/strict";
import { authoringDiscoveryOutputSchema } from "@agents/workflows";
import {
  normalizeReusableSkillSlug,
  reusableSkillWriteDecision,
} from "./materialize-artifact";
import {
  buildReusableSkillCompilationContract,
  computeReusableSkillDiscoveryHash,
} from "./reusable-skill-compilation-contract";

assert.equal(normalizeReusableSkillSlug("owner_followup_message"), "owner-followup-message");
assert.equal(
  reusableSkillWriteDecision({
    existing: false,
    existingAuthoringSessionId: null,
    currentAuthoringSessionId: "session-new",
  }),
  "insert"
);
assert.equal(
  reusableSkillWriteDecision({
    existing: true,
    existingAuthoringSessionId: "session-current",
    currentAuthoringSessionId: "session-current",
  }),
  "update"
);
assert.equal(
  reusableSkillWriteDecision({
    existing: true,
    existingAuthoringSessionId: "session-old",
    currentAuthoringSessionId: "session-new",
  }),
  "conflict"
);
assert.equal(
  reusableSkillWriteDecision({
    existing: true,
    existingAuthoringSessionId: null,
    currentAuthoringSessionId: "session-new",
    overwriteExisting: true,
  }),
  "update"
);

const discovery = authoringDiscoveryOutputSchema.parse({
  provisional_kind: "reusable_skill",
  final_kind: "reusable_skill",
  skill_subtype: "simple",
  confidence: "high",
  rationale: ["Procedimiento reutilizable."],
  covered_dimensions: [
    {
      key: "objective",
      status: "covered",
      summary: "Resumir el documento adjunto.",
      evidence: [],
    },
  ],
  material_ambiguities: [],
  clarifying_questions: [],
  clarifying_question_details: [],
  assumptions: [],
  gaps: [],
  prior_gap_dispositions: [],
  requested_side_effects: [],
  capability_needs: [],
  input_requirements: [
    {
      kind: "runtime_input",
      key: "run_document",
      label: "Documento adjunto por ejecución",
      required: true,
      scope: "turn",
      resolve_at: "runtime",
      source_hint: "chat_attachment",
    },
  ],
  invocation_channels: [],
  source_strategy: {
    kind: "operator_supplied_at_runtime",
    label: "Documento de la ejecución",
    evidence: [
      {
        source: "description",
        quote: "documento adjunto por ejecución",
      },
    ],
  },
  readiness: "ready_for_confirmation",
  suggested_title: "Resumen documental",
  suggested_slug: "document-summary",
  understanding: {
    objective: "Resumir el documento adjunto de cada ejecución.",
    sources: ["Documento adjunto por ejecución"],
    actors: ["Operador"],
    decisions: [],
    effects: [],
    capabilities: [],
    acceptance_criteria: ["El resumen cita el documento de la ejecución."],
    assumptions: [],
    gaps: [],
  },
});
const discoveryHash = computeReusableSkillDiscoveryHash(discovery);
const contract = buildReusableSkillCompilationContract({
  discovery,
  discoveryHash,
  title: "Resumen documental",
  slug: "document-summary",
});
assert.equal(contract.discovery_hash, discoveryHash);
assert.equal(contract.input_contract.requirements[0]?.key, "run_document");
assert.deepEqual(contract.acceptance_criteria, [
  "El resumen cita el documento de la ejecución.",
]);
assert.throws(
  () =>
    buildReusableSkillCompilationContract({
      discovery,
      discoveryHash: `sha256:${"0".repeat(64)}`,
      title: "Resumen documental",
      slug: "document-summary",
    }),
  /hash does not match/
);

console.log("materialize-artifact.selftest: passed");
