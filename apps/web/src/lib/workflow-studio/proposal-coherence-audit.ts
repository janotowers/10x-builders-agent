import {
  recordOpenRouterCallUsage,
  resolveStudioModelId,
  type OpenRouterUsagePayload,
} from "@agents/agent";
import {
  authoringDiscoveryOutputSchema,
  type AuthoringDiscoveryOutput,
} from "@agents/workflows";
import { z } from "zod";

const inputReclassificationSchema = z
  .object({
    key: z.string().trim().min(1).max(160),
    action: z.literal("drop_not_an_input"),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export const proposalCoherenceCorrectionsSchema = z
  .object({
    objective: z.string().trim().min(1).max(4000).optional(),
    sources: z.array(z.string().trim().min(1).max(500)).max(64).optional(),
    actors: z.array(z.string().trim().min(1).max(500)).max(64).optional(),
    decisions: z.array(z.string().trim().min(1).max(500)).max(64).optional(),
    acceptance_criteria: z
      .array(z.string().trim().min(1).max(500))
      .max(64)
      .optional(),
    assumptions: z.array(z.string().trim().min(1).max(500)).max(64).optional(),
    input_reclassifications: z
      .array(inputReclassificationSchema)
      .max(16)
      .default([]),
  })
  .strict();

export const proposalCoherenceAuditOutputSchema = z
  .object({
    coherent: z.boolean(),
    issues: z.array(z.string().trim().min(1).max(500)).max(24).default([]),
    corrections: proposalCoherenceCorrectionsSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.coherent && value.corrections) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A coherent proposal must omit corrections.",
        path: ["corrections"],
      });
    }
    if (!value.coherent && value.issues.length === 0 && !value.corrections) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "An incoherent proposal requires issues or corrections.",
        path: ["issues"],
      });
    }
  });

export type ProposalCoherenceAuditOutput = z.infer<
  typeof proposalCoherenceAuditOutputSchema
>;

export type ProposalCoherenceAuditWarningCode =
  | "proposal_audit_unavailable"
  | "proposal_audit_invalid_response"
  | "proposal_audit_corrections_rejected";

export type ProposalCoherenceAuditMeta = {
  model_id: string | null;
  coherent: boolean | null;
  issues: string[];
  applied: boolean;
  quality_warnings: Array<{
    code: ProposalCoherenceAuditWarningCode;
    path?: string;
  }>;
};

export type ProposalCoherenceAuditModel = {
  audit(prompt: string, signal?: AbortSignal): Promise<unknown>;
};

