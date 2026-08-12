import assert from "node:assert/strict";
import { parseAccountSkillSource } from "@agents/agent";
import {
  compileReusableSkillDescription,
  serializeReusableSkillDraft,
  setReusableSkillCompilerFetchForTests,
  type ReusableSkillDraft,
} from "./compile-reusable-skill";
import type { ReusableSkillCompilationContract } from "./reusable-skill-compilation-contract";

const ownerUserId = "00000000-0000-0000-0000-000000000000";
const catalogs = {
  availableGuards: [],
  availableSkills: [],
  availableCapabilities: [],
  availableTools: ["gmail_send_email"],
};

function validDraft(): ReusableSkillDraft {
  return {
    metadata: {
      name: "owner-followup-message",
      description:
        "Use when preparing an owner follow-up.\nDo not use for buyers or unapproved sends.",
      scope: "business",
      allowed_tools: ["gmail_send_email"],
      includes: [],
      guardrails: "No enviar sin aprobación\nConfirmar destinatario y contenido",
      requires_tenant_context: true,
      memory_extraction: "default",
    },
    body_markdown:
      "# Seguimiento a propietarios\n\n## Procedimiento\n\nLee el documento adjunto en cada ejecución. Conserva esta instrucción del operador: «Yo escribiré el correo exacto del destinatario en cada ejecución». Prepara el contenido y solicita aprobación del destinatario y del texto antes de enviar.\n\n## Guardrails\n\nNo envíes sin aprobación explícita. Usa únicamente el correo escrito por el operador para esa ejecución.",
    rationale: ["Mantiene aprobación humana antes del envío."],
  };
}

const contract: ReusableSkillCompilationContract = {
  schema_version: "1",
  discovery_hash: `sha256:${"a".repeat(64)}`,
  title: "Seguimiento a propietarios",
  slug: "owner-followup-message",
  objective:
    "Leer el documento adjunto de cada ejecución, preparar el seguimiento y enviarlo solo tras aprobación.",
  acceptance_criteria: [
    "El documento adjunto de la ejecución sustenta el mensaje.",
    "El correo del destinatario es el escrito por el operador en esa ejecución.",
  ],
  source_contract: {
    strategy: {
      kind: "operator_supplied_at_runtime",
      label: "Documento adjunto por ejecución",
      source_ref: { type: "input_requirement", key: "run_document" },
      evidence: [
        {
          source: "description",
          quote: "documento adjunto en cada ejecución",
        },
      ],
    },
    data_sources: {
      document_source: {
        formats: ["DOCX", "TXT"],
        evidence: [
          {
            source: "description",
            quote: "documento adjunto en cada ejecución",
          },
        ],
      },
      document_intake_route: {
        input_ref: { type: "input_requirement", key: "run_document" },
        invocation_channel: "web_chat",
        evidence: [
          {
            source: "description",
            quote: "documento adjunto en cada ejecución",
          },
        ],
      },
    },
    audited_sources: ["Documento adjunto en cada ejecución"],
  },
  input_contract: {
    requirements: [
      {
        kind: "runtime_input",
        key: "run_document",
        label: "Documento adjunto",
        required: true,
        scope: "turn",
        resolve_at: "runtime",
        source_hint: "chat_attachment",
      },
      {
        kind: "human_input",
        key: "recipient_email",
        label: "Correo exacto escrito por el operador",
        required: true,
        scope: "turn",
        resolve_at: "runtime",
      },
    ],
    invocation_channels: [],
  },
  outbound_contract: {
    recipient_strategy: {
      kind: "operator_supplied_at_runtime",
      address_type: "email",
      label: "Correo escrito por el operador",
      source_ref: { type: "input_requirement", key: "recipient_email" },
      evidence: [
        {
          source: "answer",
          answer_index: 0,
          quote: "Yo escribiré el correo exacto del destinatario en cada ejecución",
        },
      ],
    },
    approval: {
      approver: "operador",
      scope: ["recipient", "content"],
      evidence: [
        {
          source: "answer",
          answer_index: 0,
          quote: "aprobaré destinatario y contenido antes de enviar",
        },
      ],
    },
    delivery: {
      mode: "after_approval",
      evidence: [
        {
          source: "answer",
          answer_index: 0,
          quote: "después de aprobar, envíalo",
        },
      ],
    },
  },
  recipient_provenance_review: {
    verdict: "entailed",
    fingerprint: "b".repeat(64),
    model_id: "test/judge",
    evidence_quote:
      "Yo escribiré el correo exacto del destinatario en cada ejecución",
  },
  requested_effects: ["send_message", "human_approval", "external_write"],
  capabilities: [],
};

