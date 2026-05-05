/**
 * POST /api/cron/heartbeat
 *
 * Called periodically by Supabase Cron (pg_cron + pg_net).
 * Executes a proactive heartbeat run for each due user with heartbeat enabled.
 *
 * Auth: Bearer token in Authorization header matching CRON_SECRET env var.
 */
import { NextResponse } from "next/server";
import {
  createServerClient,
  decryptToken,
  getProfile,
  getUserToolSettings,
  getUserSkillSettings,
  getUserIntegrations,
  getGoogleCalendarAccessToken,
  getOrCreateSession,
  createHeartbeatRun,
  finishHeartbeatRun,
  updateBusinessBrain,
} from "@agents/db";
import { runAgent } from "@agents/agent";
import type { BusinessBrain, Profile } from "@agents/types";

const CRON_SECRET = process.env.CRON_SECRET ?? "";
const DEFAULT_HEARTBEAT_INTERVAL_MINUTES = 30;
const HEARTBEAT_CONCURRENCY = 5;

interface DueHeartbeatUser {
  userId: string;
  profile: Profile;
  checklistMarkdown: string;
  intervalMinutes: number;
}

interface HeartbeatResult {
  user_id: string;
  status: "ok" | "skipped" | "error";
  reason?: string;
  run_id?: string;
  session_id?: string;
  error?: string;
}

function isAuthorized(request: Request): boolean {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return CRON_SECRET.length > 0 && token === CRON_SECRET;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseIntervalMinutes(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_HEARTBEAT_INTERVAL_MINUTES;
  }
  // Guardrails for runaway configs; UI can be stricter later.
  return Math.max(5, Math.min(24 * 60, Math.floor(raw)));
}

function getChecklistMarkdown(brain: BusinessBrain): string {
  const heartbeat = asRecord(brain.heartbeat);
  const checklistMarkdown = heartbeat.checklist_markdown;
  if (typeof checklistMarkdown === "string" && checklistMarkdown.trim() !== "") {
    return checklistMarkdown.trim();
  }
  const checklistMd = heartbeat.checklist_md;
  if (typeof checklistMd === "string" && checklistMd.trim() !== "") {
    return checklistMd.trim();
  }
  return "";
}

function buildHeartbeatPrompt(checklistMarkdown: string): string {
  return [
    "Heartbeat tick: review the checklist below and produce a concise operational digest.",
    "Use only available tools when needed, follow safety constraints, and avoid speculative claims.",
    "Classify an item as an operational blocker only when it is concrete, actionable, urgent, or prevents progress.",
    "Do not classify profile facts, communication preferences, business context, or general memories as blockers.",
    "If there are no real blockers, say so explicitly instead of filling the section with incidental facts.",
    "",
    "Checklist markdown:",
    checklistMarkdown,
  ].join("\n");
}

