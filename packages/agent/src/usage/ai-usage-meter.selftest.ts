/**
 * Selftests for the AI usage meter (flexible-workflows plan, Slice 0.4 / 0.4.1).
 *
 * Covers: provider usage/cost normalization (OpenRouter + LangChain),
 * dual-cost enrichment with the versioned catalog, metadata allowlist
 * (no prompts/responses/tool args), ambient-context attribution, retry
 * attribution, drop-on-missing-context and drop-on-persist-failure (the
 * meter never throws into the user turn), fetch-stash cost fallback, and
 * provider request id extraction without system_fingerprint.
 */
import assert from "node:assert/strict";
import type { LLMResult } from "@langchain/core/outputs";
import type { AiUsageEventInput } from "@agents/types";
import {
  createAiUsageCallbackHandler,
  enrichWithCatalogEstimate,
  extractLangChainProviderRequestId,
  extractLangChainReportedCostMicroUsd,
  flushPendingAiUsageMeterWrites,
  getDroppedAiUsageMeterCount,
  normalizeLangChainUsage,
  normalizeOpenRouterUsage,
  recordAiUsageEvent,
  recordOpenRouterCallUsage,
  sanitizeUsageMetadata,
  setAiUsageRecorder,
  withEstimatedCost,
} from "./ai-usage-meter";
import {
  MODEL_PRICE_CATALOG_VERSION,
  estimateCostMicroUsd,
  getCatalogSnapshot,
} from "./model-price-catalog";
import { runWithAiUsageContext } from "./ai-usage-context";
import {
  clearOpenRouterUsageStash,
  stashOpenRouterUsage,
} from "./openrouter-usage-capture";

function testNormalizeOpenRouterUsageReported(): void {
  const usage = normalizeOpenRouterUsage({
    prompt_tokens: 1200,
    completion_tokens: 340,
    total_tokens: 1540,
    cost: 0.00123,
    prompt_tokens_details: { cached_tokens: 800 },
    completion_tokens_details: { reasoning_tokens: 40 },
  });
  assert.equal(usage.inputTokens, 1200);
  assert.equal(usage.outputTokens, 340);
  assert.equal(usage.totalTokens, 1540);
  assert.equal(usage.cachedInputTokens, 800);
  assert.equal(usage.reasoningTokens, 40);
  assert.equal(usage.reportedCostMicroUsd, 1230);

  // String costs from some provider payloads still normalize.
  assert.equal(
    normalizeOpenRouterUsage({ cost: "0.000045" }).reportedCostMicroUsd,
    45
  );
}

function testNormalizeOpenRouterUsageMissing(): void {
  const usage = normalizeOpenRouterUsage(null);
  assert.equal(usage.inputTokens, null);
  assert.equal(usage.outputTokens, null);
  assert.equal(usage.totalTokens, null);
  assert.equal(usage.cachedInputTokens, null);
  assert.equal(usage.reasoningTokens, null);
  assert.equal(usage.reportedCostMicroUsd, null);
  const garbage = normalizeOpenRouterUsage({
    prompt_tokens: "many",
    completion_tokens: -5,
    cost: "free",
  });
  assert.equal(garbage.inputTokens, null);
  assert.equal(garbage.outputTokens, null);
  assert.equal(garbage.reportedCostMicroUsd, null);
}

function testNormalizeLangChainUsage(): void {
  const viaUsageMetadata = {
    generations: [
      [
        {
          text: "",
          message: {
            usage_metadata: {
              input_tokens: 900,
              output_tokens: 120,
              total_tokens: 1020,
              input_token_details: { cache_read: 500 },
              output_token_details: { reasoning: 30 },
            },
          },
        },
      ],
    ],
    llmOutput: {},
  } as unknown as LLMResult;
  const a = normalizeLangChainUsage(viaUsageMetadata);
  assert.equal(a.inputTokens, 900);
  assert.equal(a.outputTokens, 120);
  assert.equal(a.totalTokens, 1020);
  assert.equal(a.cachedInputTokens, 500);
  assert.equal(a.reasoningTokens, 30);

  const viaTokenUsage = {
    generations: [[{ text: "" }]],
    llmOutput: {
      tokenUsage: { promptTokens: 70, completionTokens: 15, totalTokens: 85 },
    },
  } as unknown as LLMResult;
  const b = normalizeLangChainUsage(viaTokenUsage);
  assert.equal(b.inputTokens, 70);
  assert.equal(b.outputTokens, 15);
  assert.equal(b.totalTokens, 85);
  assert.equal(b.cachedInputTokens, null);
  assert.equal(b.reasoningTokens, null);

  const empty = normalizeLangChainUsage({
    generations: [[{ text: "" }]],
    llmOutput: {},
  } as unknown as LLMResult);
  assert.equal(empty.inputTokens, null);
  assert.equal(empty.totalTokens, null);
}