function jsonResponse(output: unknown, finishReason = "stop"): Response {
  return new Response(
    JSON.stringify({
      id: "test-request",
      choices: [
        {
          finish_reason: finishReason,
          message: { content: JSON.stringify(output) },
        },
      ],
      usage: {},
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
}

async function main() {
  const serialized = serializeReusableSkillDraft(validDraft());
  const parsed = parseAccountSkillSource(
    serialized,
    "owner-followup-message",
    ownerUserId
  );
  assert.equal(parsed.metadata.name, "owner-followup-message");
  assert.equal(parsed.metadata.description.includes("\n"), true);
  assert.deepEqual(parsed.metadata.allowedTools, ["gmail_send_email"]);

  const originalApiKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "selftest";
  let calls = 0;
  const prompts: string[] = [];
  setReusableSkillCompilerFetchForTests(async () => {
    calls += 1;
    return calls === 1
      ? jsonResponse(validDraft(), "length")
      : calls === 2
        ? jsonResponse(validDraft())
        : jsonResponse({ passed: true, findings: [] });
  });
  try {
    const repaired = await compileReusableSkillDescription({
      contract,
      description: "Redacta un seguimiento seguro.",
      clarificationAnswers: [
        "Yo escribiré el correo exacto del destinatario en cada ejecución; aprobaré destinatario y contenido antes de enviar; después de aprobar, envíalo.",
      ],
      catalogs,
      ownerUserId,
    });
    assert.equal(calls, 3);
    parseAccountSkillSource(
      repaired.bodyMd,
      "owner-followup-message",
      ownerUserId
    );
    assert.match(repaired.bodyMd, /documento adjunto en cada ejecución/i);
    assert.match(
      repaired.bodyMd,
      /Yo escribiré el correo exacto del destinatario en cada ejecución/
    );

    calls = 0;
    setReusableSkillCompilerFetchForTests(async () => {
      calls += 1;
      return jsonResponse({ metadata: {}, body_markdown: "" });
    });
    await assert.rejects(
      () =>
        compileReusableSkillDescription({
          contract,
          description: "Redacta un seguimiento seguro.",
          catalogs,
          ownerUserId,
        }),
      /no devolvió un borrador válido tras reintentarlo/
    );
    assert.equal(calls, 2);

    calls = 0;
    setReusableSkillCompilerFetchForTests(async (_input, init) => {
      calls += 1;
      const request = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>;
      };
      prompts.push(request.messages.at(-1)?.content ?? "");
      if (calls === 1) {
        return jsonResponse({
          ...validDraft(),
          body_markdown:
            "# Seguimiento\n\n## Procedimiento\n\nPrepara un mensaje genérico para un propietario.",
        });
      }
      if (calls === 2) {
        return jsonResponse({
          passed: false,
          findings: [
            {
              code: "recipient_provenance_changed",
              contract_path: "outbound_contract.recipient_strategy",
              message:
                "El borrador reemplazó el correo escrito por el operador por un propietario genérico.",
            },
          ],
        });
      }
      if (calls === 3) return jsonResponse(validDraft());
      return jsonResponse({ passed: true, findings: [] });
    });
    const fidelityRepaired = await compileReusableSkillDescription({
      contract,
      description: "Texto natural deliberadamente menos preciso.",
      clarificationAnswers: [
        "Yo escribiré el correo exacto del destinatario en cada ejecución.",
      ],
      catalogs,
      ownerUserId,
    });
    assert.equal(calls, 4, "fidelity repair is bounded to one repair and re-audit");
    assert.match(
      fidelityRepaired.bodyMd,
      /Yo escribiré el correo exacto del destinatario en cada ejecución/
    );
    assert.ok(
      prompts[0]?.includes(
        `<<<authoritative_compilation_contract>>>`
      ) &&
        prompts[0]?.includes(contract.discovery_hash) &&
        prompts[0]?.includes("recipient_email"),
      "the authoritative structured contract is sent to the compiler"
    );
    assert.ok(
      prompts[2]?.includes("recipient_provenance_changed"),
      "repair receives the semantic judge finding"
    );
  } finally {
    setReusableSkillCompilerFetchForTests(null);
    if (originalApiKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = originalApiKey;
    }
  }

  console.log("compile-reusable-skill.selftest: passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