export function resolveProposalCoherenceAuditModelId(
  env: Record<string, string | undefined> = process.env
): string {
  return (
    env.WORKFLOW_AUTHORING_PROPOSAL_AUDIT_MODEL_ID?.trim() ||
    resolveStudioModelId("authoring_discovery", env, "escalation")
  );
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.trim().toLocaleLowerCase("es");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function buildProposalCoherenceAuditPrompt(params: {
  description: string;
  answers: readonly string[];
  discovery: AuthoringDiscoveryOutput;
}): string {
  return [
    "Audit the semantic coherence of this Gu OS Studio proposal.",
    "Return ONLY JSON with this exact shape:",
    '{"coherent":boolean,"issues":["..."],"corrections":{"objective":"optional","sources":["optional"],"actors":["optional"],"decisions":["optional"],"acceptance_criteria":["optional"],"assumptions":["optional"],"input_reclassifications":[{"key":"existing_key","action":"drop_not_an_input","reason":"optional"}]}}',
    "Omit corrections when coherent=true. In corrections, omit every field that does not need replacement.",
    "The structured contracts are authoritative evidence. Never add, remove, or modify requested_side_effects, capability_needs, outbound_contract, source_strategy, evidence, gaps, readiness, kind, title, or slug.",
    "Audit checklist:",
    "- If send_message and delivery.mode=after_approval are present, objective must include sending after human approval, not only drafting.",
    "- sources contains data origins only. A recipient email/contact is a runtime input, not a source.",
    "- Merge duplicate actor entries and their responsibilities.",
    "- Applicability limits such as only owners / not buyers belong in acceptance_criteria, not decisions.",
    "- assumptions must not contradict outbound_contract or requested_side_effects.",
    "- Approved content, approved recipient, and approval artifacts are flow decisions/outputs, not input_requirements; drop only their existing keys with drop_not_an_input.",
    "- Do not drop the input referenced by outbound_contract.recipient_strategy.source_ref.",
    "- Flag prose effects that contradict structure, but do not copy prose into structured contracts.",
    "<<<operator_request>>>",
    params.description,
    "<<<end_operator_request>>>",
    `<<<operator_answers>>>${JSON.stringify(params.answers)}<<<end_operator_answers>>>`,
    `<<<proposal>>>${JSON.stringify(params.discovery)}<<<end_proposal>>>`,
  ].join("\n");
}

export function applyProposalCoherenceCorrections(params: {
  discovery: AuthoringDiscoveryOutput;
  audit: ProposalCoherenceAuditOutput;
}): {
  discovery: AuthoringDiscoveryOutput;
  rejected: string[];
  applied: boolean;
} {
  const corrections = params.audit.corrections;
  if (!corrections) {
    return { discovery: params.discovery, rejected: [], applied: false };
  }
  const rejected: string[] = [];
  const protectedInputKey =
    params.discovery.outbound_contract?.recipient_strategy.source_ref?.type ===
    "input_requirement"
      ? params.discovery.outbound_contract.recipient_strategy.source_ref.key
      : null;
  const requestedDrops = new Set(
    corrections.input_reclassifications.flatMap((item) => {
      if (item.key === protectedInputKey) {
        rejected.push(`input_requirements.${item.key}`);
        return [];
      }
      if (
        !params.discovery.input_requirements.some(
          (requirement) => requirement.key === item.key
        )
      ) {
        rejected.push(`input_requirements.${item.key}`);
        return [];
      }
      return [item.key];
    })
  );
  const understanding = {
    ...params.discovery.understanding,
    ...(corrections.objective
      ? { objective: corrections.objective }
      : {}),
    ...(corrections.sources
      ? { sources: uniqueStrings(corrections.sources) }
      : {}),
    ...(corrections.actors ? { actors: uniqueStrings(corrections.actors) } : {}),
    ...(corrections.decisions
      ? { decisions: uniqueStrings(corrections.decisions) }
      : {}),
    ...(corrections.acceptance_criteria
      ? {
          acceptance_criteria: uniqueStrings(
            corrections.acceptance_criteria
          ),
        }
      : {}),
    ...(corrections.assumptions
      ? { assumptions: uniqueStrings(corrections.assumptions) }
      : {}),
  };
  const candidate = {
    ...params.discovery,
    understanding,
    assumptions: corrections.assumptions
      ? understanding.assumptions
      : params.discovery.assumptions,
    input_requirements: params.discovery.input_requirements.filter(
      (requirement) => !requestedDrops.has(requirement.key)
    ),
  };
  const parsed = authoringDiscoveryOutputSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      discovery: params.discovery,
      rejected: ["authoring_discovery_output"],
      applied: false,
    };
  }
  return {
    discovery: parsed.data,
    rejected,
    applied: JSON.stringify(parsed.data) !== JSON.stringify(params.discovery),
  };
}

export function detectProseStructureCoherenceIssues(
  discovery: AuthoringDiscoveryOutput
): string[] {
  const issues: string[] = [];
  const prose = discovery.understanding.effects.join(" ").toLocaleLowerCase("es");
  const hasStructuredSend = discovery.requested_side_effects.includes(
    "send_message"
  );
  if (
    !hasStructuredSend &&
    /\b(enviar|env[ií]o|email|correo|mensaje)\b/i.test(prose)
  ) {
    issues.push(
      "understanding.effects declara envío sin requested_side_effects.send_message."
    );
  }
  if (
    hasStructuredSend &&
    discovery.outbound_contract?.delivery.mode === "after_approval" &&
    /\bsolo\b.{0,30}\bborrador\b/i.test(
      discovery.understanding.assumptions.join(" ")
    )
  ) {
    issues.push(
      "understanding.assumptions contradice el envío posterior a aprobación."
    );
  }
  return issues;
}

function parseJsonContent(content: unknown): unknown {
  if (typeof content !== "string") return content;
  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced?.[1]) return JSON.parse(fenced[1]);
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("proposal_audit_json_invalid");
  }
}

