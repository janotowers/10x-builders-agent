/**
 * Paso NL → specs + grafo borrador del compilador (Slice 4.2; §15).
 *
 * El modelo (`WORKFLOW_COMPILER_MODEL_ID`, rol `workflow_compiler`) recibe la
 * descripción del operador MÁS los catálogos reales del tenant (guards,
 * skills, capacidades, tools) para que componga SOLO nombres registrados —
 * jamás código inline (§15: "generated definitions compose only
 * registry-vetted guards/checks").
 *
 * Salida en tres formas:
 *   - clarification: preguntas acotadas (≤5 por ronda; §14 limita a 3 rondas,
 *     el Studio lleva la cuenta);
 *   - draft: business spec + implementation spec + grafo candidato (los gates
 *     4.2-2/4.2-3 deciden si es publicable — la salida del modelo NUNCA se
 *     confía sin gates);
 *   - error: fallo de modelo/parseo. FAIL-CLOSED: aquí no hay degradación
 *     silenciosa como en el intent decomposer — sin salida válida no se crea
 *     draft.
 */

import {
  WORKFLOW_COMPILER_MODEL_ID,
  recordOpenRouterCallUsage,
  type OpenRouterUsagePayload,
} from "@agents/agent";
import {
  compilerOutputSchema,
  isClarificationRound,
  type BusinessSpec,
  type CompilerOutput,
  type ImplementationSpec,
} from "@agents/workflows";
import type { WorkflowGraph } from "@agents/types";

export interface CompileDescriptionInput {
  /** Descripción en lenguaje natural del operador (se preserva verbatim). */
  description: string;
  caseType: string;
  /** Respuestas a rondas de aclaración previas, si las hubo. */
  clarificationAnswers?: string[];
  /** Catálogos del tenant: el modelo solo puede componer estos nombres. */
  availableGuards: string[];
  availableSkills: string[];
  availableCapabilities: string[];
  availableTools: string[];
}

export type CompileDescriptionResult =
  | { kind: "clarification"; questions: string[] }
  | {
      kind: "draft";
      businessSpec: BusinessSpec;
      implementationSpec: ImplementationSpec;
      graph: WorkflowGraph;
    }
  | { kind: "error"; message: string };

export interface WorkflowCompilerModel {
  compile(input: CompileDescriptionInput): Promise<unknown>;
}

const GRAPH_SHAPE_HINT = `{
  "states": [{"key": "snake_case", "label": "Etiqueta ES", "kind": "operational|terminal"}],
  "transitions": [{"from": "state", "to": "state", "guards": ["guard_registrado"], "authorized_proposers": ["model"|"decision_handler"|"runtime"], "approval_required": null|"kind"}],
  "step_bindings": [{"state": "state", "skill": "skill-disponible"|null, "required_assets": [{"asset_key": "snake_case", "label": "Etiqueta ES", "required": true}]}],
  "work_templates": [{"on_enter_state": "state", "work_type": "snake_case", "required_capability": "capacidad_disponible"}],
  "postconditions": [],
  "approvals": [{"kind": "snake_case", "evidence_inputs": []}],
  "impact_dependencies": {},
  "completion": {"terminal_states": ["state"], "required_evidence": []}
}`;

