/**
 * AI usage meter (flexible-workflows plan, Slice 0.4 / 0.4.1 / Technical Plan §23).
 *
 * Normalizes provider usage metadata (LangChain callbacks + raw OpenRouter
 * responses) into append-only `ai_usage_events` rows. Design rules:
 *
 *   - one model call = one event; retries append NEW events with
 *     `retry_ordinal + 1`, never overwrite the first;
 *   - reported (provider) and estimated (price catalog) cost are preserved
 *     separately; estimates are always stamped when tokens+catalog allow
 *     (comparison), while accounted cost is `reported ?? estimated ?? 0`;
 *   - unknown token categories stay `null`;
 *   - a metering failure logs a structured error and increments a dropped
 *     counter but NEVER fails the user turn;
 *   - metadata is allowlisted: primitives only, content-like keys dropped —
 *     never prompts, responses, tool arguments or secrets.
 *
 * Flag: `AI_USAGE_METERING_ENABLED=true` per environment. Off by default
 * (local/test) unless a fixture recorder is injected via
 * `setAiUsageRecorder`.
 */
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { LLMResult } from "@langchain/core/outputs";
import { insertAiUsageEvent, type DbClient } from "@agents/db";
import type {
  AiUsageEventInput,
  AiUsageOperation,
  AiUsageTokenBreakdown,
} from "@agents/types";
import {
  MODEL_PRICE_CATALOG_VERSION,
  estimateCostMicroUsd,
} from "./model-price-catalog";
import { currentAiUsageContext } from "./ai-usage-context";
import { takeStashedOpenRouterUsage } from "./openrouter-usage-capture";

export type AiUsageRecorder = (event: AiUsageEventInput) => Promise<void> | void;

let injectedRecorder: AiUsageRecorder | null = null;
let droppedMeterCount = 0;
/** In-flight persist promises (covers fire-and-forget call sites before exit). */
const pendingMeterWrites = new Set<Promise<void>>();

/** Test/fixture hook: bypasses the env flag and DB persistence. */
export function setAiUsageRecorder(recorder: AiUsageRecorder | null): void {
  injectedRecorder = recorder;
}

export function getDroppedAiUsageMeterCount(): number {
  return droppedMeterCount;
}

export function isAiUsageMeteringEnabled(): boolean {
  if (injectedRecorder) return true;
  return process.env.AI_USAGE_METERING_ENABLED === "true";
}

function trackMeterWrite(write: Promise<void>): Promise<void> {
  pendingMeterWrites.add(write);
  void write.finally(() => {
    pendingMeterWrites.delete(write);
  });
  return write;
}

/**
 * Wait for in-flight meter persists. CLI/eval entry points should call this
 * before process.exit so `void recordOpenRouterCallUsage(...)` does not drop.
 */
export async function flushPendingAiUsageMeterWrites(): Promise<void> {
  while (pendingMeterWrites.size > 0) {
    await Promise.allSettled([...pendingMeterWrites]);
  }
}

// ── Metadata allowlist ───────────────────────────────────────────────────────

/** Content-like keys never enter metadata_jsonb, regardless of value. */
const METADATA_KEY_BLOCKLIST =
  /(prompt|response|message|content|text|input|output|args|arguments|token$|secret|key|authorization)/i;

export function sanitizeUsageMetadata(
  metadata: Record<string, unknown> | null | undefined
): Record<string, string | number | boolean | null> | undefined {
  if (!metadata) return undefined;
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (METADATA_KEY_BLOCKLIST.test(key)) continue;
    if (value === null) {
      out[key] = null;
    } else if (typeof value === "boolean" || typeof value === "number") {
      out[key] = value;
    } else if (typeof value === "string") {
      out[key] = value.slice(0, 200);
    }
    // objects/arrays dropped: metadata is flat and content-free by design
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// ── Provider usage normalization (pure, unit-tested) ────────────────────────

/** Raw `usage` object of an OpenRouter (OpenAI-compatible) response. */
export interface OpenRouterUsagePayload {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  total_tokens?: unknown;
  /** OpenRouter includes billed cost in USD when usage accounting is on. */
  cost?: unknown;
  prompt_tokens_details?: { cached_tokens?: unknown } | null;
  completion_tokens_details?: { reasoning_tokens?: unknown } | null;
}

function asCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

function asCostMicroUsd(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.round(value * 1_000_000);
  }
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) return Math.round(n * 1_000_000);
  }
  return null;
}