async function invokeProposalCoherenceAudit(params: {
  prompt: string;
  modelId: string;
  signal?: AbortSignal;
}): Promise<unknown> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY no configurada");
  const startedAt = Date.now();
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    signal: params.signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://agents.local",
    },
    body: JSON.stringify({
      model: params.modelId,
      temperature: 0,
      max_tokens: 2400,
      usage: { include: true },
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are Gu OS's strict proposal coherence auditor. Return valid JSON only. Do not invent evidence or capabilities.",
        },
        { role: "user", content: params.prompt },
      ],
    }),
  });
  if (!response.ok) {
    await recordOpenRouterCallUsage({
      modelId: params.modelId,
      modelRole: "studio_authoring_proposal_audit",
      operation: "chat_completion",
      latencyMs: Date.now() - startedAt,
      status: "error",
      errorCode: `http_${response.status}`,
      metadata: {
        studio_task: "authoring_proposal_audit",
        tier: "escalation",
      },
    });
    throw new Error(`OpenRouter respondió ${response.status}`);
  }
  const json = (await response.json()) as {
    id?: string;
    choices?: Array<{ message?: { content?: unknown } }>;
    usage?: OpenRouterUsagePayload;
  };
  await recordOpenRouterCallUsage({
    modelId: params.modelId,
    modelRole: "studio_authoring_proposal_audit",
    operation: "chat_completion",
    usage: json.usage ?? null,
    providerRequestId: typeof json.id === "string" ? json.id : null,
    latencyMs: Date.now() - startedAt,
    metadata: {
      studio_task: "authoring_proposal_audit",
      tier: "escalation",
    },
  });
  return parseJsonContent(json.choices?.[0]?.message?.content);
}

export async function auditAndFinalizeAuthoringProposal(params: {
  discovery: AuthoringDiscoveryOutput;
  description: string;
  answers: readonly string[];
  model?: ProposalCoherenceAuditModel;
  signal?: AbortSignal;
  env?: Record<string, string | undefined>;
}): Promise<{
  discovery: AuthoringDiscoveryOutput;
  audit: ProposalCoherenceAuditMeta;
}> {
  const env = params.env ?? process.env;
  const modelId = resolveProposalCoherenceAuditModelId(env);
  if (env.WORKFLOW_AUTHORING_PROPOSAL_AUDIT_DISABLED === "true") {
    return {
      discovery: params.discovery,
      audit: {
        model_id: null,
        coherent: null,
        issues: [],
        applied: false,
        quality_warnings: [],
      },
    };
  }
  const prompt = buildProposalCoherenceAuditPrompt(params);
  let raw: unknown;
  try {
    raw = params.model
      ? await params.model.audit(prompt, params.signal)
      : await invokeProposalCoherenceAudit({
          prompt,
          modelId,
          signal: params.signal,
        });
  } catch (error) {
    if (
      params.signal?.aborted ||
      (error instanceof Error && error.name === "AbortError")
    ) {
      throw error;
    }
    return {
      discovery: params.discovery,
      audit: {
        model_id: modelId,
        coherent: null,
        issues: detectProseStructureCoherenceIssues(params.discovery),
        applied: false,
        quality_warnings: [{ code: "proposal_audit_unavailable" }],
      },
    };
  }
  const parsed = proposalCoherenceAuditOutputSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      discovery: params.discovery,
      audit: {
        model_id: modelId,
        coherent: null,
        issues: detectProseStructureCoherenceIssues(params.discovery),
        applied: false,
        quality_warnings: [{ code: "proposal_audit_invalid_response" }],
      },
    };
  }
  const applied = applyProposalCoherenceCorrections({
    discovery: params.discovery,
    audit: parsed.data,
  });
  const issues = uniqueStrings([
    ...parsed.data.issues,
    ...detectProseStructureCoherenceIssues(applied.discovery),
  ]);
  return {
    discovery: applied.discovery,
    audit: {
      model_id: modelId,
      coherent: parsed.data.coherent,
      issues,
      applied: applied.applied,
      quality_warnings:
        applied.rejected.length > 0
          ? applied.rejected.map((path) => ({
              code: "proposal_audit_corrections_rejected" as const,
              path,
            }))
          : [],
    },
  };
}
