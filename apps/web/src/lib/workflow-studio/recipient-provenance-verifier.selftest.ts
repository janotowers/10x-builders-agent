import assert from "node:assert/strict";
import type {
  AuthoringDiscoveryOutput,
  AuthoringOutboundContract,
} from "@agents/workflows";
import {
  adjudicatePendingRecipientResolution,
  buildRecipientResolutionAdjudicationPrompt,
  buildRecipientProvenanceVerifierPrompt,
  fingerprintRecipientStrategy,
  resolveRecipientProvenanceVerifierModelId,
  reviewRecipientProvenance,
} from "./recipient-provenance-verifier";

const description =
  "Preparar un seguimiento y entregarlo después de aprobación.";
const explicitAnswer =
  "En cada ejecución la persona operadora proporcionará la dirección concreta en la conversación.";
const conditionalAnswer =
  "Cuando el dato no esté disponible, se solicitará a la persona operadora antes de continuar.";

function discoveryFor(params: {
  quote: string;
  addressType?: "email" | "phone" | "chat_id" | "other";
  sourceRef?: AuthoringOutboundContract["recipient_strategy"]["source_ref"];
}): Pick<
  AuthoringDiscoveryOutput,
  "outbound_contract" | "input_requirements" | "capability_needs"
> {
  const sourceRef = params.sourceRef ?? {
    type: "input_requirement" as const,
    key: "recipient_address",
  };
  return {
    outbound_contract: {
      recipient_strategy: {
        kind:
          sourceRef.type === "capability"
            ? "external_lookup"
            : "operator_supplied_at_runtime",
        address_type: params.addressType ?? "email",
        label: "Dirección del destinatario",
        source_ref: sourceRef,
        evidence: [
          {
            source: "answer",
            answer_index: 0,
            quote: params.quote,
          },
        ],
      },
      approval: {
        approver: null,
        scope: [],
        evidence: [],
      },
      delivery: {
        mode: "after_approval",
        evidence: [
          {
            source: "description",
            quote: "después de aprobación",
          },
        ],
      },
    },
    input_requirements:
      sourceRef.type === "input_requirement"
        ? [
            {
              kind: "runtime_input",
              key: sourceRef.key,
              label: "Dirección del destinatario",
              required: true,
              scope: "turn",
              resolve_at: "run_start",
              source_hint: "conversation_input",
              retention: "run",
            },
          ]
        : [],
    capability_needs:
      sourceRef.type === "capability"
        ? [
            {
              category_id: sourceRef.key,
              category_label: "Directorio",
              provider_id: sourceRef.key,
              provider_name: "Directorio conectado",
              status: "connected",
              resolution: "assumed_connected",
              capabilities: ["read", "search"],
              connect_href: null,
            },
          ]
        : [],
  };
}

const testEnv = {
  WORKFLOW_AUTHORING_RECIPIENT_PROVENANCE_MODEL_ID: "test/semantic-verifier",
};

async function acceptsEntailedParaphrases(): Promise<void> {
  for (const [answer, addressType] of [
    [explicitAnswer, "email"],
    [conditionalAnswer, "phone"],
  ] as const) {
    const discovery = discoveryFor({ quote: answer, addressType });
    const result = await reviewRecipientProvenance({
      description,
      answers: [answer],
      discovery,
      env: testEnv,
      model: {
        async verify() {
          return {
            verdict: "entailed",
            reason: "La evidencia implica el mecanismo de adquisición.",
            evidence_quote: answer,
          };
        },
      },
    });
    assert.equal(result.verdict, "entailed");
    assert.equal(result.evidence_quote, answer);
    assert.equal(result.call_count, 1);
  }
}

async function rejectsUnsupportedClaimWithoutPatching(): Promise<void> {
  const answer = "La entrega se realizará por el canal elegido.";
  const result = await reviewRecipientProvenance({
    description,
    answers: [answer],
    discovery: discoveryFor({ quote: answer, addressType: "chat_id" }),
    env: testEnv,
    model: {
      async verify() {
        return {
          verdict: "insufficient",
          reason: "La evidencia no implica una fuente para la dirección.",
          evidence_quote: null,
        };
      },
    },
  });
  assert.equal(result.verdict, "insufficient");
  assert.equal(result.evidence_quote, null);
}