function testExtractLangChainReportedCostAndId(): void {
  clearOpenRouterUsageStash();

  // Prefer response_metadata.usage.cost (when ChatOpenAI copied it).
  const viaResponseUsage = {
    generations: [
      [
        {
          text: "",
          message: {
            id: "gen-meta",
            response_metadata: { usage: { cost: 0.00123 } },
          },
        },
      ],
    ],
    llmOutput: {},
  } as unknown as LLMResult;
  assert.equal(extractLangChainReportedCostMicroUsd(viaResponseUsage), 1230);
  assert.equal(extractLangChainProviderRequestId(viaResponseUsage), "gen-meta");

  // Fallback: __raw_response.usage.cost without system_fingerprint.
  const viaRaw = {
    generations: [
      [
        {
          text: "",
          message: {
            id: "gen-raw",
            additional_kwargs: {
              __raw_response: {
                id: "gen-raw",
                usage: {
                  prompt_tokens: 10,
                  completion_tokens: 2,
                  cost: 0.000045,
                },
              },
            },
          },
        },
      ],
    ],
    llmOutput: {},
  } as unknown as LLMResult;
  assert.equal(extractLangChainReportedCostMicroUsd(viaRaw), 45);

  // HTTP stash fallback when LangChain dropped usage.cost entirely.
  stashOpenRouterUsage("gen-stash", {
    prompt_tokens: 11,
    completion_tokens: 3,
    cost: 0.000099,
  });
  const viaStash = {
    generations: [
      [
        {
          text: "",
          message: {
            id: "gen-stash",
            additional_kwargs: { __raw_response: { id: "gen-stash" } },
          },
        },
      ],
    ],
    llmOutput: {},
  } as unknown as LLMResult;
  assert.equal(extractLangChainReportedCostMicroUsd(viaStash), 99);

  // No cost → null (caller still stamps catalog estimate separately).
  assert.equal(
    extractLangChainReportedCostMicroUsd({
      generations: [[{ text: "", message: {} }]],
      llmOutput: {},
    } as unknown as LLMResult),
    null
  );
}

function testDualCostEnrichment(): void {
  // Reported present: estimate ALSO stamped for comparison (Slice 0.4.1).
  const withReported = enrichWithCatalogEstimate("openai/gpt-5.4-mini", {
    userId: "u",
    operation: "chat_completion",
    modelId: "openai/gpt-5.4-mini",
    modelRole: "main_agent",
    inputTokens: 1000,
    outputTokens: 100,
    reportedCostMicroUsd: 45,
  });
  assert.equal(withReported.reportedCostMicroUsd, 45);
  // 1000*0.75 + 100*4.5 = 750 + 450 = 1200 micro
  assert.equal(withReported.estimatedCostMicroUsd, 1200);
  assert.equal(withReported.pricingVersion, MODEL_PRICE_CATALOG_VERSION);

  // Alias still works.
  const aliased = withEstimatedCost("openai/gpt-4o-mini", {
    userId: "u1",
    operation: "chat_completion",
    modelId: "openai/gpt-4o-mini",
    modelRole: "main_agent",
    inputTokens: 1000,
    outputTokens: 500,
    reportedCostMicroUsd: null,
  });
  assert.equal(aliased.estimatedCostMicroUsd, 450);
  assert.equal(aliased.pricingVersion, MODEL_PRICE_CATALOG_VERSION);

  // Unknown model: no guess.
  const unknown = enrichWithCatalogEstimate("acme/imaginary-model", {
    userId: "u",
    operation: "chat_completion",
    modelId: "acme/imaginary-model",
    modelRole: "main_agent",
    inputTokens: 10,
    outputTokens: 1,
  });
  assert.equal(unknown.estimatedCostMicroUsd, undefined);
  assert.equal(
    estimateCostMicroUsd("acme/imaginary-model", { inputTokens: 10 }),
    null
  );

  // Historical snapshot remains reproducible for append-only audits.
  const historical = getCatalogSnapshot("2026-07-29.1");
  assert.ok(historical);
  assert.equal(historical!.models["openai/gpt-5.4-mini"]?.inputUsdPerMTok, 0.6);
  assert.equal(
    estimateCostMicroUsd(
      "openai/gpt-5.4-mini",
      { inputTokens: 1000, outputTokens: 0 },
      "2026-07-29.1"
    ),
    600
  );
}

