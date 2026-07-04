import assert from "node:assert/strict";
import type { DbClient } from "@agents/db";
import type { UserToolSetting, UserIntegration } from "@agents/types";
import {
  buildLangChainTools,
  prepareBigQueryRunArgs,
  type ToolContext,
} from "./adapters";

const ALL_TOOL_IDS = [
  "get_user_preferences",
  "list_enabled_tools",
  "bigquery_run_query",
  "github_list_repos",
  "github_list_issues",
  "github_create_repo",
  "github_create_issue",
  "calendar_list_calendars",
  "calendar_list_events",
  "calendar_list_tasks",
  "calendar_create_event",
  "calendar_update_event",
  "calendar_delete_event",
  "schedule_task",
  "manage_scheduled_tasks",
] as const;

function makeEnabledTools(): UserToolSetting[] {
  return ALL_TOOL_IDS.map((id, i) => ({
    id: `setting-${i}`,
    user_id: "user-1",
    tool_id: id,
    enabled: true,
    config_json: {},
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
  }));
}

function makeIntegrations(): UserIntegration[] {
  return [];
}

function baseCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const fakeDb = {} as DbClient;
  return {
    db: fakeDb,
    userId: "user-1",
    sessionId: "session-1",
    channel: "web",
    enabledTools: makeEnabledTools(),
    integrations: makeIntegrations(),
    lastUserMessage: "Cuántos leads tuvimos en marzo?",
    ...overrides,
  };
}

function names(tools: ReturnType<typeof buildLangChainTools>): string[] {
  return tools
    .map((t) => (t as unknown as { name?: string }).name)
    .filter((n): n is string => Boolean(n))
    .sort();
}

// ── Test 1: no active skill → returns the union of available tools.
function testNoSkillDoesNotNarrow(): void {
  const ctx = baseCtx({ activeSkillAllowedTools: undefined });
  const got = names(buildLangChainTools(ctx));
  // Tools that are available without integrations:
  // get_user_preferences, list_enabled_tools, bigquery_run_query,
  // schedule_task, manage_scheduled_tasks.
  // GitHub tools require integrations → omitted. Calendar tools likewise.
  // bash / file tools require env vars → omitted.
  assert.ok(got.includes("get_user_preferences"), "get_user_preferences");
  assert.ok(got.includes("list_enabled_tools"), "list_enabled_tools");
  assert.ok(got.includes("bigquery_run_query"), "bigquery_run_query");
  assert.ok(got.includes("schedule_task"), "schedule_task");
  assert.ok(got.includes("manage_scheduled_tasks"), "manage_scheduled_tasks");
  assert.ok(got.length >= 5, `expected at least 5 tools, got ${got.length}`);
}

// ── Test 2: empty allowlist → behaves like undefined (does NOT narrow).
function testEmptyAllowlistDoesNotNarrow(): void {
  const ctx = baseCtx({ activeSkillAllowedTools: [] });
  const got = names(buildLangChainTools(ctx));
  assert.ok(got.includes("get_user_preferences"));
  assert.ok(got.includes("bigquery_run_query"));
  assert.ok(got.includes("schedule_task"));
}

// ── Test 3: explicit allowlist → tool list intersects to that set.
function testActiveSkillNarrowsToAllowedTools(): void {
  const ctx = baseCtx({
    activeSkillAllowedTools: ["bigquery_run_query", "get_user_preferences"],
  });
  const got = names(buildLangChainTools(ctx));
  assert.deepEqual(got, ["bigquery_run_query", "get_user_preferences"]);
}

// ── Test 4: allowlist with a tool the user does NOT have enabled
//    → that tool is NOT registered; only the intersection is.
function testAllowlistDoesNotResurrectDisabledTools(): void {
  const enabled = makeEnabledTools().map((t) =>
    t.tool_id === "bigquery_run_query" ? { ...t, enabled: false } : t
  );
  const ctx = baseCtx({
    enabledTools: enabled,
    activeSkillAllowedTools: ["bigquery_run_query", "get_user_preferences"],
  });
  const got = names(buildLangChainTools(ctx));
  assert.deepEqual(got, ["get_user_preferences"]);
}

// ── Test 5: allowlist with an unknown tool id → no error, no extra tool.
function testAllowlistWithUnknownIdIsHarmless(): void {
  const ctx = baseCtx({
    activeSkillAllowedTools: ["nonexistent_tool", "bigquery_run_query"],
  });
  const got = names(buildLangChainTools(ctx));
  assert.deepEqual(got, ["bigquery_run_query"]);
}

// ── Test 6: when a skill is active, message-driven heuristics still apply
//    (e.g. greeting heuristic for github_list_repos still hides github tools).
//    Concretely: even if the allowlist would include github_list_repos,
//    a greeting + missing GH integration should still hide it.
function testActiveSkillDoesNotBypassExistingFilters(): void {
  const ctx = baseCtx({
    activeSkillAllowedTools: ["github_list_repos", "get_user_preferences"],
    lastUserMessage: "hola",
  });
  const got = names(buildLangChainTools(ctx));
  assert.ok(!got.includes("github_list_repos"));
  assert.ok(got.includes("get_user_preferences"));
}

// ── Test 7: heartbeat is read-only and must not expose raw warehouse queries.
function testHeartbeatDoesNotExposeBigQuery(): void {
  const ctx = baseCtx({
    channel: "heartbeat",
    lastUserMessage:
      "Heartbeat tick: review the checklist below and produce a concise operational digest.",
  });
  const got = names(buildLangChainTools(ctx));
  assert.ok(!got.includes("bigquery_run_query"));
  assert.ok(got.includes("get_user_preferences"));
  assert.ok(got.includes("list_enabled_tools"));
  assert.ok(!got.includes("schedule_task"));
}