async function rejectsFabricatedEvidence(): Promise<void> {
  const result = await reviewRecipientProvenance({
    description,
    answers: [explicitAnswer],
    discovery: discoveryFor({ quote: explicitAnswer }),
    env: testEnv,
    model: {
      async verify() {
        return {
          verdict: "entailed",
          reason: "Supuestamente sustentado.",
          evidence_quote: "una cita que no existe",
        };
      },
    },
  });
  assert.equal(result.verdict, "unavailable");
  assert.equal(result.warning_code, "recipient_provenance_invalid_response");
}

async function handlesUnavailableAndDisabled(): Promise<void> {
  const discovery = discoveryFor({ quote: explicitAnswer });
  const unavailable = await reviewRecipientProvenance({
    description,
    answers: [explicitAnswer],
    discovery,
    env: testEnv,
    model: {
      async verify() {
        throw new Error("transport down");
      },
    },
  });
  assert.equal(unavailable.verdict, "unavailable");
  assert.equal(unavailable.warning_code, "recipient_provenance_unavailable");

  const timedOut = await reviewRecipientProvenance({
    description,
    answers: [explicitAnswer],
    discovery,
    env: testEnv,
    timeoutMs: 5,
    model: {
      async verify(_prompt, signal) {
        return await new Promise((_, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true }
          );
        });
      },
    },
  });
  assert.equal(timedOut.verdict, "unavailable");
  assert.equal(timedOut.warning_code, "recipient_provenance_unavailable");

  let calls = 0;
  const waived = await reviewRecipientProvenance({
    description,
    answers: [explicitAnswer],
    discovery,
    env: {
      ...testEnv,
      WORKFLOW_AUTHORING_RECIPIENT_PROVENANCE_DISABLED: "true",
    },
    model: {
      async verify() {
        calls += 1;
        return {};
      },
    },
  });
  assert.equal(waived.verdict, "waived");
  assert.equal(waived.call_count, 0);
  assert.equal(calls, 0);
}

function validatesFingerprintAndPromptBoundary(): void {
  const left = discoveryFor({ quote: explicitAnswer });
  const right = discoveryFor({ quote: explicitAnswer });
  right.outbound_contract!.recipient_strategy.evidence.reverse();
  assert.equal(
    fingerprintRecipientStrategy(
      left.outbound_contract!.recipient_strategy
    ),
    fingerprintRecipientStrategy(
      right.outbound_contract!.recipient_strategy
    )
  );
  const prompt = buildRecipientProvenanceVerifierPrompt({
    description,
    answers: [explicitAnswer],
    discovery: left,
  });
  assert.match(prompt, /semantic entailment/i);
  assert.match(prompt, /mechanism or authoritative source/i);
  assert.doesNotMatch(prompt, /if Gu does not have it|send by email/i);
  assert.equal(
    resolveRecipientProvenanceVerifierModelId(testEnv),
    "test/semantic-verifier"
  );
}

async function supportsCapabilityBackedAddressTypes(): Promise<void> {
  const answer =
    "La dirección se obtiene desde el registro conectado indicado en la configuración.";
  const discovery = discoveryFor({
    quote: answer,
    addressType: "other",
    sourceRef: { type: "capability", key: "business_directory" },
  });
  const result = await reviewRecipientProvenance({
    description,
    answers: [answer],
    discovery,
    env: testEnv,
    model: {
      async verify() {
        return {
          verdict: "entailed",
          reason: "La evidencia implica una fuente autoritativa conectada.",
          evidence_quote: answer,
        };
      },
    },
  });
  assert.equal(result.verdict, "entailed");
}