function testCacheAwareEstimate(): void {
  // 1000 input with 800 cached @ cache-read 0.075, uncached 200 @ 0.75, out 0
  // = 200*0.75 + 800*0.075 = 150 + 60 = 210 micro
  const estimate = estimateCostMicroUsd("openai/gpt-5.4-mini", {
    inputTokens: 1000,
    outputTokens: 0,
    cachedInputTokens: 800,
  });
  assert.equal(estimate, 210);
}

function testMetadataAllowlist(): void {
  const sanitized = sanitizeUsageMetadata({
    prompt: "SECRET PROMPT",
    response_text: "SECRET RESPONSE",
    user_message: "hola",
    tool_arguments: "{}",
    api_key: "sk-123",
    worker_profile: "fast",
    attempt: 2,
    cached: true,
    note: null,
    nested_object: { keep: "no" },
    long_value: "x".repeat(500),
  });
  assert.ok(sanitized);
  assert.deepEqual(Object.keys(sanitized!).sort(), [
    "attempt",
    "cached",
    "long_value",
    "note",
    "worker_profile",
  ]);
  assert.equal(sanitized!.worker_profile, "fast");
  assert.equal((sanitized!.long_value as string).length, 200);
  assert.equal(sanitizeUsageMetadata(null), undefined);
  assert.equal(sanitizeUsageMetadata({ prompt: "x" }), undefined);
}

async function testRecordOpenRouterCallUsageAttribution(): Promise<void> {
  const recorded: AiUsageEventInput[] = [];
  setAiUsageRecorder((event) => {
    recorded.push(event);
  });
  try {
    await runWithAiUsageContext(
      {
        userId: "user-1",
        channel: "telegram",
        sessionId: "session-1",
        turnId: "turn-1",
        operationalCaseId: "case-1",
      },
      null,
      () =>
        recordOpenRouterCallUsage({
          modelId: "openai/gpt-4o-mini",
          modelRole: "operational_conversation_classifier",
          operation: "classification",
          usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
          providerRequestId: "gen-abc",
          latencyMs: 321,
          retryOrdinal: 1,
        })
    );
  } finally {
    setAiUsageRecorder(null);
  }
  assert.equal(recorded.length, 1);
  const event = recorded[0]!;
  assert.equal(event.userId, "user-1");
  assert.equal(event.channel, "telegram");
  assert.equal(event.sessionId, "session-1");
  assert.equal(event.turnId, "turn-1");
  assert.equal(event.operationalCaseId, "case-1");
  assert.equal(event.inputTokens, 100);
  assert.equal(event.outputTokens, 10);
  assert.equal(event.providerRequestId, "gen-abc");
  assert.equal(event.latencyMs, 321);
  assert.equal(event.retryOrdinal, 1);
  assert.equal(event.status, "ok");
  assert.equal(event.estimatedCostMicroUsd, 21);
  assert.equal(event.pricingVersion, MODEL_PRICE_CATALOG_VERSION);
}

