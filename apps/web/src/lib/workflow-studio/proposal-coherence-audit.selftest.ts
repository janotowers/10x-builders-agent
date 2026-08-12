import assert from "node:assert/strict";
import { authoringDiscoveryOutputSchema } from "@agents/workflows";
import {
  auditAndFinalizeAuthoringProposal,
  buildProposalCoherenceAuditPrompt,
} from "./proposal-coherence-audit";

const discovery = authoringDiscoveryOutputSchema.parse({
  provisional_kind: "reusable_skill",
  final_kind: "reusable_skill",
  skill_subtype: "simple",
  confidence: "high",
  rationale: ["Es una capacidad reusable."],
  covered_dimensions: [
    {
      key: "objective",
      status: "covered",
      summary: "Seguimiento a propietarios.",
      evidence: [
        {
          source: "description",
          quote: "mensaje de seguimiento",
        },
      ],
    },
  ],
  material_ambiguities: [],
  clarifying_questions: [],
  clarifying_question_details: [],
  assumptions: ["Solo se necesita un borrador, no un envío automático."],
  gaps: [],
  requested_side_effects: ["send_message", "human_approval"],
  capability_needs: [
    {
      category_id: "user_email",
      category_label: "Correo de usuario",
      provider_id: "gmail",
      provider_name: "Gmail / Google Workspace",
      status: "connected",
      resolution: "assumed_connected",
      capabilities: ["send"],
      connect_href: null,
    },
  ],
  input_requirements: [
    {
      kind: "runtime_input",
      key: "source_document",
      label: "Documento con el último acuerdo",
      source_hint: "chat_attachment",
    },
    {
      kind: "human_input",
      key: "recipient_email",
      label: "Email del propietario",
    },
    {
      kind: "human_input",
      key: "approved_content",
      label: "Contenido final aprobado",
    },
  ],
  invocation_channels: [],
  outbound_contract: {
    recipient_strategy: {
      kind: "operator_supplied_at_runtime",
      address_type: "email",
      label: "Email del propietario",
      source_ref: {
        type: "input_requirement",
        key: "recipient_email",
      },
      evidence: [
        {
          source: "answer",
          answer_index: 0,
          quote: "email del propietario",
        },
      ],
    },
    approval: {
      approver: "usuario inmobiliario",
      scope: ["recipient", "content"],
      evidence: [
        {
          source: "answer",
          answer_index: 0,
          quote: "aprueba destinatario y contenido",
        },
      ],
    },
    delivery: {
      mode: "after_approval",
      evidence: [
        {
          source: "answer",
          answer_index: 0,
          quote: "enviar después de aprobación",
        },
      ],
    },
  },
  readiness: "ready_for_confirmation",
  suggested_title: "Seguimiento a propietarios",
  suggested_slug: "owner_followup_message",
  understanding: {
    objective: "Redactar mensajes de seguimiento para propietarios.",
    sources: [
      "Documento con el último acuerdo.",
      "Email del propietario aportado en cada ejecución.",
    ],
    actors: [
      "Gu redacta el mensaje.",
      "Gu redacta el borrador y ejecuta el envío.",
    ],
    decisions: ["No usar para compradores."],
    effects: ["Preparar un borrador.", "Enviar el email."],
    capabilities: ["Gmail"],
    acceptance_criteria: [],
    assumptions: ["Solo se necesita un borrador, no un envío automático."],
    gaps: [],
  },
});

async function main(): Promise<void> {
const prompt = buildProposalCoherenceAuditPrompt({
  description: "Prepara un mensaje de seguimiento.",
  answers: ["email del propietario; enviar después de aprobación"],
  discovery,
});
assert.match(prompt, /recipient email\/contact is a runtime input/i);
assert.match(prompt, /Applicability limits/i);

const corrected = await auditAndFinalizeAuthoringProposal({
  discovery,
  description: "Prepara un mensaje de seguimiento.",
  answers: ["email del propietario; enviar después de aprobación"],
  env: {
    WORKFLOW_AUTHORING_PROPOSAL_AUDIT_MODEL_ID: "test/auditor",
  },
  model: {
    async audit() {
      return {
        coherent: false,
        issues: ["La propuesta mezcla entradas y decisiones."],
        corrections: {
          objective:
            "Redactar y enviar el seguimiento después de la aprobación del usuario.",
          sources: ["Documento con el último acuerdo."],
          actors: [
            "Gu redacta y envía el mensaje.",
            "El usuario inmobiliario aporta datos y aprueba el envío.",
          ],
          decisions: [
            "El usuario confirma el destinatario y el contenido final.",
          ],
          acceptance_criteria: [
            "Usar solo para propietarios representados; no para compradores.",
          ],
          assumptions: ["El documento se aporta en cada ejecución."],
          input_reclassifications: [
            {
              key: "approved_content",
              action: "drop_not_an_input",
            },
          ],
        },
      };
    },
  },
});
assert.equal(corrected.audit.applied, true);
assert.equal(corrected.audit.model_id, "test/auditor");
assert.match(corrected.discovery.understanding.objective, /enviar/i);
assert.deepEqual(corrected.discovery.understanding.sources, [
  "Documento con el último acuerdo.",
]);
assert.equal(
  corrected.discovery.input_requirements.some(
    (requirement) => requirement.key === "approved_content"
  ),
  false
);
assert.equal(
  corrected.discovery.input_requirements.some(
    (requirement) => requirement.key === "recipient_email"
  ),
  true
);

const protectedInput = await auditAndFinalizeAuthoringProposal({
  discovery,
  description: "Prepara un mensaje de seguimiento.",
  answers: [],
  env: {
    WORKFLOW_AUTHORING_PROPOSAL_AUDIT_MODEL_ID: "test/auditor",
  },
  model: {
    async audit() {
      return {
        coherent: false,
        issues: ["Intento inseguro."],
        corrections: {
          input_reclassifications: [
            {
              key: "recipient_email",
              action: "drop_not_an_input",
            },
          ],
        },
      };
    },
  },
});
assert.equal(
  protectedInput.discovery.input_requirements.some(
    (requirement) => requirement.key === "recipient_email"
  ),
  true
);
assert.equal(
  protectedInput.audit.quality_warnings[0]?.code,
  "proposal_audit_corrections_rejected"
);

const invalid = await auditAndFinalizeAuthoringProposal({
  discovery,
  description: "Prepara un mensaje de seguimiento.",
  answers: [],
  env: {
    WORKFLOW_AUTHORING_PROPOSAL_AUDIT_MODEL_ID: "test/auditor",
  },
  model: {
    async audit() {
      return { coherent: "yes" };
    },
  },
});
assert.equal(invalid.discovery, discovery);
assert.equal(
  invalid.audit.quality_warnings[0]?.code,
  "proposal_audit_invalid_response"
);

console.log("proposal-coherence-audit.selftest: all checks passed");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
