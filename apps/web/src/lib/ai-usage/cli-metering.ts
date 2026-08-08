/**
 * Bootstrap AI usage metering for local live evals / walkthrough scripts.
 *
 * App routes bind ambient context at the HTTP entry. CLI scripts that call the
 * same OpenRouter helpers (Studio compiler, discovery, …) used to bill
 * OpenRouter without writing `ai_usage_events` — undercounting /settings/ai-usage.
 *
 * Usage:
 *   await withCliAiUsageMetering(async () => { ... live model calls ... });
 *
 * Requires:
 *   - AI_USAGE_CLI_USER_ID or --user <uuid> (tenant attribution)
 *   - NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 *   - OPENROUTER_API_KEY (for the model calls themselves)
 *
 * Escape hatch: --no-meter (prints a loud warning; OpenRouter still bills).
 */
import path from "node:path";
import { createServerClient, type DbClient } from "@agents/db";
import {
  flushPendingAiUsageMeterWrites,
  getDroppedAiUsageMeterCount,
  runWithAiUsageContext,
} from "@agents/agent";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface CliAiUsageMeteringOptions {
  /** Override argv/env user id. */
  userId?: string | null;
  /** Default true. When false, skips binding (same as --no-meter). */
  enabled?: boolean;
  /** Label for logs (e.g. authoring-discovery.eval). */
  label?: string;
  /**
   * When true (default), missing user/db fails the run instead of silently
   * undercounting. Pass false only for dry diagnostics.
   */
  require?: boolean;
  /** Extra argv to parse (defaults to process.argv). */
  argv?: string[];
}

export function loadWebEnvLocal(cwd = process.cwd()): void {
  const candidates = [
    path.join(cwd, ".env.local"),
    path.join(cwd, "apps", "web", ".env.local"),
    path.resolve(cwd, "..", "..", "apps", "web", ".env.local"),
  ];
  for (const file of candidates) {
    try {
      process.loadEnvFile(file);
      return;
    } catch {
      // try next
    }
  }
}

export function cliMeteringDisabled(argv: string[] = process.argv): boolean {
  return argv.includes("--no-meter");
}

export function resolveCliMeteringUserId(params?: {
  userId?: string | null;
  argv?: string[];
}): string | null {
  if (params?.userId && UUID_RE.test(params.userId.trim())) {
    return params.userId.trim();
  }
  const argv = params?.argv ?? process.argv;
  const flagIndex = argv.indexOf("--user");
  if (flagIndex >= 0) {
    const value = argv[flagIndex + 1]?.trim();
    if (value && UUID_RE.test(value)) return value;
  }
  const eqFlag = argv.find((arg) => arg.startsWith("--user="));
  if (eqFlag) {
    const value = eqFlag.slice("--user=".length).trim();
    if (value && UUID_RE.test(value)) return value;
  }
  const fromEnv = process.env.AI_USAGE_CLI_USER_ID?.trim();
  if (fromEnv && UUID_RE.test(fromEnv)) return fromEnv;
  return null;
}

function ensureMeteringFlagEnabled(): void {
  if (process.env.AI_USAGE_METERING_ENABLED === "true") return;
  process.env.AI_USAGE_METERING_ENABLED = "true";
  console.warn(
    "[ai-usage] AI_USAGE_METERING_ENABLED was not true; enabling for this CLI run so spend is ledgered."
  );
}

/**
 * Run `fn` with ambient AI usage context (channel=cli) and flush pending
 * meter writes afterwards. Returns the function result.
 */
export async function withCliAiUsageMetering<T>(
  fn: () => Promise<T>,
  options: CliAiUsageMeteringOptions = {}
): Promise<T> {
  const argv = options.argv ?? process.argv;
  const label = options.label ?? "cli";
  const require = options.require !== false;
  const enabled =
    options.enabled !== false && !cliMeteringDisabled(argv);

  if (!enabled) {
    console.warn(
      `[ai-usage] ${label}: metering disabled (--no-meter or enabled:false). ` +
        "OpenRouter will still bill; /settings/ai-usage will undercount."
    );
    return fn();
  }

  const userId = resolveCliMeteringUserId({
    userId: options.userId,
    argv,
  });
  if (!userId) {
    const message =
      `[ai-usage] ${label}: missing tenant for metering. Pass --user <uuid> ` +
      "or set AI_USAGE_CLI_USER_ID. Use --no-meter to skip deliberately.";
    if (require) throw new Error(message);
    console.warn(message);
    return fn();
  }

  ensureMeteringFlagEnabled();

  let db: DbClient;
  try {
    db = createServerClient();
  } catch (error) {
    const message =
      `[ai-usage] ${label}: cannot create Supabase service client ` +
      `(need NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY). ` +
      `${error instanceof Error ? error.message : String(error)}`;
    if (require) throw new Error(message);
    console.warn(message);
    return fn();
  }

  const droppedBefore = getDroppedAiUsageMeterCount();
  console.log(
    `[ai-usage] ${label}: metering on · channel=cli · user=${userId}`
  );

  try {
    return await runWithAiUsageContext(
      { userId, channel: "cli" },
      db,
      () => fn()
    );
  } finally {
    await flushPendingAiUsageMeterWrites();
    const dropped = getDroppedAiUsageMeterCount() - droppedBefore;
    if (dropped > 0) {
      console.warn(
        `[ai-usage] ${label}: ${dropped} meter event(s) dropped this process (see [ai-usage-meter] logs).`
      );
    } else {
      console.log(`[ai-usage] ${label}: meter flush ok (0 drops this process)`);
    }
  }
}
