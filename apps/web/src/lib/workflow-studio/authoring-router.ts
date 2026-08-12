/**
 * Router de autoría del Studio (Slice 5.3) — capa web.
 *
 * 1) Clasificador determinístico puro (`@agents/workflows`)
 * 2) Si hace falta, modelo OpenRouter (JSON) con fail-closed a `clarify`
 */

import {
  recordOpenRouterCallUsage,
  resolveStudioModelId,
  type OpenRouterUsagePayload,
} from "@agents/agent";
import {
  AUTHORING_ROUTER_KINDS,
  classifyAuthoringIntentDeterministic,
  isGenericAuthoringSlug,
  parseAuthoringRouterOutput,
  suggestEnglishSlug,
  type AuthoringRouterOutput,
} from "@agents/workflows";

export interface AuthoringRouterModel {
  route(prompt: string): Promise<unknown>;
}

export type RouteAuthoringResult = AuthoringRouterOutput & {
  modelId: string | null;
  source: "deterministic" | "model" | "fail_closed";
};

/** Cadena: WORKFLOW_AUTHORING_ROUTER_MODEL_ID → WORKFLOW_COMPILER_MODEL_ID → default. */
export function resolveAuthoringRouterModelId(): string {
  return resolveStudioModelId("authoring_router", process.env);
}

function failClosedClarify(reason: string): RouteAuthoringResult {
  return {
    kind: "clarify",
    confidence: "low",
    reasons: [reason],
    clarifying_questions: [
      "¿Qué resultado concreto quieres (mensaje, lista, flujo de caso, reporte o tarea programada)?",
      "¿Es un procedimiento reusable, un trabajo único o algo recurrente?",
      "¿Quiénes participan además de ti?",
    ],
    requested_side_effects: [],
    modelId: null,
    source: "fail_closed",
  };
}

function buildRouterPrompt(params: {
  description: string;
  clarificationAnswers?: string[];
}): string {
  return [
    "Classify the operator's Spanish natural-language request into exactly one authoring kind.",
    "Return ONLY compact JSON matching this shape:",
    JSON.stringify({
      kind: [...AUTHORING_ROUTER_KINDS],
      skill_subtype: ["simple", "composite", "(only if kind=reusable_skill)"],
      confidence: ["high", "medium", "low"],
      reasons: ["string"],
      clarifying_questions: ["max 5, Spanish, only if kind=clarify or confidence low"],
      suggested_title: "string optional",
      suggested_slug:
        "short english_snake_case of the procedure (never kind names like case_workflow)",
      requested_side_effects: [
        "send_message",
        "human_approval",
        "schedule_recurrence",
        "external_write",
        "create_case",
      ],
      dimensions: {
        expected_outcome: "optional",
        reusable: "boolean optional",
        multi_day_state: "boolean optional",
        recurrence: "boolean optional",
        external_actors: "boolean optional",
        hitl_required: "boolean optional",
        data_source_ambiguous: "boolean optional",
      },
    }),
    "",
    "Taxonomy (artifacts):",
    "- case_workflow: multi-step commercial case with durable state / external actors / HITL",
    "- durable_task: batch or result-oriented work without a commercial case file",
    "- reusable_skill: reusable procedure (simple drafting OR composite multi-capability prep); subtype required",
    "- schedule: explicit recurrence that should create a scheduled task",
    "",
    "Taxonomy (no artifact):",
    "- clarify: ambiguous / missing external system / too broad — ask Spanish business questions",
    "- redirect_to_chat: one-shot execution request (write this now) — do NOT create Studio config",
    "",
    "Hard rules:",
    "- Prefer clarify over inventing adapters/CRMs.",
    "- Do not invent side effects absent from the description.",
    "- suggested_slug must be short english snake_case naming the procedure, never the kind (not case_workflow / durable_task / reusable_skill).",
    "- Write clarifying_questions and reasons in Spanish.",
    "",
    ...(params.clarificationAnswers?.length
      ? [
          "Previous clarification answers from the operator:",
          ...params.clarificationAnswers.map((answer) => `- ${answer}`),
          "",
        ]
      : []),
    `description: ${JSON.stringify(params.description)}`,
  ].join("\n");
}

