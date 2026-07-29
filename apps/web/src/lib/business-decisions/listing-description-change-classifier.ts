import { z } from "zod";
import {
  recordOpenRouterCallUsage,
  type OpenRouterUsagePayload,
} from "@agents/agent";

const DEFAULT_CLASSIFIER_MODEL = "openai/gpt-4o-mini";

export const ListingDescriptionChangeClassificationSchema = z.object({
  change_type: z.enum([
    "editorial_instruction",
    "new_fact_or_highlight",
    "exact_replacement",
    "mixed",
    "unclear",
  ]),
  editorial_instructions: z.array(z.string()),
  new_facts_or_highlights: z.array(z.string()),
  replacement_text: z.string().nullable(),
  confidence: z.enum(["high", "medium", "low"]),
  requires_clarification: z.boolean(),
  clarification_question: z.string().optional(),
});

export type ListingDescriptionChangeClassification = z.infer<
  typeof ListingDescriptionChangeClassificationSchema
>;

type DraftSnapshot = {
  headline?: string;
  short_description?: string;
  description?: string;
};

export interface ListingDescriptionChangeClassifierInput {
  text: string;
  draft?: DraftSnapshot | null;
}

export interface ListingDescriptionChangeClassifierModel {
  classify(input: ListingDescriptionChangeClassifierInput): Promise<unknown>;
}

function parseJsonContent(content: unknown) {
  if (typeof content !== "string") return content;
  const trimmed = content.trim();
  if (!trimmed) return null;
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return JSON.parse(fenced?.[1] ?? trimmed);
}

function normalizeClassification(
  value: unknown
): ListingDescriptionChangeClassification | null {
  const parsed = ListingDescriptionChangeClassificationSchema.safeParse(value);
  if (!parsed.success) return null;
  const cleaned = parsed.data;
  return {
    ...cleaned,
    editorial_instructions: cleaned.editorial_instructions
      .map((value) => value.trim())
      .filter(Boolean)
      .slice(0, 8),
    new_facts_or_highlights: cleaned.new_facts_or_highlights
      .map((value) => value.trim())
      .filter(Boolean)
      .slice(0, 12),
    replacement_text: cleaned.replacement_text?.trim() || null,
    clarification_question:
      cleaned.clarification_question?.trim() || undefined,
  };
}

function buildClassifierPrompt(input: ListingDescriptionChangeClassifierInput) {
  const draftPreview =
    input.draft && typeof input.draft === "object"
      ? {
          headline: input.draft.headline ?? "",
          short_description: input.draft.short_description ?? "",
          description: (input.draft.description ?? "").slice(0, 800),
        }
      : null;
  return [
    "Classify this Spanish advisor message for a listing description revision workflow.",
    "Return ONLY compact JSON matching:",
    '{"change_type":"editorial_instruction|new_fact_or_highlight|exact_replacement|mixed|unclear","editorial_instructions":string[],"new_facts_or_highlights":string[],"replacement_text":string|null,"confidence":"high|medium|low","requires_clarification":boolean,"clarification_question"?:string}',
    "",
    "Rules:",
    "- The advisor has clicked 'Pedir cambios'.",
    "- editorial_instruction: style/tone/length/order edits without introducing new property facts.",
    "- new_fact_or_highlight: adds concrete property facts/highlights to incorporate.",
    "- exact_replacement: user asks to replace with exact provided wording.",
    "- mixed: contains both editorial instructions and new facts.",
    "- unclear: ambiguous or contradictory; set requires_clarification=true.",
    "- Never invent facts. Extract only what user wrote.",
    "- If replacement text is present, copy it verbatim into replacement_text.",
    "- Keep arrays concise and actionable.",
    "",
    draftPreview ? `current_draft: ${JSON.stringify(draftPreview)}` : "",
    `advisor_message: ${JSON.stringify(input.text)}`,
  ]
    .filter(Boolean)
    .join("\n");
}

async function invokeOpenRouterListingDescriptionClassifier(
  input: ListingDescriptionChangeClassifierInput
) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;
  const model =
    process.env.LISTING_DESCRIPTION_CHANGE_CLASSIFIER_MODEL_ID?.trim() ||
    DEFAULT_CLASSIFIER_MODEL;
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
      max_tokens: 320,
      response_format: { type: "json_object" },
      // Slice 0.4: pide el costo facturado en la respuesta (usage.cost).
      usage: { include: true },
      messages: [
        {
          role: "system",
          content:
            "You are a strict JSON classifier. Never call tools. Never answer conversationally.",
        },
        { role: "user", content: buildClassifierPrompt(input) },
      ],
    }),
  });
  if (!response.ok) {
    void recordOpenRouterCallUsage({
      modelId: model,
      modelRole: "listing_description_change_classifier",
      operation: "classification",
      latencyMs: Date.now() - startedAt,
      status: "error",
      errorCode: `http_${response.status}`,
    });
    console.warn(
      "[listing-description-change-classifier] OpenRouter failed:",
      response.status,
      await response.text().catch(() => "")
    );
    return null;
  }
  const json = (await response.json()) as {
    id?: string;
    choices?: Array<{ message?: { content?: unknown } }>;
    usage?: OpenRouterUsagePayload;
  };
  void recordOpenRouterCallUsage({
    modelId: model,
    modelRole: "listing_description_change_classifier",
    operation: "classification",
    usage: json.usage ?? null,
    providerRequestId: typeof json.id === "string" ? json.id : null,
    latencyMs: Date.now() - startedAt,
  });
  return parseJsonContent(json.choices?.[0]?.message?.content);
}

export async function classifyListingDescriptionChange(
  input: ListingDescriptionChangeClassifierInput,
  model?: ListingDescriptionChangeClassifierModel
): Promise<ListingDescriptionChangeClassification | null> {
  if (!input.text.trim()) return null;
  try {
    const raw = model
      ? await model.classify(input)
      : await invokeOpenRouterListingDescriptionClassifier(input);
    return normalizeClassification(raw);
  } catch (error) {
    console.warn("[listing-description-change-classifier] failed:", error);
    return null;
  }
}