async function adjudicatesPendingCanonicalClaim(): Promise<void> {
  const answer =
    "Ah, el email del propietario se lo tendrá que pedir Gu al usuario antes del envío si no lo tuviese.";
  const quote =
    "el email del propietario se lo tendrá que pedir Gu al usuario antes del envío si no lo tuviese";
  let calls = 0;
  const result = await adjudicatePendingRecipientResolution({
    gap: {
      id: "gap_1234abcd",
      summary: "Falta el origen del email del destinatario.",
      question:
        "¿Cómo recibirá Gu el email o contacto del destinatario cada vez?",
    },
    latestAnswer: answer,
    latestAnswerIndex: 2,
    inputRequirements: [],
    capabilityNeeds: [],
    env: testEnv,
    model: {
      async verify() {
        calls += 1;
        return {
          verdict: "entailed",
          reason: "La condición establece provisión humana en ejecución.",
          strategy: {
            kind: "operator_supplied_at_runtime",
            address_type: "email",
            label: "Email del propietario",
            source_ref: {
              type: "input_requirement",
              key: "recipient_address",
            },
            evidence_quote: quote,
          },
        };
      },
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.verdict, "entailed");
  assert.equal(result.strategy?.kind, "operator_supplied_at_runtime");
  assert.deepEqual(result.strategy?.source_ref, {
    type: "input_requirement",
    key: "recipient_address",
  });
  assert.equal(result.strategy?.evidence[0]?.answer_index, 2);
  assert.equal(result.evidence_quote, quote);

  const directAnswer =
    "El usuario le tiene que dar la dirección de email directamente, así que Gu se la tendría que pedir si no la recibe antes.";
  const direct = await adjudicatePendingRecipientResolution({
    gap: {
      id: "gap_1234abcd",
      summary: "Falta el origen del email del destinatario.",
    },
    latestAnswer: directAnswer,
    latestAnswerIndex: 3,
    inputRequirements: [],
    capabilityNeeds: [],
    env: testEnv,
    model: {
      async verify() {
        return {
          verdict: "entailed",
          reason: "El operador identifica la provisión humana en ejecución.",
          strategy: {
            kind: "operator_supplied_at_runtime",
            address_type: "email",
            label: "Email del propietario",
            source_ref: {
              type: "input_requirement",
              key: "recipient_address",
            },
            evidence_quote: directAnswer,
          },
        };
      },
    },
  });
  assert.equal(direct.verdict, "entailed");
  assert.equal(direct.strategy?.evidence[0]?.answer_index, 3);

  const prompt = buildRecipientResolutionAdjudicationPrompt({
    gap: {
      id: "gap_1234abcd",
      summary: "Falta el origen del email del destinatario.",
    },
    latestAnswer: answer,
    latestAnswerIndex: 2,
    inputRequirements: [],
    capabilityNeeds: [],
  });
  assert.match(prompt, /semantic entailment/i);
  assert.match(prompt, /conditional language/i);
  assert.doesNotMatch(prompt, /regex|keyword list/i);

  const fabricated = await adjudicatePendingRecipientResolution({
    gap: {
      id: "gap_1234abcd",
      summary: "Falta el origen del email del destinatario.",
    },
    latestAnswer: answer,
    latestAnswerIndex: 2,
    inputRequirements: [],
    capabilityNeeds: [],
    env: testEnv,
    model: {
      async verify() {
        return {
          verdict: "entailed",
          reason: "Cita inventada.",
          strategy: {
            kind: "operator_supplied_at_runtime",
            address_type: "email",
            label: null,
            source_ref: {
              type: "input_requirement",
              key: "recipient_address",
            },
            evidence_quote: "una cita ausente",
          },
        };
      },
    },
  });
  assert.equal(fabricated.verdict, "unavailable");
  assert.equal(
    fabricated.warning_code,
    "recipient_provenance_invalid_response"
  );
}

async function main(): Promise<void> {
  await acceptsEntailedParaphrases();
  await rejectsUnsupportedClaimWithoutPatching();
  await rejectsFabricatedEvidence();
  await handlesUnavailableAndDisabled();
  validatesFingerprintAndPromptBoundary();
  await supportsCapabilityBackedAddressTypes();
  await adjudicatesPendingCanonicalClaim();
  console.log("recipient-provenance-verifier.selftest: all checks passed");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
