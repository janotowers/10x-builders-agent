import assert from "node:assert/strict";
import type { AiUsageEvent } from "@agents/types";
import {
  aggregateCostComparisonMicroUsd,
  buildAiUsageTenantSections,
  costComparisonMicroUsd,
  effectiveCostMicroUsd,
  effectiveCostSplitMicroUsd,
  estimatedCostCoverage,
  estimatedCostEventCount,
  eventsMissingCatalogEstimate,
  filterAiUsageEvents,
  aiUsageCalendarDay,
  formatAiUsageOccurredAt,
  formatUsdFromMicro,
  paginateItems,
  reportedCostCoverage,
  reportedCostEventCount,
  reportedCostMoneyCoverage,
  rollupAiUsage,
  sortCases,
  sortExecutions,
  sortRollupBuckets,
  summarizeAiUsageByFunction,
  summarizeAiUsageExecutions,
  summarizeAiUsageUncorrelated,
  totalEffectiveCostMicroUsd,
} from "./ai-usage";

function event(
  partial: Partial<AiUsageEvent> & Pick<AiUsageEvent, "id">
): AiUsageEvent {
  return {
    user_id: "u1",
    occurred_at: "2026-07-29T00:00:00.000Z",
    provider: "openrouter",
    resource_type: "ai_model",
    operation: "chat_completion",
    model_id: "openai/gpt-4o-mini",
    model_role: "main_agent",
    channel: "web",
    input_tokens: null,
    output_tokens: null,
    total_tokens: null,
    cached_input_tokens: null,
    reasoning_tokens: null,
    reported_cost_micro_usd: null,
    estimated_cost_micro_usd: null,
    currency: "USD",
    pricing_version: null,
    latency_ms: null,
    status: "ok",
    error_code: null,
    retry_ordinal: 0,
    provider_request_id: null,
    session_id: null,
    turn_id: null,
    operational_case_id: null,
    workflow_definition_id: null,
    work_item_id: null,
    work_item_attempt_id: null,
    metadata_jsonb: {},
    created_at: "2026-07-29T00:00:00.000Z",
    ...partial,
  };
}

function testEffectiveCostNeverDoubleCounts(): void {
  const reported = event({
    id: "1",
    reported_cost_micro_usd: 400,
    estimated_cost_micro_usd: null,
  });
  const estimated = event({
    id: "2",
    reported_cost_micro_usd: null,
    estimated_cost_micro_usd: 8600,
  });
  const neither = event({ id: "3" });
  // Dual-cost row (Slice 0.4.1): accounted still picks reported.
  const both = event({
    id: "4",
    reported_cost_micro_usd: 100,
    estimated_cost_micro_usd: 9999,
  });

  assert.equal(effectiveCostMicroUsd(reported), 400);
  assert.equal(effectiveCostMicroUsd(estimated), 8600);
  assert.equal(effectiveCostMicroUsd(neither), 0);
  assert.equal(effectiveCostMicroUsd(both), 100);

  const events = [reported, estimated, neither, both];
  assert.equal(totalEffectiveCostMicroUsd(events), 400 + 8600 + 0 + 100);
  assert.deepEqual(effectiveCostSplitMicroUsd(events), {
    fromReported: 500,
    fromEstimated: 8600,
  });
  assert.equal(reportedCostEventCount(events), 2);
  assert.equal(reportedCostCoverage(events), 0.5);
  assert.equal(estimatedCostEventCount(events), 2);
  assert.equal(estimatedCostCoverage(events), 0.5);
  // Money coverage: 500 / 9100
  assert.ok(
    Math.abs((reportedCostMoneyCoverage(events) ?? 0) - 500 / 9100) < 1e-9
  );
}

function testEventsMissingCatalogEstimate(): void {
  const missing = eventsMissingCatalogEstimate([
    event({
      id: "ok-dual",
      input_tokens: 10,
      output_tokens: 2,
      reported_cost_micro_usd: 5,
      estimated_cost_micro_usd: 6,
    }),
    event({
      id: "gap-tokens",
      model_id: "openai/gpt-5.4-mini",
      input_tokens: 10,
      output_tokens: 2,
      reported_cost_micro_usd: 5,
      estimated_cost_micro_usd: null,
    }),
    event({
      id: "error-no-tokens",
      input_tokens: null,
      output_tokens: null,
      reported_cost_micro_usd: null,
      estimated_cost_micro_usd: null,
      status: "error",
    }),
  ]);
  assert.equal(missing.length, 1);
  assert.equal(missing[0]!.id, "gap-tokens");
}