export function buildCompilerPrompt(input: CompileDescriptionInput): string {
  return [
    "You compile a Spanish natural-language workflow description from a real-estate operator into a business spec, an implementation spec, and a draft workflow graph.",
    "Return ONLY compact JSON with this shape:",
    '{"clarifying_questions": string[], "business_spec"?: {...}, "implementation_spec"?: {...}, "graph"?: {...}, "reason"?: string}',
    "",
    "Decision rule:",
    "- If the description is too ambiguous to compile safely (missing actors, unclear outcome, unclear approval points), return ONLY clarifying_questions (max 5, in Spanish) and nothing else.",
    "- Otherwise return clarifying_questions as [] plus the three artifacts.",
    "",
    "business_spec shape:",
    '{"spec_version":1,"title":string,"description_nl":string,"objective":string,"actors":string[],"happy_path":string[],"decisions":[{"name":string,"approver":string}],"outcomes":string[],"constraints":string[],"acceptance_scenarios":[{"name":string,"given":string,"when":string,"then":string}],"unimplementable_notes":string[]}',
    "- description_nl MUST be the operator's description verbatim, unchanged.",
    "- Write everything user-facing in Spanish.",
    "",
    "implementation_spec shape:",
    '{"spec_version":1,"summary":string,"states":[{"key":string,"label"?:string,"kind":"operational"|"terminal"}],"capabilities":[{"capability":string,"state":string,"work_type":string}],"skills":string[],"tools":string[],"integrations":string[],"required_assets":[{"asset_key":string,"label":string,"required"?:boolean}],"approvals":[{"kind":string,"evidence_inputs":string[]}],"open_questions":string[]}',
    "",
    "graph shape:",
    GRAPH_SHAPE_HINT,
    "",
    "Hard rules for the graph:",
    "- The FIRST state in `states` is the initial state; at least one terminal state listed in completion.terminal_states.",
    "- Directed acyclic: no transition may create a cycle; every state reachable from the first; every non-terminal state needs an outgoing transition.",
    `- guards: ONLY from this registry: ${JSON.stringify(input.availableGuards)}. Use [] when no guard applies. NEVER invent guard names.`,
    `- step_bindings[].skill: ONLY from: ${JSON.stringify(input.availableSkills)} or null.`,
    `- work_templates[].required_capability: ONLY from: ${JSON.stringify(input.availableCapabilities)}. Omit work_templates you cannot map to a capability and record the gap in implementation_spec.open_questions instead.`,
    `- Tools you may reference in implementation_spec.tools: ${JSON.stringify(input.availableTools)}.`,
    "- required_assets: asset_key in snake_case with a Spanish label; a missing upload is fine (it becomes a customer-facing gap), but the KEY must be well-formed.",
    "- NEVER embed credentials, API keys, tokens or secrets anywhere.",
    "- If part of the business ask cannot be implemented with the available catalog, still preserve it in business_spec and list it in unimplementable_notes / open_questions — do not drop it silently.",
    "",
    `case_type: ${input.caseType}`,
    ...(input.clarificationAnswers?.length
      ? [
          "Previous clarification answers from the operator:",
          ...input.clarificationAnswers.map((answer) => `- ${answer}`),
        ]
      : []),
    `description: ${JSON.stringify(input.description)}`,
  ].join("\n");
}

function parseJsonContent(content: unknown) {
  if (typeof content !== "string") return content;
  const trimmed = content.trim();
  if (!trimmed) return null;
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return JSON.parse(fenced?.[1] ?? trimmed);
}

async function invokeOpenRouterCompiler(
  input: CompileDescriptionInput
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
      max_tokens: 8000,
      response_format: { type: "json_object" },
      usage: { include: true },
      messages: [
        {
          role: "system",
          content:
            "You are a strict JSON workflow compiler. Never call tools. Never answer conversationally.",
        },
        { role: "user", content: buildCompilerPrompt(input) },
      ],
    }),
  });
  if (!response.ok) {
    void recordOpenRouterCallUsage({
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
  void recordOpenRouterCallUsage({
    modelId: model,
    modelRole: "workflow_compiler",
    operation: "chat_completion",
    usage: json.usage ?? null,
    providerRequestId: typeof json.id === "string" ? json.id : null,
    latencyMs: Date.now() - startedAt,
  });
  return parseJsonContent(json.choices?.[0]?.message?.content);
}

/** Normaliza y clasifica la salida cruda del modelo. Pura; testeable. */
export function classifyCompilerOutput(raw: unknown): CompileDescriptionResult {
  const parsed = compilerOutputSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      kind: "error",
      message: `La salida del compilador no cumple el contrato: ${parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ")}`,
    };
  }
  const output: CompilerOutput = parsed.data;
  if (isClarificationRound(output)) {
    return { kind: "clarification", questions: output.clarifying_questions };
  }
  if (!output.business_spec || !output.implementation_spec || !output.graph) {
    return {
      kind: "error",
      message:
        "El compilador no devolvió preguntas ni los tres artefactos (business spec, implementation spec, grafo).",
    };
  }
  return {
    kind: "draft",
    businessSpec: output.business_spec,
    implementationSpec: output.implementation_spec,
    graph: output.graph as WorkflowGraph,
  };
}

export async function compileWorkflowDescription(
  input: CompileDescriptionInput,
  model?: WorkflowCompilerModel
): Promise<CompileDescriptionResult> {
  if (!input.description.trim()) {
    return { kind: "error", message: "La descripción está vacía." };
  }
  try {
    const raw = model
      ? await model.compile(input)
      : await invokeOpenRouterCompiler(input);
    return classifyCompilerOutput(raw);
  } catch (error) {
    console.warn("[workflow-compiler] failed:", error);
    return {
      kind: "error",
      message:
        error instanceof Error ? error.message : "Fallo desconocido del compilador.",
    };
  }
}