async function testRecordAiUsageEventAlwaysEnrichesEstimate(): Promise<void> {
  const recorded: AiUsageEventInput[] = [];
  setAiUsageRecorder((event) => {
    recorded.push(event);
  });
  try {
    await recordAiUsageEvent({
      userId: "user-enrich",
      operation: "chat_completion",
      modelId: "openai/gpt-5.4-mini",
      modelRole: "main_agent",
      inputTokens: 100,
      outputTokens: 20,
      reportedCostMicroUsd: 999,
      // Intentionally omit estimatedCostMicroUsd — choke-point must stamp it.
    });
  } finally {
    setAiUsageRecorder(null);
  }
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]!.reportedCostMicroUsd, 999);
  assert.ok(recorded[0]!.estimatedCostMicroUsd != null);
  assert.equal(recorded[0]!.pricingVersion, MODEL_PRICE_CATALOG_VERSION);
}

async function testRecordWithoutContextDrops(): Promise<void> {
  const recorded: AiUsageEventInput[] = [];
  setAiUsageRecorder((event) => {
    recorded.push(event);
  });
  const droppedBefore = getDroppedAiUsageMeterCount();
  try {
    await recordOpenRouterCallUsage({
      modelId: "openai/gpt-4o-mini",
      modelRole: "embeddings",
      operation: "embedding",
      usage: { prompt_tokens: 5 },
    });
  } finally {
    setAiUsageRecorder(null);
  }
  assert.equal(recorded.length, 0);
  assert.equal(getDroppedAiUsageMeterCount(), droppedBefore + 1);
}

async function testPersistenceFailureNeverThrows(): Promise<void> {
  setAiUsageRecorder(() => {
    throw new Error("simulated persist failure");
  });
  const droppedBefore = getDroppedAiUsageMeterCount();
  try {
    await runWithAiUsageContext({ userId: "user-2", channel: "web" }, null, () =>
      recordOpenRouterCallUsage({
        modelId: "openai/gpt-4o-mini",
        modelRole: "listing_description_change_classifier",
        operation: "classification",
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      })
    );
  } finally {
    setAiUsageRecorder(null);
  }
  assert.equal(getDroppedAiUsageMeterCount(), droppedBefore + 1);
}

async function testCallbackHandlerRecordsLlmEnd(): Promise<void> {
  clearOpenRouterUsageStash();
  const recorded: AiUsageEventInput[] = [];
  setAiUsageRecorder((event) => {
    recorded.push(event);
  });
  try {
    const handler = createAiUsageCallbackHandler({
      modelId: "openai/gpt-5.4-mini",
      modelRole: "main_agent",
    }) as unknown as {
      handleChatModelStart: (
        llm: unknown,
        messages: unknown,
        runId: string
      ) => Promise<void>;
      handleLLMEnd: (output: LLMResult, runId: string) => Promise<void>;
      handleLLMError: (error: unknown, runId: string) => Promise<void>;
    };
    const output = {
      generations: [
        [
          {
            text: "",
            message: {
              id: "gen-callback-1",
              usage_metadata: {
                input_tokens: 2000,
                output_tokens: 400,
                total_tokens: 2400,
              },
              additional_kwargs: {
                __raw_response: {
                  id: "gen-callback-1",
                  usage: {
                    prompt_tokens: 2000,
                    completion_tokens: 400,
                    total_tokens: 2400,
                    cost: 0.00216,
                  },
                },
              },
            },
          },
        ],
      ],
      llmOutput: {},
    } as unknown as LLMResult;
    await runWithAiUsageContext(
      { userId: "user-3", channel: "web", sessionId: "s3", turnId: "t3" },
      null,
      async () => {
        await handler.handleChatModelStart({}, [], "run-1");
        await handler.handleLLMEnd(output, "run-1");
        await handler.handleChatModelStart({}, [], "run-2");
        await handler.handleLLMError(new Error("boom"), "run-2");
      }
    );
  } finally {
    setAiUsageRecorder(null);
  }
  assert.equal(recorded.length, 2);
  const ok = recorded[0]!;
  assert.equal(ok.userId, "user-3");
  assert.equal(ok.modelId, "openai/gpt-5.4-mini");
  assert.equal(ok.modelRole, "main_agent");
  assert.equal(ok.inputTokens, 2000);
  assert.equal(ok.outputTokens, 400);
  assert.equal(ok.status, "ok");
  assert.equal(ok.providerRequestId, "gen-callback-1");
  assert.ok(typeof ok.latencyMs === "number" && ok.latencyMs >= 0);
  assert.equal(ok.reportedCostMicroUsd, 2160);
  // Dual storage: catalog estimate also stamped (2000*0.75 + 400*4.5 = 3300).
  assert.equal(ok.estimatedCostMicroUsd, 3300);
  assert.equal(ok.pricingVersion, MODEL_PRICE_CATALOG_VERSION);
  const err = recorded[1]!;
  assert.equal(err.status, "error");
  assert.equal(err.errorCode, "boom");
}

