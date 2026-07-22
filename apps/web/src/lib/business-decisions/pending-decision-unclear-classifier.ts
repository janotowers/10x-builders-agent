/**
 * Low-risk LLM second opinion for pending-decision dead ends (Fase 3.3).
 *
 * Invoked ONLY when a sticky HITL gate already claimed a free-text turn and
 * its deterministic/hybrid parser is about to answer "unclear". Happy paths
 * (approve / adjust / provide data) never call this.
 *
 * Fail-open: API/model/parse errors return null → caller keeps clarifying.
 * Never invents an approve/adjust/data decision.
 */

import { z } from "zod";
import { OPERATIONAL_CONVERSATION_CLASSIFIER_MODEL_ID } from "@agents/agent";

export type PendingDecisionUnclearGate =
  | "listing_description_review"
  | "contract_data_review";

export type PendingDecisionUnclearDisposition =
  | "release_to_agent"
  | "keep_clarifying";

export const PendingDecisionUnclearClassificationSchema = z.object({
  disposition: z.enum(["release_to_agent", "keep_clarifying"]),
  confidence: z.enum(["high", "medium", "low"]),
  reason: z.string().optional(),
});

export type PendingDecisionUnclearClassification = z.infer<
  typeof PendingDecisionUnclearClassificationSchema
>;

export interface PendingDecisionUnclearClassifierInput {
  message: string;
  gate: PendingDecisionUnclearGate;
  caseSummary?: string | null;
}

export interface PendingDecisionUnclearClassifierModel {
  classify(
    input: PendingDecisionUnclearClassifierInput
  ): Promise<unknown>;
}

function normalizeClassification(
  value: unknown
): PendingDecisionUnclearClassification | null {
  const parsed = PendingDecisionUnclearClassificationSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseJsonContent(content: unknown) {
  if (typeof content !== "string") return content;
  const trimmed = content.trim();
  if (!trimmed) return null;
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return JSON.parse(fenced?.[1] ?? trimmed);
}

function gateContext(gate: PendingDecisionUnclearGate): string {
  if (gate === "listing_description_review") {
    return [
      "Pending gate: listing_description_review.",
      "The user was asked to approve, request changes, or ask for the full draft of a commercial listing description.",
      "release_to_agent when the message is clearly NOT answering that review (side question, status/price question, courtesy with no decision, unrelated chat).",
      "keep_clarifying when the message looks like a fuzzy answer to this review (possible approve/change) that still needs a clearer yes/no or change request.",
    ].join(" ");
  }
  return [
    "Pending gate: contract_data_review.",
    "The user was asked to provide missing contract commercial fields (owner email, commission, exclusivity, duration, collaboration, etc.).",
    "release_to_agent when the message is clearly NOT providing those fields (side question, explanation request, status/price question, unrelated chat).",
    "keep_clarifying when the message looks like an incomplete or ambiguous attempt to provide contract data.",
  ].join(" ");
}

function buildClassifierPrompt(input: PendingDecisionUnclearClassifierInput) {
  return [
    "You are a strict JSON classifier for a Spanish real-estate operational HITL gate.",
    "A deterministic parser already failed to understand this message while a pending decision is open.",
    "Decide whether to release the turn to the conversational agent, or keep asking the user to clarify for this gate.",
    "Return ONLY compact JSON matching:",
    '{"disposition":"release_to_agent|keep_clarifying","confidence":"high|medium|low","reason"?:string}',
    "",
    "Rules:",
    "- Never invent an approval, adjustment, or data patch.",
    "- Prefer keep_clarifying when unsure whether the user is answering this gate.",
    "- Prefer release_to_agent only when the message is clearly a side question / unrelated / courtesy with no decision intent.",
    "- Use low confidence when the message is genuinely ambiguous.",
    "",
    gateContext(input.gate),
    input.caseSummary ? `case: ${input.caseSummary}` : "",
    `message: ${JSON.stringify(input.message)}`,
  ]
    .filter(Boolean)
    .join("\n");
}

async function invokeOpenRouterClassifier(
  input: PendingDecisionUnclearClassifierInput
) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;
  const model = OPERATIONAL_CONVERSATION_CLASSIFIER_MODEL_ID;
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
      max_tokens: 120,
      response_format: { type: "json_object" },
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
    console.warn(
      "[pending-decision-unclear-classifier] OpenRouter failed:",
      response.status,
      await response.text().catch(() => "")
    );
    return null;
  }
  const json = (await response.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  return parseJsonContent(json.choices?.[0]?.message?.content);
}

/**
 * Returns a classification, or null on empty input / model failure.
 * Callers must treat null as keep_clarifying.
 */
export async function classifyPendingDecisionUnclear(
  input: PendingDecisionUnclearClassifierInput,
  model?: PendingDecisionUnclearClassifierModel
): Promise<PendingDecisionUnclearClassification | null> {
  if (!input.message.trim()) return null;
  try {
    const raw = model
      ? await model.classify(input)
      : await invokeOpenRouterClassifier(input);
    return normalizeClassification(raw);
  } catch (error) {
    console.warn("[pending-decision-unclear-classifier] failed:", error);
    return null;
  }
}

/**
 * True when the second opinion says we should fall through to the agent.
 * Low confidence and failures stay on the clarify path.
 */
export function shouldReleaseUnclearToAgent(
  classification: PendingDecisionUnclearClassification | null | undefined
): boolean {
  if (!classification) return false;
  if (classification.disposition !== "release_to_agent") return false;
  return (
    classification.confidence === "high" ||
    classification.confidence === "medium"
  );
}