function testRollupUsesAccountedNotSumOfColumns(): void {
  const events = [
    event({
      id: "a",
      model_id: "openai/gpt-5.4-mini",
      model_role: "main_agent",
      reported_cost_micro_usd: 5300,
      estimated_cost_micro_usd: 5400,
    }),
    event({
      id: "b",
      model_id: "openai/gpt-5.4-mini",
      model_role: "main_agent",
      reported_cost_micro_usd: null,
      estimated_cost_micro_usd: 100,
    }),
  ];
  const byModel = rollupAiUsage(events, "model");
  assert.equal(byModel.length, 1);
  assert.equal(byModel[0]!.effectiveCostMicroUsd, 5400);
  assert.equal(byModel[0]!.reportedCostMicroUsd, 5300);
  assert.equal(byModel[0]!.estimatedCostMicroUsd, 5500);
  assert.equal(byModel[0]!.comparableCostEvents, 1);
}

function testCostComparison(): void {
  const dual = event({
    id: "c",
    reported_cost_micro_usd: 110,
    estimated_cost_micro_usd: 100,
  });
  assert.deepEqual(costComparisonMicroUsd(dual), {
    reported: 110,
    estimated: 100,
    delta: 10,
    deltaPct: 0.1,
  });
  const agg = aggregateCostComparisonMicroUsd([
    dual,
    event({
      id: "d",
      reported_cost_micro_usd: null,
      estimated_cost_micro_usd: 50,
    }),
  ]);
  assert.equal(agg?.comparableEvents, 1);
  assert.equal(agg?.reported, 110);
}

function testFormatUsdFromMicro(): void {
  assert.equal(formatUsdFromMicro(0), "$0");
  assert.equal(formatUsdFromMicro(1000), "$0.0010");
  assert.equal(formatUsdFromMicro(1), "$0.000001");
}

function testFormatAiUsageOccurredAt(): void {
  assert.equal(
    formatAiUsageOccurredAt("2026-07-29T19:13:00.000Z", "America/Mexico_City"),
    "2026-07-29 13:13"
  );
  assert.equal(
    formatAiUsageOccurredAt("2026-07-29T19:13:00.000Z", "UTC"),
    "2026-07-29 19:13"
  );
  assert.equal(
    formatAiUsageOccurredAt("2026-07-29T19:13:00.000Z", null),
    "2026-07-29 19:13"
  );
  assert.equal(
    formatAiUsageOccurredAt("2026-07-29T19:13:04.500Z", "America/Mexico_City", {
      precision: "second",
    }),
    "2026-07-29 13:13:04"
  );
  assert.equal(
    formatAiUsageOccurredAt("2026-07-29T19:13:04.500Z", "UTC", {
      precision: "second",
    }),
    "2026-07-29 19:13:04"
  );
}

function testDayRollupUsesViewerTimezone(): void {
  // 02:00 UTC on Aug 8 = 20:00 on Aug 7 in America/Mexico_City (UTC-6).
  const lateMexicoEvening = event({
    id: "tz-1",
    occurred_at: "2026-08-08T02:00:00.000Z",
    reported_cost_micro_usd: 1000,
  });
  assert.equal(
    aiUsageCalendarDay(lateMexicoEvening.occurred_at, "America/Mexico_City"),
    "2026-08-07"
  );
  assert.equal(
    aiUsageCalendarDay(lateMexicoEvening.occurred_at, "UTC"),
    "2026-08-08"
  );
  const byMexicoDay = rollupAiUsage([lateMexicoEvening], "day", {
    timeZone: "America/Mexico_City",
  });
  assert.equal(byMexicoDay.length, 1);
  assert.equal(byMexicoDay[0]!.key, "2026-08-07");
  const byUtcDay = rollupAiUsage([lateMexicoEvening], "day");
  assert.equal(byUtcDay[0]!.key, "2026-08-08");
}