async function testCallbackUsesFetchStashWhenRawMissing(): Promise<void> {
  clearOpenRouterUsageStash();
  stashOpenRouterUsage("gen-from-fetch", {
    prompt_tokens: 50,
    completion_tokens: 5,
    cost: 0.000012,
  });
  const recorded: AiUsageEventInput[] = [];
  setAiUsageRecorder((event) => {
    recorded.push(event);
  });
  try {
    const handler = createAiUsageCallbackHandler({
      modelId: "anthropic/claude-haiku-4.5",
      modelRole: "skill_selector",
    }) as unknown as {
      handleChatModelStart: (
        llm: unknown,
        messages: unknown,
        runId: string
      ) => Promise<void>;
      handleLLMEnd: (output: LLMResult, runId: string) => Promise<void>;
    };
    // Shape mirrors LangChain without system_fingerprint and without usage.cost
    // on the message — only the HTTP stash has the billed cost.
    const output = {
      generations: [
        [
          {
            text: "",
            message: {
              id: "gen-from-fetch",
              usage_metadata: {
                input_tokens: 50,
                output_tokens: 5,
                total_tokens: 55,
              },
            },
          },
        ],
      ],
      llmOutput: {},
    } as unknown as LLMResult;
    await runWithAiUsageContext(
      { userId: "user-4", channel: "web", turnId: "t4" },
      null,
      async () => {
        await handler.handleChatModelStart({}, [], "run-stash");
        await handler.handleLLMEnd(output, "run-stash");
      }
    );
  } finally {
    setAiUsageRecorder(null);
    clearOpenRouterUsageStash();
  }
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]!.reportedCostMicroUsd, 12);
  assert.equal(recorded[0]!.providerRequestId, "gen-from-fetch");
  assert.ok(recorded[0]!.estimatedCostMicroUsd != null);
}

async function testFlushPendingMeterWrites(): Promise<void> {
  let resolveWrite: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    resolveWrite = resolve;
  });
  const recorded: AiUsageEventInput[] = [];
  setAiUsageRecorder(async (event) => {
    await gate;
    recorded.push(event);
  });
  try {
    const pending = recordAiUsageEvent({
      userId: "user-flush",
      operation: "chat_completion",
      modelId: "openai/gpt-5.4-mini",
      modelRole: "main_agent",
      inputTokens: 1,
      outputTokens: 1,
    });
    assert.equal(recorded.length, 0);
    resolveWrite?.();
    await flushPendingAiUsageMeterWrites();
    await pending;
    assert.equal(recorded.length, 1);
  } finally {
    setAiUsageRecorder(null);
  }
}

async function main(): Promise<void> {
  testNormalizeOpenRouterUsageReported();
  testNormalizeOpenRouterUsageMissing();
  testNormalizeLangChainUsage();
  testExtractLangChainReportedCostAndId();
  testDualCostEnrichment();
  testCacheAwareEstimate();
  testMetadataAllowlist();
  await testRecordOpenRouterCallUsageAttribution();
  await testRecordAiUsageEventAlwaysEnrichesEstimate();
  await testRecordWithoutContextDrops();
  await testPersistenceFailureNeverThrows();
  await testCallbackHandlerRecordsLlmEnd();
  await testCallbackUsesFetchStashWhenRawMissing();
  await testFlushPendingMeterWrites();
  console.log("ai-usage-meter selftest: all 14 cases passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