export function normalizeOpenRouterUsage(
  usage: OpenRouterUsagePayload | null | undefined
): AiUsageTokenBreakdown & { reportedCostMicroUsd: number | null } {
  if (!usage) {
    return {
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      cachedInputTokens: null,
      reasoningTokens: null,
      reportedCostMicroUsd: null,
    };
  }
  return {
    inputTokens: asCount(usage.prompt_tokens),
    outputTokens: asCount(usage.completion_tokens),
    totalTokens: asCount(usage.total_tokens),
    cachedInputTokens: asCount(usage.prompt_tokens_details?.cached_tokens),
    reasoningTokens: asCount(usage.completion_tokens_details?.reasoning_tokens),
    reportedCostMicroUsd: asCostMicroUsd(usage.cost),
  };
}

type LangChainMessageUsage = {
  id?: unknown;
  usage_metadata?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
    total_tokens?: unknown;
    input_token_details?: { cache_read?: unknown } | null;
    output_token_details?: { reasoning?: unknown } | null;
  } | null;
  response_metadata?: {
    cost?: unknown;
    usage?: OpenRouterUsagePayload | null;
  } | null;
  additional_kwargs?: {
    __raw_response?: {
      id?: unknown;
      usage?: OpenRouterUsagePayload | null;
    } | null;
  } | null;
};

function firstLangChainMessage(
  output: LLMResult
): LangChainMessageUsage | null {
  const generation = output.generations?.[0]?.[0] as
    | { message?: LangChainMessageUsage | null }
    | undefined;
  return generation?.message ?? null;
}

/**
 * OpenRouter generation / request id from a LangChain `LLMResult`.
 * Prefer AIMessage.id (set from rawResponse.id), then __raw_response.id.
 */
export function extractLangChainProviderRequestId(
  output: LLMResult
): string | null {
  const message = firstLangChainMessage(output);
  const candidates: unknown[] = [
    message?.id,
    message?.additional_kwargs?.__raw_response?.id,
  ];
  for (const id of candidates) {
    if (typeof id === "string" && id.trim().length > 0) return id.trim();
  }
  return null;
}

/**
 * OpenRouter billed cost (USD → micro-USD) from a LangChain `LLMResult`.
 *
 * Order: response_metadata (when ChatOpenAI copied usage), then
 * `__raw_response.usage.cost`, then the HTTP fetch stash keyed by
 * generation id (see `openrouter-usage-capture.ts`).
 */
export function extractLangChainReportedCostMicroUsd(
  output: LLMResult,
  options?: { providerRequestId?: string | null }
): number | null {
  const message = firstLangChainMessage(output);
  const candidates: unknown[] = [
    message?.response_metadata?.cost,
    message?.response_metadata?.usage?.cost,
    message?.additional_kwargs?.__raw_response?.usage?.cost,
  ];
  for (const cost of candidates) {
    const micro = asCostMicroUsd(cost);
    if (micro != null) return micro;
  }

  const id =
    options?.providerRequestId ?? extractLangChainProviderRequestId(output);
  const stashed = takeStashedOpenRouterUsage(id);
  if (stashed) {
    const micro = asCostMicroUsd(stashed.usage.cost);
    if (micro != null) return micro;
  }
  return null;
}

/** Token usage from a LangChain `LLMResult` (callback boundary). */
export function normalizeLangChainUsage(output: LLMResult): AiUsageTokenBreakdown {
  const tokenUsage =
    (output.llmOutput?.tokenUsage as
      | { promptTokens?: unknown; completionTokens?: unknown; totalTokens?: unknown }
      | undefined) ?? undefined;
  const message = firstLangChainMessage(output);
  const usageMetadata = message?.usage_metadata;
  const rawUsage = message?.additional_kwargs?.__raw_response?.usage;
  return {
    inputTokens:
      asCount(usageMetadata?.input_tokens) ??
      asCount(rawUsage?.prompt_tokens) ??
      asCount(tokenUsage?.promptTokens),
    outputTokens:
      asCount(usageMetadata?.output_tokens) ??
      asCount(rawUsage?.completion_tokens) ??
      asCount(tokenUsage?.completionTokens),
    totalTokens:
      asCount(usageMetadata?.total_tokens) ??
      asCount(rawUsage?.total_tokens) ??
      asCount(tokenUsage?.totalTokens),
    cachedInputTokens:
      asCount(usageMetadata?.input_token_details?.cache_read) ??
      asCount(rawUsage?.prompt_tokens_details?.cached_tokens),
    reasoningTokens:
      asCount(usageMetadata?.output_token_details?.reasoning) ??
      asCount(rawUsage?.completion_tokens_details?.reasoning_tokens),
  };
}