function testExecutionWithMultipleFunctionsNoDoubleCount(): void {
  const turnId = "turn-multi";
  const events = [
    event({
      id: "main",
      turn_id: turnId,
      model_role: "main_agent",
      provider: "openrouter",
      model_id: "openai/gpt-5.4-mini",
      operation: "chat_completion",
      occurred_at: "2026-07-29T18:00:00.000Z",
      reported_cost_micro_usd: 5000,
      estimated_cost_micro_usd: 5100,
      input_tokens: 100,
      output_tokens: 50,
    }),
    event({
      id: "clf",
      turn_id: turnId,
      model_role: "operational_conversation_classifier",
      provider: "openrouter",
      model_id: "openai/gpt-4o-mini",
      operation: "chat_completion",
      occurred_at: "2026-07-29T18:00:00.100Z",
      reported_cost_micro_usd: 200,
      estimated_cost_micro_usd: 210,
      input_tokens: 40,
      output_tokens: 10,
    }),
    event({
      id: "sel",
      turn_id: turnId,
      model_role: "skill_selector",
      provider: "openrouter",
      model_id: "openai/gpt-4o-mini",
      operation: "chat_completion",
      occurred_at: "2026-07-29T18:00:00.200Z",
      reported_cost_micro_usd: 150,
      estimated_cost_micro_usd: 160,
      input_tokens: 30,
      output_tokens: 5,
    }),
    event({
      id: "emb",
      turn_id: turnId,
      model_role: "memory_embedding",
      provider: "openrouter",
      model_id: "openai/text-embedding-3-small",
      operation: "embedding",
      occurred_at: "2026-07-29T18:00:00.300Z",
      reported_cost_micro_usd: null,
      estimated_cost_micro_usd: 2,
      input_tokens: 20,
      output_tokens: 0,
    }),
  ];

  const executions = summarizeAiUsageExecutions(events);
  assert.equal(executions.length, 1);
  const execution = executions[0]!;
  assert.equal(execution.turnId, turnId);
  assert.equal(execution.events, 4);
  assert.equal(execution.effectiveCostMicroUsd, 5000 + 200 + 150 + 2);
  assert.equal(execution.startedAt, "2026-07-29T18:00:00.000Z");
  assert.equal(execution.lastOccurredAt, "2026-07-29T18:00:00.300Z");
  assert.equal(execution.byFunction.length, 4);

  const functionTotal = execution.byFunction.reduce(
    (sum, row) => sum + row.effectiveCostMicroUsd,
    0
  );
  assert.equal(functionTotal, execution.effectiveCostMicroUsd);

  const byFunction = summarizeAiUsageByFunction(events);
  assert.equal(byFunction.length, 4);
  assert.equal(
    byFunction.reduce((sum, row) => sum + row.effectiveCostMicroUsd, 0),
    execution.effectiveCostMicroUsd
  );
}

function testUncorrelatedReconcilesWithTenantTotal(): void {
  const events = [
    event({
      id: "corr",
      user_id: "u-a",
      turn_id: "t1",
      reported_cost_micro_usd: 1000,
      estimated_cost_micro_usd: 1100,
    }),
    event({
      id: "orphan-1",
      user_id: "u-a",
      turn_id: null,
      channel: "cron",
      model_role: "heartbeat",
      reported_cost_micro_usd: 50,
      estimated_cost_micro_usd: 55,
    }),
    event({
      id: "orphan-2",
      user_id: "u-a",
      turn_id: null,
      channel: "cron",
      model_role: "heartbeat",
      reported_cost_micro_usd: null,
      estimated_cost_micro_usd: 25,
    }),
  ];

  const sections = buildAiUsageTenantSections(events);
  assert.equal(sections.length, 1);
  const section = sections[0]!;
  assert.equal(section.summary.effectiveCostMicroUsd, 1075);
  assert.equal(section.executions.length, 1);
  assert.ok(section.uncorrelated);
  assert.equal(section.uncorrelated!.events, 2);
  assert.equal(section.uncorrelated!.effectiveCostMicroUsd, 75);
  assert.equal(
    section.executions[0]!.effectiveCostMicroUsd +
      section.uncorrelated!.effectiveCostMicroUsd,
    section.summary.effectiveCostMicroUsd
  );

  const uncorrelated = summarizeAiUsageUncorrelated(events);
  assert.ok(uncorrelated);
  assert.equal(uncorrelated!.byFunction[0]!.modelRole, "heartbeat");
}