function parseJsonContent(content: unknown): unknown {
  if (typeof content !== "string") return content;
  const trimmed = content.trim();
  if (!trimmed) return null;
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return JSON.parse(fenced?.[1] ?? trimmed);
}

async function invokeOpenRouterRouter(prompt: string): Promise<{
  raw: unknown;
  modelId: string;
}> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY no configurada");
  const modelId = resolveAuthoringRouterModelId();
  const startedAt = Date.now();
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://agents.local",
    },
    body: JSON.stringify({
      model: modelId,
      temperature: 0,
      max_tokens: 2000,
      response_format: { type: "json_object" },
      usage: { include: true },
      messages: [
        {
          role: "system",
          content:
            "You are a strict JSON authoring router for Gu OS Studio. Never call tools. Never answer conversationally.",
        },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!response.ok) {
    await recordOpenRouterCallUsage({
      modelId,
      modelRole: "studio_authoring_router",
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
    modelId,
    modelRole: "studio_authoring_router",
    operation: "chat_completion",
    usage: json.usage ?? null,
    providerRequestId: typeof json.id === "string" ? json.id : null,
    latencyMs: Date.now() - startedAt,
  });
  return {
    raw: parseJsonContent(json.choices?.[0]?.message?.content),
    modelId,
  };
}

/**
 * Resuelve la intención de autoría. Preferencia determinística; modelo solo
 * cuando el clasificador puro no alcanza o la confianza es baja.
 */
export async function routeAuthoringDescription(params: {
  description: string;
  clarificationAnswers?: string[];
  model?: AuthoringRouterModel;
}): Promise<RouteAuthoringResult> {
  const description = params.description.trim();
  if (!description) {
    return failClosedClarify("Descripción vacía");
  }

  // El clasificador determinístico usa solo la descripción original: las
  // respuestas de discovery suelen mencionar “asesor/propietario/enviar” y
  // no deben reclasificar un skill reusable como case_workflow.
  const answerBodies = (params.clarificationAnswers ?? []).map((entry) => {
    const arrow = entry.indexOf("→");
    return (arrow >= 0 ? entry.slice(arrow + 1) : entry).trim();
  }).filter(Boolean);

  const deterministic = classifyAuthoringIntentDeterministic(description);
  const hasAnswers = answerBodies.length > 0;
  // Tras respuestas, si el determinístico sigue en clarify/low o no decide,
  // pedimos al modelo; si no hay respuestas y la confianza es alta, listo.
  const needsModel =
    !deterministic ||
    deterministic.confidence === "low" ||
    (hasAnswers && deterministic.kind === "clarify");
  if (deterministic && !needsModel) {
    const slug =
      deterministic.suggested_slug &&
      !isGenericAuthoringSlug(deterministic.suggested_slug)
        ? deterministic.suggested_slug
        : suggestEnglishSlug(deterministic.suggested_title ?? description);
    return {
      ...deterministic,
      suggested_slug: slug,
      modelId: null,
      source: "deterministic",
    };
  }

  try {
    const prompt = buildRouterPrompt({
      description,
      clarificationAnswers: answerBodies,
    });
    const { raw, modelId } = params.model
      ? { raw: await params.model.route(prompt), modelId: resolveAuthoringRouterModelId() }
      : await invokeOpenRouterRouter(prompt);
    const parsed = parseAuthoringRouterOutput(raw);
    if (!parsed) {
      return failClosedClarify(
        "La salida del router de autoría no cumple el contrato"
      );
    }
    return {
      ...parsed,
      suggested_slug:
        parsed.suggested_slug && !isGenericAuthoringSlug(parsed.suggested_slug)
          ? parsed.suggested_slug
          : suggestEnglishSlug(parsed.suggested_title ?? description),
      modelId,
      source: "model",
    };
  } catch (error) {
    console.warn("[authoring-router] failed:", error);
    return failClosedClarify(
      error instanceof Error
        ? error.message
        : "Fallo desconocido del router de autoría"
    );
  }
}
