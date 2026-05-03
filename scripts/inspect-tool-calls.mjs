#!/usr/bin/env node
// Quick diagnostics: dump recent tool_calls for one session.
//
// Usage:
//   node scripts/inspect-tool-calls.mjs <sessionId> [limit]
//
// Reads SUPABASE creds from apps/web/.env.local (NEXT_PUBLIC_SUPABASE_URL +
// SUPABASE_SERVICE_ROLE_KEY). Prints, per tool call:
//   - tool_name, status, created_at, finished_at
//   - arguments_json (sql + params for bigquery_run_query, name for refs)
//   - result_json (status, error.message, row_count for bigquery)

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(__dirname, "..", "apps", "web", ".env.local");

function loadEnv(path) {
  const out = {};
  const text = readFileSync(path, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function truncate(s, max) {
  if (typeof s !== "string") return s;
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…(+${s.length - max} chars)`;
}

function summarizeArgs(toolName, args) {
  if (!args || typeof args !== "object") return args;
  if (toolName === "bigquery_run_query") {
    return {
      sql: truncate(args.sql, 4000),
      params: args.params,
      max_results: args.max_results,
      project_id: args.project_id,
      location: args.location,
    };
  }
  if (toolName === "read_skill_reference") {
    return { name: args.name };
  }
  return args;
}

function summarizeResult(toolName, result) {
  if (!result || typeof result !== "object") return result;
  if (toolName === "bigquery_run_query") {
    return {
      status: result.status,
      error:
        typeof result.error === "string"
          ? truncate(result.error, 800)
          : result.error && typeof result.error === "object"
            ? truncate(result.error.message ?? JSON.stringify(result.error), 800)
            : undefined,
      httpStatus: result.httpStatus,
      missing: result.missing,
      message: result.message ? truncate(result.message, 400) : undefined,
      row_count: Array.isArray(result.rows) ? result.rows.length : undefined,
      truncated: result.truncated,
      first_row_keys:
        Array.isArray(result.rows) && result.rows[0]
          ? Object.keys(result.rows[0])
          : undefined,
      first_row_sample:
        Array.isArray(result.rows) && result.rows[0]
          ? Object.fromEntries(
              Object.entries(result.rows[0]).map(([k, v]) => [
                k,
                typeof v === "string" ? truncate(v, 200) : v,
              ])
            )
          : undefined,
    };
  }
  if (toolName === "read_skill_reference") {
    return {
      status: result.status,
      skill: result.skill,
      name: result.name,
      bytes: result.bytes,
      truncated: result.truncated,
      content_preview: truncate(result.content ?? result.message ?? "", 600),
    };
  }
  return result;
}

async function main() {
  const sessionId = process.argv[2];
  const limit = Number(process.argv[3] ?? 20);
  if (!sessionId) {
    console.error("Usage: node scripts/inspect-tool-calls.mjs <sessionId> [limit]");
    process.exit(1);
  }

  const env = loadEnv(ENV_PATH);
  const url =
    env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Missing Supabase env vars in apps/web/.env.local");
    process.exit(1);
  }
  const db = createClient(url, key);

  const { data, error } = await db
    .from("tool_calls")
    .select(
      "id, session_id, tool_name, status, created_at, finished_at, arguments_json, result_json"
    )
    .eq("session_id", sessionId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.error("Query failed:", error);
    process.exit(1);
  }

  console.log(`# tool_calls for session=${sessionId} (latest ${data?.length ?? 0})`);
  for (const row of (data ?? []).slice().reverse()) {
    console.log("\n----------------------------------------");
    console.log(`[${row.created_at}]  tool=${row.tool_name}  status=${row.status}`);
    console.log("args:", JSON.stringify(summarizeArgs(row.tool_name, row.arguments_json), null, 2));
    console.log(
      "result:",
      JSON.stringify(summarizeResult(row.tool_name, row.result_json), null, 2)
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