function testRecentSortUsesFullTimestamp(): void {
  const events = [
    event({
      id: "early",
      turn_id: "t-early",
      occurred_at: "2026-07-29T18:00:00.000Z",
      reported_cost_micro_usd: 9000,
    }),
    event({
      id: "late-same-minute",
      turn_id: "t-late",
      occurred_at: "2026-07-29T18:00:00.500Z",
      reported_cost_micro_usd: 100,
    }),
    event({
      id: "mid",
      turn_id: "t-mid",
      occurred_at: "2026-07-29T18:00:00.250Z",
      reported_cost_micro_usd: 500,
    }),
  ];
  const executions = summarizeAiUsageExecutions(events);
  assert.deepEqual(
    executions.map((row) => row.turnId),
    ["t-late", "t-mid", "t-early"]
  );

  const byCost = sortExecutions(executions, "cost");
  assert.equal(byCost[0]!.turnId, "t-early");
  assert.equal(byCost[0]!.effectiveCostMicroUsd, 9000);
}

function testCasesSortedByLastActivity(): void {
  const events = [
    event({
      id: "c1a",
      operational_case_id: "case-old",
      turn_id: "t1",
      occurred_at: "2026-07-28T10:00:00.000Z",
      reported_cost_micro_usd: 5000,
    }),
    event({
      id: "c1b",
      operational_case_id: "case-old",
      turn_id: "t2",
      occurred_at: "2026-07-28T11:00:00.000Z",
      reported_cost_micro_usd: 100,
    }),
    event({
      id: "c2",
      operational_case_id: "case-new",
      turn_id: "t3",
      occurred_at: "2026-07-29T09:00:00.000Z",
      reported_cost_micro_usd: 50,
    }),
  ];
  const sections = buildAiUsageTenantSections(events);
  const cases = sections[0]!.cases;
  assert.equal(cases[0]!.operationalCaseId, "case-new");
  assert.equal(cases[0]!.executionCount, 1);
  assert.equal(cases[1]!.operationalCaseId, "case-old");
  assert.equal(cases[1]!.executionCount, 2);
  assert.equal(cases[1]!.firstOccurredAt, "2026-07-28T10:00:00.000Z");
  assert.equal(cases[1]!.lastOccurredAt, "2026-07-28T11:00:00.000Z");

  const byCost = sortCases(cases, "cost");
  assert.equal(byCost[0]!.operationalCaseId, "case-old");
}

function testProviderRollupDynamic(): void {
  const events = [
    event({
      id: "or1",
      provider: "openrouter",
      reported_cost_micro_usd: 100,
    }),
    event({
      id: "g1",
      provider: "google",
      reported_cost_micro_usd: 250,
    }),
    event({
      id: "or2",
      provider: "openrouter",
      reported_cost_micro_usd: 50,
    }),
  ];
  const byProvider = rollupAiUsage(events, "provider");
  assert.equal(byProvider.length, 2);
  assert.equal(byProvider[0]!.key, "google");
  assert.equal(byProvider[0]!.effectiveCostMicroUsd, 250);
  assert.equal(byProvider[1]!.key, "openrouter");
  assert.equal(byProvider[1]!.effectiveCostMicroUsd, 150);
}