function toIso(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function isDue(lastRunAtIso: string | null, intervalMinutes: number): boolean {
  if (!lastRunAtIso) return true;
  const lastRun = new Date(lastRunAtIso).getTime();
  const nextRun = lastRun + intervalMinutes * 60_000;
  return Date.now() >= nextRun;
}

async function getDueHeartbeatUsers(
  db: ReturnType<typeof createServerClient>
): Promise<DueHeartbeatUser[]> {
  const { data, error } = await db
    .from("profiles")
    .select("id, business_brain")
    .not("business_brain", "is", null);
  if (error) throw error;

  const dueIds: string[] = [];
  const byId = new Map<
    string,
    { checklistMarkdown: string; intervalMinutes: number }
  >();

  for (const row of data ?? []) {
    const userId = (row as { id?: unknown }).id;
    if (typeof userId !== "string" || userId.length === 0) continue;

    const brain = asRecord((row as { business_brain?: unknown }).business_brain);
    const heartbeat = asRecord(brain.heartbeat);
    const enabled = heartbeat.enabled === true;
    if (!enabled) continue;

    const checklistMarkdown = getChecklistMarkdown(brain as BusinessBrain);
    if (!checklistMarkdown) continue;

    const intervalMinutes = parseIntervalMinutes(heartbeat.interval_minutes);
    const lastRunAtIso = toIso(heartbeat.last_run_at);
    if (!isDue(lastRunAtIso, intervalMinutes)) continue;

    dueIds.push(userId);
    byId.set(userId, { checklistMarkdown, intervalMinutes });
  }

  const users: DueHeartbeatUser[] = [];
  for (const userId of dueIds) {
    const profile = await getProfile(db, userId);
    const cfg = byId.get(userId);
    if (!cfg) continue;
    users.push({
      userId,
      profile,
      checklistMarkdown: cfg.checklistMarkdown,
      intervalMinutes: cfg.intervalMinutes,
    });
  }
  return users;
}

async function runHeartbeatForUser(
  db: ReturnType<typeof createServerClient>,
  dueUser: DueHeartbeatUser
): Promise<HeartbeatResult> {
  const { userId, profile, checklistMarkdown } = dueUser;
  let runId: string | undefined;
  let sessionId: string | undefined;
  try {
    const toolSettings = await getUserToolSettings(db, userId);
    const skillSettings = await getUserSkillSettings(db, userId);
    const integrations = await getUserIntegrations(db, userId);

    const githubIntegration = integrations.find((i) => i.provider === "github");
    let githubToken: string | undefined;
    const encryptedTokens = (
      githubIntegration as unknown as { encrypted_tokens?: string } | undefined
    )?.encrypted_tokens;
    if (encryptedTokens) {
      try {
        githubToken = decryptToken(encryptedTokens);
      } catch {
        // Skip token if decrypt fails.
      }
    }

    const googleCalendarAccessToken =
      (await getGoogleCalendarAccessToken(db, userId)) ?? undefined;

    const session = await getOrCreateSession(db, userId, "heartbeat");
    sessionId = session.id;

    const run = await createHeartbeatRun(db, {
      userId,
      sessionId,
    });
    runId = run.id;

    const heartbeatPrompt = buildHeartbeatPrompt(checklistMarkdown);
    const result = await runAgent({
      message: heartbeatPrompt,
      userId,
      sessionId: session.id,
      systemPrompt: profile.agent_system_prompt,
      db,
      enabledTools: toolSettings,
      enabledSkills: skillSettings,
      integrations,
      githubToken,
      userTimezone: profile.timezone,
      userName: profile.name,
      userEmail: profile.email,
      userPhone: profile.phone,
      businessBrain: profile.business_brain ?? {},
      isUnggaAdmin: profile.is_ungga_admin ?? false,
      channel: "heartbeat",
      googleCalendarAccessToken,
      autoApproveTools: false,
    });

    await finishHeartbeatRun(db, {
      runId: run.id,
      status: "completed",
      payload: {
        response: result.response,
        toolCalls: result.toolCalls,
        pendingConfirmation: result.pendingConfirmation ?? null,
      },
    });

    const heartbeat = asRecord(profile.business_brain?.heartbeat);
    await updateBusinessBrain(db, userId, {
      heartbeat: {
        ...heartbeat,
        last_run_at: new Date().toISOString(),
      },
    });

    return {
      user_id: userId,
      status: "ok",
      run_id: run.id,
      session_id: session.id,
    };
  } catch (e) {
    const errMsg = (e as Error)?.message ?? "Unknown error";
    if (runId) {
      try {
        await finishHeartbeatRun(db, {
          runId,
          status: "error",
          error: errMsg,
          payload: { error: errMsg },
        });
      } catch (finishErr) {
        console.error("[heartbeat] failed to finish run record:", finishErr);
      }
    }
    // Record last_run_at on hard failure too to avoid tight retry loops.
    try {
      const profile = await getProfile(db, userId);
      const heartbeat = asRecord(profile.business_brain?.heartbeat);
      await updateBusinessBrain(db, userId, {
        heartbeat: {
          ...heartbeat,
          last_run_at: new Date().toISOString(),
        },
      });
    } catch (updateErr) {
      console.error("[heartbeat] failed to update last_run_at after error:", updateErr);
    }
    return {
      user_id: userId,
      status: "error",
      run_id: runId,
      session_id: sessionId,
      error: errMsg,
    };
  }
}

async function runWithConcurrency(
  users: DueHeartbeatUser[],
  worker: (user: DueHeartbeatUser) => Promise<HeartbeatResult>,
  concurrency: number
): Promise<HeartbeatResult[]> {
  const safeConcurrency = Math.max(1, Math.min(concurrency, 20));
  const queue = [...users];
  const results: HeartbeatResult[] = [];

  const runners = Array.from({ length: safeConcurrency }, async () => {
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) break;
      const result = await worker(next);
      results.push(result);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = createServerClient();

  let dueUsers: DueHeartbeatUser[] = [];
  try {
    dueUsers = await getDueHeartbeatUsers(db);
  } catch (e) {
    console.error("[heartbeat] failed to fetch due users:", e);
    return NextResponse.json(
      { error: "Failed to read heartbeat due users" },
      { status: 500 }
    );
  }

  if (dueUsers.length === 0) {
    return NextResponse.json({ processed: 0, results: [] });
  }

  const results = await runWithConcurrency(
    dueUsers,
    (user) => runHeartbeatForUser(db, user),
    HEARTBEAT_CONCURRENCY
  );

  return NextResponse.json({ processed: results.length, results });
}
