/**
 * Opt-in live probe: one tiny ChatOpenAI invoke via OpenRouter and assert
 * that reported cost + provider request id are captured.
 *
 * Never runs in CI. Requires:
 *   AI_USAGE_OPENROUTER_PROBE=true
 *   OPENROUTER_API_KEY=...
 *
 * Logs only presence/shape of usage fields — never prompts or completions.
 *
 *   AI_USAGE_OPENROUTER_PROBE=true npm run test:ai-usage-openrouter-probe --workspace @agents/agent
 */
import assert from "node:assert/strict";
import {
  createSkillSelectorModel,
  SKILL_SELECTOR_MODEL_ID,
} from "../model";
import {
  setAiUsageRecorder,
  type AiUsageRecorder,
} from "./ai-usage-meter";
import { runWithAiUsageContext } from "./ai-usage-context";
import { clearOpenRouterUsageStash } from "./openrouter-usage-capture";
import type { AiUsageEventInput } from "@agents/types";

async function main(): Promise<void> {
  if (process.env.AI_USAGE_OPENROUTER_PROBE !== "true") {
    console.log(
      "ai-usage-openrouter-probe: skipped (set AI_USAGE_OPENROUTER_PROBE=true to run)"
    );
    return;
  }
  if (!process.env.OPENROUTER_API_KEY?.trim()) {
    throw new Error("OPENROUTER_API_KEY required for probe");
  }

  clearOpenRouterUsageStash();
  const recorded: AiUsageEventInput[] = [];
  const recorder: AiUsageRecorder = (event) => {
    recorded.push(event);
  };
  setAiUsageRecorder(recorder);

  try {
    const model = createSkillSelectorModel();
    await runWithAiUsageContext(
      {
        userId: "probe-user",
        channel: "web",
        turnId: `probe-${Date.now()}`,
      },
      null,
      async () => {
        await model.invoke([
          {
            role: "user",
            content: 'Reply with JSON only: {"skill_id":null}',
          },
        ]);
      }
    );
  } finally {
    setAiUsageRecorder(null);
    clearOpenRouterUsageStash();
  }

  assert.ok(recorded.length >= 1, "expected at least one usage event");
  const event = recorded[0]!;
  console.log(
    JSON.stringify({
      model_id: event.modelId,
      model_role: event.modelRole,
      has_reported_cost: event.reportedCostMicroUsd != null,
      reported_cost_micro_usd: event.reportedCostMicroUsd,
      estimated_cost_micro_usd: event.estimatedCostMicroUsd ?? null,
      provider_request_id_present: Boolean(event.providerRequestId),
      input_tokens: event.inputTokens,
      output_tokens: event.outputTokens,
    })
  );

  assert.equal(event.modelId, SKILL_SELECTOR_MODEL_ID);
  assert.equal(event.modelRole, "skill_selector");
  assert.ok(
    event.reportedCostMicroUsd != null,
    "expected OpenRouter usage.cost on LangChain path"
  );
  assert.ok(
    event.providerRequestId,
    "expected provider_request_id from OpenRouter generation id"
  );
  assert.ok(
    event.estimatedCostMicroUsd != null,
    "expected dual-cost catalog estimate"
  );
  console.log("ai-usage-openrouter-probe: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