/**
 * Always attach a catalog estimate (+ pricing_version) when tokens and a
 * catalog entry exist. Never overwrites `reportedCostMicroUsd`.
 */
export function enrichWithCatalogEstimate(
  modelId: string,
  event: AiUsageEventInput
): AiUsageEventInput {
  const estimate = estimateCostMicroUsd(modelId, {
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    cachedInputTokens: event.cachedInputTokens,
  });
  if (estimate == null) return event;
  return {
    ...event,
    estimatedCostMicroUsd: estimate,
    pricingVersion: MODEL_PRICE_CATALOG_VERSION,
  };
}

/**
 * @deprecated Prefer `enrichWithCatalogEstimate`. Kept as a named export for
 * call-site compatibility; now always stamps an estimate when possible.
 */
export function withEstimatedCost(
  modelId: string,
  event: AiUsageEventInput
): AiUsageEventInput {
  return enrichWithCatalogEstimate(modelId, event);
}

// ── Persistence (best effort, never blocks the turn) ────────────────────────

export async function recordAiUsageEvent(
  input: AiUsageEventInput,
  dbOverride?: DbClient | null
): Promise<void> {
  // Single choke-point: always stamp catalog estimate when model+tokens allow,
  // so no call site can persist reported-only rows by accident.
  const enriched = enrichWithCatalogEstimate(input.modelId, input);
  const persist = async (): Promise<void> => {
    if (injectedRecorder) {
      try {
        await injectedRecorder(enriched);
      } catch (recorderError) {
        droppedMeterCount += 1;
        console.error("[ai-usage-meter] injected recorder failed", {
          model_id: enriched.modelId,
          model_role: enriched.modelRole,
          error:
            recorderError instanceof Error
              ? recorderError.message
              : String(recorderError),
        });
      }
      return;
    }
    if (process.env.AI_USAGE_METERING_ENABLED !== "true") return;
    const store = currentAiUsageContext();
    const db = dbOverride ?? store?.db ?? null;
    if (!db) {
      droppedMeterCount += 1;
      console.error("[ai-usage-meter] dropped event: no db client bound", {
        model_id: enriched.modelId,
        model_role: enriched.modelRole,
      });
      return;
    }
    try {
      await insertAiUsageEvent(db, {
        ...enriched,
        metadata: sanitizeUsageMetadata(enriched.metadata),
      });
    } catch (persistError) {
      droppedMeterCount += 1;
      console.error("[ai-usage-meter] dropped event: persist failed", {
        model_id: enriched.modelId,
        model_role: enriched.modelRole,
        user_id: enriched.userId,
        error:
          persistError instanceof Error
            ? persistError.message
            : String(persistError),
      });
    }
  };
  await trackMeterWrite(persist());
}

/**
 * Convenience for direct OpenRouter `fetch` call sites (classifiers,
 * extractors, vision, embeddings). Reads attribution from the ambient
 * context; without one the event is dropped (counted) because it cannot be
 * tenant-attributed.
 */