// ── Test 8: tenant BigQuery helper rejects literal organization_id so the
//    model retries with @organization_id + params.
function testBigQueryRejectsLiteralTenantId(): void {
  const result = prepareBigQueryRunArgs(
    {
      sql: "SELECT COUNT(*) FROM `proj.ds.users` u WHERE u.organization_id = 'users/abc'",
    },
    { tenantOrganizationId: "users/abc" }
  );
  assert.ok("status" in result);
  assert.equal(result.status, "validation_error");
  assert.match(result.error, /named parameter/i);
}

// ── Test 9: if SQL already uses @organization_id but the model forgot
//    params, the trusted server-side tenant context fills it in.
function testBigQueryFillsMissingTenantParam(): void {
  const result = prepareBigQueryRunArgs(
    {
      sql: "SELECT COUNT(*) FROM `proj.ds.users` u WHERE u.organization_id = @organization_id",
      params: { start_date: "2026-04-01" },
    },
    { tenantOrganizationId: "users/abc" }
  );
  assert.ok(!("status" in result));
  assert.deepEqual(result.params, {
    start_date: "2026-04-01",
    organization_id: "users/abc",
  });
}

// ── Test 10: missing named params fail fast (validation_error) instead of
//    consuming a BigQuery execution attempt.
function testBigQueryRejectsMissingNamedParams(): void {
  const result = prepareBigQueryRunArgs(
    {
      sql: "SELECT COUNT(*) FROM `proj.ds.leads` WHERE DATE(created_at) >= @start_date AND DATE(created_at) < @end_date",
      params: {},
    },
    { tenantOrganizationId: "users/abc" }
  );
  assert.ok("status" in result);
  assert.equal(result.status, "validation_error");
  assert.match(result.error, /@start_date/i);
  assert.match(result.error, /@end_date/i);
}

// ── Test 11: named params inside string/comment do not require params.
function testBigQueryIgnoresNamedParamsInCommentsAndStrings(): void {
  const result = prepareBigQueryRunArgs(
    {
      sql: `
-- mention @start_date in a comment should be ignored
SELECT '@end_date literal' AS note
FROM \`proj.ds.table\`
WHERE u.organization_id = @organization_id
`,
    },
    { tenantOrganizationId: "users/abc" }
  );
  assert.ok(!("status" in result));
  assert.deepEqual(result.params, { organization_id: "users/abc" });
}

// ── Test 12: month-only prompt can auto-fill start/end dates when missing.
function testBigQueryAutofillsMonthlyDateParamsFromPrompt(): void {
  const result = prepareBigQueryRunArgs(
    {
      sql: "SELECT COUNT(*) FROM `proj.ds.leads` WHERE DATE(created_at) >= @start_date AND DATE(created_at) < @end_date AND organization_id = @organization_id",
      params: {},
    },
    {
      tenantOrganizationId: "users/abc",
      lastUserMessage: "cuantos leads tuvimos en mayo 2026?",
    }
  );
  assert.ok(!("status" in result));
  assert.deepEqual(result.params, {
    organization_id: "users/abc",
    start_date: "2026-05-01",
    end_date: "2026-06-01",
  });
}

// ── Test 13: multi-period comparisons should NOT auto-fill.
function testBigQueryDoesNotAutofillMultiPeriodPrompt(): void {
  const result = prepareBigQueryRunArgs(
    {
      sql: "SELECT COUNT(*) FROM `proj.ds.leads` WHERE DATE(created_at) >= @start_date AND DATE(created_at) < @end_date AND organization_id = @organization_id",
      params: {},
    },
    {
      tenantOrganizationId: "users/abc",
      lastUserMessage: "comparame abril vs mayo 2026",
    }
  );
  assert.ok("status" in result);
  assert.equal(result.status, "validation_error");
  assert.match(result.error, /@start_date/i);
  assert.match(result.error, /@end_date/i);
}

// ── Test 14: if another param is missing, keep failing fast.
function testBigQueryDoesNotAutofillWhenOtherNamedParamMissing(): void {
  const result = prepareBigQueryRunArgs(
    {
      sql: "SELECT COUNT(*) FROM `proj.ds.leads` WHERE DATE(created_at) >= @start_date AND DATE(created_at) < @end_date AND source = @source",
      params: {},
    },
    {
      tenantOrganizationId: "users/abc",
      lastUserMessage: "cuantos leads tuvimos en mayo 2026?",
    }
  );
  assert.ok("status" in result);
  assert.equal(result.status, "validation_error");
  assert.match(result.error, /@source/i);
}

function main(): void {
  testNoSkillDoesNotNarrow();
  testEmptyAllowlistDoesNotNarrow();
  testActiveSkillNarrowsToAllowedTools();
  testAllowlistDoesNotResurrectDisabledTools();
  testAllowlistWithUnknownIdIsHarmless();
  testActiveSkillDoesNotBypassExistingFilters();
  testHeartbeatDoesNotExposeBigQuery();
  testBigQueryRejectsLiteralTenantId();
  testBigQueryFillsMissingTenantParam();
  testBigQueryRejectsMissingNamedParams();
  testBigQueryIgnoresNamedParamsInCommentsAndStrings();
  testBigQueryAutofillsMonthlyDateParamsFromPrompt();
  testBigQueryDoesNotAutofillMultiPeriodPrompt();
  testBigQueryDoesNotAutofillWhenOtherNamedParamMissing();
  console.log("tools/skill-aware.selftest: all 14 cases passed");
}

main();
