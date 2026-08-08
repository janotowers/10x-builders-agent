/**
 * Compilador NL → DurableTaskSpec (Phase 5.2/5.3).
 *
 * A diferencia del compilador de casos, no genera `case_type` ni grafo:
 * produce objetivo, aceptación, requisitos, work templates y retención.
 */
import {
  WORKFLOW_COMPILER_MODEL_ID,
  recordOpenRouterCallUsage,
  type OpenRouterUsagePayload,
} from "@agents/agent";
import {
  durableTaskCompilerOutputSchema,
  type DurableTaskSpec,
  type SolutionPatternComposition,
} from "@agents/workflows";

export interface CompileDurableTaskInput {
  description: string;
  title?: string | null;
  clarificationAnswers?: string[];
  availableCapabilities: string[];
  availableTools: string[];
  patternComposition?: SolutionPatternComposition;
}

export type CompileDurableTaskResult =
  | { kind: "clarification"; questions: string[] }
  | { kind: "spec"; spec: DurableTaskSpec }
  | { kind: "error"; message: string };

export interface DurableTaskCompilerModel {
  compile(input: CompileDurableTaskInput): Promise<unknown>;
}

export function buildDurableTaskCompilerPrompt(
  input: CompileDurableTaskInput
): string {
  return [
    "You compile an independent durable task for a Spanish-speaking real-estate operator.",
    "This is NOT a commercial case and MUST NOT create a case_type or workflow graph.",
    "Return ONLY compact JSON:",
    '{"clarifying_questions":string[],"task_spec"?:{"spec_version":1,"title":string,"objective":string,"acceptance_criteria":string[],"input_requirements":[{"kind":"account_asset"|"runtime_input"|"case_fact"|"business_record"|"knowledge_requirement"|"generated_artifact"|"human_input"|"integration"|"tool","key":string,"label":string,"required"?:boolean,"scope"?:string,"resolve_at"?:string,"source_hint"?:string,"retention"?:string,"producer_step"?:string,"tool"?:string}],"work_templates":[{"work_type":string,"required_capability":string,"objective":string,"depends_on":string[],"required_tools":string[],"required_data_scopes":string[],"guardrails":string[],"exit_criteria":string[],"human_review_required":boolean,"output_required_keys":string[],"priority":number,"max_attempts":number}],"result_contract":{"required_keys":string[],"description":string},"retention_policy":{"result_days":number,"input_days":number},"open_questions":string[]},"reason"?:string}',
    "",
    "Decision rules:",
    "- If a missing answer changes the data source, scope, side effects, expected result, or recurrence, return ONLY clarifying_questions (max 5).",
    "- Otherwise return task_spec and clarifying_questions: [].",
    "- Write user-facing content in Spanish. Keys/work_type are short English snake_case.",
    "- Do not create one task per property/entity for a batch; use bounded work templates.",
    "- `account_asset` is ONLY a reusable tenant file (template/watermark/brand book).",
    "- Conversation history, contacts, agreements and warehouse rows are business_record/case_fact/runtime_input, never account_asset.",
    "- A report/draft produced by the task is generated_artifact, never an input upload.",
    "- Use only registered capabilities and tools listed below. If none maps exactly, use capability `durable_task_execution` when available.",
    "- For `durable_task_execution`, required_tools may contain only `bigquery_run_query`; ask a clarification or leave tools empty for any other mechanism.",
    "- Every work template must use output_required_keys exactly [\"response_summary\"]; the root result_contract may describe richer aggregated outputs.",
    "- Set human_review_required=true for the first production version unless the result is independently and deterministically verifiable.",
    ...(input.patternComposition
      ? [
          `Registered solution pattern bundle: ${JSON.stringify({
            base_bundle_id: input.patternComposition.baseBundleId,
            triggers: input.patternComposition.triggers,
            pattern_ids: input.patternComposition.patternIds,
          })}`,
          ...input.patternComposition.patterns.flatMap((pattern) =>
            pattern.compileDirectives.map(
              (directive) => `- [${pattern.id}] ${directive}`
            )
          ),
        ]
      : []),
    `Available capabilities: ${JSON.stringify(input.availableCapabilities)}`,
    `Available tools: ${JSON.stringify(input.availableTools)}`,
    `Friendly title: ${JSON.stringify(input.title ?? "")}`,
    ...(input.clarificationAnswers?.length
      ? [
          "Previous clarification answers:",
          ...input.clarificationAnswers.map((answer) => `- ${answer}`),
        ]
      : []),
    `Description: ${JSON.stringify(input.description)}`,
  ].join("\n");
}

function parseJsonContent(content: unknown): unknown {
  if (typeof content !== "string") return content;
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return JSON.parse(fenced?.[1] ?? trimmed);
}

async function invokeOpenRouter(
  input: CompileDurableTaskInput
): Promise<unknown> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY no configurada");
  const model = WORKFLOW_COMPILER_MODEL_ID;
  const startedAt = Date.now();
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://agents.local",
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 7000,
      response_format: { type: "json_object" },
      usage: { include: true },
      messages: [
        {
          role: "system",
          content:
            "You are a strict JSON durable-task compiler. Never call tools or answer conversationally.",
        },
        { role: "user", content: buildDurableTaskCompilerPrompt(input) },
      ],
    }),
  });
  if (!response.ok) {
    await recordOpenRouterCallUsage({
      modelId: model,
      modelRole: "workflow_compiler",
      operation: "chat_completion",
      latencyMs: Date.now() - startedAt,
      status: "error",
      errorCode: `http_${response.status}`,
    });
    throw new Error(`OpenRouter respondió ${response.status}`);
  }
  const json = (await response.json()) as {
    id?: string;
    choices?: Array<{ message?: { content?: unknown } }>;
    usage?: OpenRouterUsagePayload;
  };
  await recordOpenRouterCallUsage({
    modelId: model,
    modelRole: "workflow_compiler",
    operation: "chat_completion",
    usage: json.usage ?? null,
    providerRequestId: json.id ?? null,
    latencyMs: Date.now() - startedAt,
  });
  return parseJsonContent(json.choices?.[0]?.message?.content);
}

export async function compileDurableTaskDescription(
  input: CompileDurableTaskInput,
  model?: DurableTaskCompilerModel
): Promise<CompileDurableTaskResult> {
  if (!input.description.trim()) {
    return { kind: "error", message: "La descripción está vacía." };
  }
  try {
    const raw = model
      ? await model.compile(input)
      : await invokeOpenRouter(input);
    const parsed = durableTaskCompilerOutputSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        kind: "error",
        message: `La salida durable no cumple el contrato: ${parsed.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")}`,
      };
    }
    if (parsed.data.clarifying_questions.length > 0) {
      return {
        kind: "clarification",
        questions: parsed.data.clarifying_questions,
      };
    }
    if (!parsed.data.task_spec) {
      return {
        kind: "error",
        message: "El compilador no devolvió preguntas ni una especificación.",
      };
    }
    return { kind: "spec", spec: parsed.data.task_spec };
  } catch (error) {
    return {
      kind: "error",
      message:
        error instanceof Error
          ? error.message
          : "Fallo desconocido del compilador durable.",
    };
  }
}