export async function recordOpenRouterCallUsage(params: {
  modelId: string;
  modelRole: string;
  operation: AiUsageOperation;
  usage?: OpenRouterUsagePayload | null;
  providerRequestId?: string | null;
  latencyMs?: number | null;
  status?: "ok" | "error";
  errorCode?: string | null;
  retryOrdinal?: number;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  if (!isAiUsageMeteringEnabled()) return;
  const store = currentAiUsageContext();
  if (!store?.context.userId) {
    droppedMeterCount += 1;
    console.error("[ai-usage-meter] dropped event: no ambient context", {
      model_id: params.modelId,
      model_role: params.modelRole,
    });
    return;
  }
  const usage = normalizeOpenRouterUsage(params.usage);
  const base: AiUsageEventInput = {
    userId: store.context.userId,
    operation: params.operation,
    modelId: params.modelId,
    modelRole: params.modelRole,
    channel: store.context.channel ?? null,
    sessionId: store.context.sessionId ?? null,
    turnId: store.context.turnId ?? null,
    operationalCaseId: store.context.operationalCaseId ?? null,
    workflowDefinitionId: store.context.workflowDefinitionId ?? null,
    studioQualificationRunId:
      store.context.studioQualificationRunId ?? null,
    workItemId: store.context.workItemId ?? null,
    workItemAttemptId: store.context.workItemAttemptId ?? null,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    cachedInputTokens: usage.cachedInputTokens,
    reasoningTokens: usage.reasoningTokens,
    reportedCostMicroUsd: usage.reportedCostMicroUsd,
    latencyMs: params.latencyMs,
    status: params.status ?? "ok",
    errorCode: params.errorCode ?? null,
    retryOrdinal: params.retryOrdinal ?? 0,
    providerRequestId: params.providerRequestId ?? null,
    metadata: sanitizeUsageMetadata(params.metadata),
  };
  await recordAiUsageEvent(enrichWithCatalogEstimate(params.modelId, base));
}

// ── LangChain callback boundary (shared model factories) ────────────────────

/**
 * Callback handler attached by the `model.ts` factories. One `handleLLMEnd`
 * = one event. Attribution comes from the ambient context at call time (the
 * factories are created per turn inside `runAgent`/entry points).
 */
export function createAiUsageCallbackHandler(params: {
  modelId: string;
  modelRole: string;
}): BaseCallbackHandler {
  const startTimes = new Map<string, number>();

  class AiUsageCallbackHandler extends BaseCallbackHandler {
    name = "ai-usage-meter";

    override async handleChatModelStart(
      _llm: unknown,
      _messages: unknown,
      runId: string
    ): Promise<void> {
      startTimes.set(runId, Date.now());
    }

    override async handleLLMStart(
      _llm: unknown,
      _prompts: string[],
      runId: string
    ): Promise<void> {
      startTimes.set(runId, Date.now());
    }

    override async handleLLMEnd(output: LLMResult, runId: string): Promise<void> {
      const startedAt = startTimes.get(runId);
      startTimes.delete(runId);
      if (!isAiUsageMeteringEnabled()) return;
      const store = currentAiUsageContext();
      if (!store?.context.userId) {
        droppedMeterCount += 1;
        console.error("[ai-usage-meter] dropped event: no ambient context", {
          model_id: params.modelId,
          model_role: params.modelRole,
        });
        return;
      }
      const tokens = normalizeLangChainUsage(output);
      const providerRequestId = extractLangChainProviderRequestId(output);
      const reportedCostMicroUsd = extractLangChainReportedCostMicroUsd(output, {
        providerRequestId,
      });
      const event: AiUsageEventInput = {
        userId: store.context.userId,
        operation: "chat_completion",
        modelId: params.modelId,
        modelRole: params.modelRole,
        channel: store.context.channel ?? null,
        sessionId: store.context.sessionId ?? null,
        turnId: store.context.turnId ?? null,
        operationalCaseId: store.context.operationalCaseId ?? null,
        workflowDefinitionId: store.context.workflowDefinitionId ?? null,
        studioQualificationRunId:
          store.context.studioQualificationRunId ?? null,
        workItemId: store.context.workItemId ?? null,
        workItemAttemptId: store.context.workItemAttemptId ?? null,
        ...tokens,
        reportedCostMicroUsd,
        providerRequestId,
        latencyMs: startedAt ? Date.now() - startedAt : null,
        status: "ok",
      };
      await recordAiUsageEvent(enrichWithCatalogEstimate(params.modelId, event));
    }

    override async handleLLMError(error: unknown, runId: string): Promise<void> {
      const startedAt = startTimes.get(runId);
      startTimes.delete(runId);
      if (!isAiUsageMeteringEnabled()) return;
      const store = currentAiUsageContext();
      if (!store?.context.userId) return;
      await recordAiUsageEvent({
        userId: store.context.userId,
        operation: "chat_completion",
        modelId: params.modelId,
        modelRole: params.modelRole,
        channel: store.context.channel ?? null,
        sessionId: store.context.sessionId ?? null,
        turnId: store.context.turnId ?? null,
        operationalCaseId: store.context.operationalCaseId ?? null,
        workflowDefinitionId: store.context.workflowDefinitionId ?? null,
        studioQualificationRunId:
          store.context.studioQualificationRunId ?? null,
        workItemId: store.context.workItemId ?? null,
        workItemAttemptId: store.context.workItemAttemptId ?? null,
        latencyMs: startedAt ? Date.now() - startedAt : null,
        status: "error",
        errorCode:
          error instanceof Error ? error.message.slice(0, 120) : "unknown_error",
      });
    }
  }

  return new AiUsageCallbackHandler();
}

// Work-plane retry counters (Technical Plan §23): closed in Slices 2.3/2.4.
// `runAgent` accepts `workItemId`/`workItemAttemptId` (bound by the
// main-agent executor) and the admin dashboard shows retry rollups via
// `summarizeWorkPlaneRetries`. See plan Slice 2.3 task 5 and Slice 2.4.