function testFilterSortPaginate(): void {
  const events = [
    event({
      id: "1",
      user_id: "u1",
      provider: "openrouter",
      channel: "web",
      model_role: "main_agent",
      model_id: "m1",
      status: "ok",
      reported_cost_micro_usd: 10,
    }),
    event({
      id: "2",
      user_id: "u2",
      provider: "google",
      channel: "telegram",
      model_role: "skill_selector",
      model_id: "m2",
      status: "error",
      reported_cost_micro_usd: 20,
    }),
  ];
  assert.equal(filterAiUsageEvents(events, { provider: "google" }).length, 1);
  assert.equal(filterAiUsageEvents(events, { channel: "web" }).length, 1);
  assert.equal(
    filterAiUsageEvents(events, { modelRole: "skill_selector" }).length,
    1
  );
  assert.equal(filterAiUsageEvents(events, { status: "error" }).length, 1);

  const buckets = rollupAiUsage(events, "model");
  assert.equal(sortRollupBuckets(buckets, "name")[0]!.key, "m1");
  assert.equal(sortRollupBuckets(buckets, "events")[0]!.events, 1);

  const items = Array.from({ length: 23 }, (_, i) => i);
  const page1 = paginateItems(items, 1, 10);
  assert.equal(page1.items.length, 10);
  assert.equal(page1.total, 23);
  assert.equal(page1.totalPages, 3);
  assert.deepEqual(page1.items, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const page3 = paginateItems(items, 3, 10);
  assert.deepEqual(page3.items, [20, 21, 22]);
  const clamped = paginateItems(items, 99, 10);
  assert.equal(clamped.page, 3);
}

function testBuildAiUsageTenantSections(): void {
  const events = [
    event({
      id: "t1a",
      user_id: "u-expensive",
      turn_id: "turn-a",
      channel: "web",
      operational_case_id: "case-1",
      occurred_at: "2026-07-29T18:00:00.000Z",
      reported_cost_micro_usd: 5000,
      estimated_cost_micro_usd: 5100,
    }),
    event({
      id: "t1b",
      user_id: "u-expensive",
      turn_id: "turn-a",
      channel: "web",
      operational_case_id: "case-1",
      occurred_at: "2026-07-29T18:01:00.000Z",
      reported_cost_micro_usd: 2000,
      estimated_cost_micro_usd: 2100,
    }),
    event({
      id: "t2",
      user_id: "u-expensive",
      turn_id: "turn-b",
      channel: "telegram",
      operational_case_id: null,
      occurred_at: "2026-07-29T19:00:00.000Z",
      reported_cost_micro_usd: 100,
      estimated_cost_micro_usd: 100,
    }),
    event({
      id: "other",
      user_id: "u-cheap",
      turn_id: "turn-c",
      channel: "web",
      operational_case_id: "case-2",
      occurred_at: "2026-07-29T20:00:00.000Z",
      reported_cost_micro_usd: 50,
      estimated_cost_micro_usd: 50,
    }),
    event({
      id: "orphan",
      user_id: "u-cheap",
      turn_id: null,
      operational_case_id: null,
      reported_cost_micro_usd: 1,
      estimated_cost_micro_usd: 1,
    }),
  ];

  const sections = buildAiUsageTenantSections(events);
  assert.equal(sections.length, 2);
  assert.equal(sections[0]!.userId, "u-expensive");
  assert.equal(sections[0]!.summary.effectiveCostMicroUsd, 7100);
  assert.equal(sections[0]!.executions.length, 2);
  // Default sort: most recent lastOccurredAt first
  assert.equal(sections[0]!.executions[0]!.turnId, "turn-b");
  assert.equal(sections[0]!.executions[1]!.turnId, "turn-a");
  assert.equal(sections[0]!.executions[1]!.events, 2);
  assert.equal(sections[0]!.executions[1]!.effectiveCostMicroUsd, 7000);
  assert.equal(sections[0]!.executions[1]!.startedAt, "2026-07-29T18:00:00.000Z");
  assert.equal(
    sections[0]!.executions[1]!.lastOccurredAt,
    "2026-07-29T18:01:00.000Z"
  );
  assert.equal(sections[0]!.executions[1]!.operationalCaseId, "case-1");
  assert.equal(sections[0]!.cases.length, 1);
  assert.equal(sections[0]!.cases[0]!.operationalCaseId, "case-1");
  assert.equal(sections[0]!.cases[0]!.effectiveCostMicroUsd, 7000);
  assert.equal(sections[0]!.uncorrelated, null);

  assert.equal(sections[1]!.userId, "u-cheap");
  assert.equal(sections[1]!.executions.length, 1);
  assert.equal(sections[1]!.cases.length, 1);
  assert.ok(sections[1]!.uncorrelated);
  assert.equal(sections[1]!.uncorrelated!.events, 1);
  assert.equal(sections[1]!.summary.effectiveCostMicroUsd, 51);
}

function main(): void {
  testEffectiveCostNeverDoubleCounts();
  testEventsMissingCatalogEstimate();
  testRollupUsesAccountedNotSumOfColumns();
  testCostComparison();
  testFormatUsdFromMicro();
  testFormatAiUsageOccurredAt();
  testDayRollupUsesViewerTimezone();
  testExecutionWithMultipleFunctionsNoDoubleCount();
  testUncorrelatedReconcilesWithTenantTotal();
  testRecentSortUsesFullTimestamp();
  testCasesSortedByLastActivity();
  testProviderRollupDynamic();
  testFilterSortPaginate();
  testBuildAiUsageTenantSections();
  console.log("ai-usage.selftest: all 14 cases passed");
}

main();
