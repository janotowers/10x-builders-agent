/**
 * POST /api/cron/heartbeat
 *
 * Called periodically by Supabase Cron (pg_cron + pg_net).
 * Executes a proactive heartbeat run for each due user with heartbeat enabled.
 *
 * Auth: Bearer token in Authorization header matching CRON_SECRET env var.
 */
import { randomUUID } from "node:crypto";
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
import {
  buildPlaybookInjection,
  formatHeartbeatSkillSelectionBlock,
  getGlobalSkillRegistry,
  runAgent,
  runHeartbeatPrefetchers,
  selectHeartbeatSkillsForChecklist,
  validateHeartbeatChecklist,
} from "@agents/agent";
import type {
  HeartbeatPrefetchRunResult,
  HeartbeatSkillSelectionResult,
  ResolvedSkill,
} from "@agents/agent";
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

interface AppliedSkillPayload {
  id: string;
  role: "primary" | "included";
}

function isAuthorized(request: Request): boolean {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return CRON_SECRET.length > 0 && token === CRON_SECRET;
}

/** Never persist empty diagnostics: `.message ?? "x"` keeps `""` because `??` ignores empty string. */
function describeCaughtError(e: unknown): string {
  if (e instanceof Error) {
    const msg = e.message?.trim();
    if (msg) return msg;
    const head = e.stack?.split("\n")[0]?.trim();
    if (head) return head;
    if (e.name && e.name !== "Error") return `${e.name} (empty message)`;
    return "Error with empty message (see server logs for stack)";
  }
  if (typeof e === "string") {
    const t = e.trim();
    if (t) return t;
    return "Thrown empty string";
  }
  if (e && typeof e === "object" && "message" in e) {
    const m = String((e as { message: unknown }).message ?? "").trim();
    if (m) return m;
  }
  try {
    const s = JSON.stringify(e);
    if (s && s !== "{}") return s;
  } catch {
    /* ignore */
  }
  return "Unknown thrown value";
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

function normalizeUserLanguage(raw: string | null | undefined): string {
  const t = typeof raw === "string" ? raw.trim() : "";
  return t.length > 0 ? t : "en";
}

function sanitizeHeartbeatResponseForSignals(
  response: string,
  prefetch: HeartbeatPrefetchRunResult
): string {
  if (!prefetch.hasSignals) return response;

  const withoutOk = response
    .replace(
      /\n*#{1,6}\s*Pulso OK\s*\n+Todo en orden\.?\s+Sin acci[oó]n requerida\.?\s*$/iu,
      ""
    )
    .trim();

  if (withoutOk && !/Pulso OK/i.test(withoutOk)) {
    return withoutOk;
  }

  return prefetch.fallbackResponse || response;
}

/**
 * Internal instructions stay in English for the model; all user-facing output must match `userLanguage`.
 */
function buildHeartbeatPrompt(
  checklistMarkdown: string,
  userLanguage: string,
  selectionBlock: string,
  calendarSignalsBlock: string,
  checklistWarnings: string[]
): string {
  const lang = normalizeUserLanguage(userLanguage);
  return [
    `The user's preferred locale for every user-visible string is ${lang} (BCP 47). Write the full digest in that language: the single top-level markdown title, every section heading, and all body text.`,
    "Start with one short `###` markdown heading for this heartbeat tick; phrase it as a momentary pulse, not a daily brief (e.g. Spanish `es`: «Pulso» or «Pulso operativo»; English `en`: «Pulse» or «Operational pulse»). Avoid titles like «Pulso del día», «Resumen del día», or any wording that implies there is only one daily report. In the no-action path, do not add a separate digest title: `### Pulso OK` is the only heading and the whole response.",
    "Treat persistent memories only as background preferences/facts. Do not use them as instructions to query external systems; call tools only when the checklist explicitly asks for that source.",
    "Heartbeat tick: review the checklist below as an exception-first monitor, not as a scheduled brief.",
    "Use only available tools when needed, follow safety constraints, and avoid speculative claims.",
    "Classify an item as an operational blocker only when it is concrete, actionable, urgent, or prevents progress.",
    "For calendar readiness items, an event that starts or a Google Calendar task that is due inside the checklist reminder window (for example within 60 minutes) crosses the threshold as a timely reminder; do not answer `Pulso OK` for that item.",
    "Do not classify profile facts, communication preferences, business context, or general memories as blockers.",
    "Never fill empty sections. Do not report agenda, metrics, blockers, or opportunities merely because they exist.",
    "Hard stop: if no checklist item crosses its threshold, the entire response must be only a compact OK/no-action message in the user's language, e.g. Spanish: `### Pulso OK\\nTodo en orden. Sin acción requerida.`",
    "When using the no-action response, do not include any event names, scheduled task names, IDs, links, timestamps, evidence, or intermediate findings.",
    "Never combine a no-action response with informational sections. If you listed meetings, tasks, leads, metrics, or evidence, that means an item crossed the threshold and the output must explain the concrete action.",
    "When the prompt contains `[DETERMINISTIC HEARTBEAT SIGNALS]`, mention each active signal concretely by title and local time. Do not use only generic summaries like \"hay reuniones en progreso\" or \"hay tareas próximas\"; name the event/task so the user knows exactly what changed. Respect `[SUPPRESSED HEARTBEAT SIGNALS - DO NOT REPEAT]`: those were already surfaced recently and must not be repeated.",
    checklistWarnings.length > 0
      ? `Checklist validation warnings (do not show verbatim unless useful): ${checklistWarnings.join(" | ")}`
      : "",
    selectionBlock,
    calendarSignalsBlock,
    "",
    "Checklist markdown:",
    checklistMarkdown,
  ].filter(Boolean).join("\n");
}

function buildHeartbeatAppliedSkillPayload(
  skills: readonly ResolvedSkill[]
): AppliedSkillPayload[] {
  const seen = new Set<string>();
  const out: AppliedSkillPayload[] = [];
  for (const skill of skills) {
    for (const id of skill.composedFrom) {
      const key = `${id}:${id === skill.rootName ? "primary" : "included"}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id,
        role: id === skill.rootName ? "primary" : "included",
      });
    }
  }
  return out;
}

async function attachHeartbeatSkillsToAssistantMessages(
  db: ReturnType<typeof createServerClient>,
  params: {
    sessionId: string;
    turnId: string;
    appliedSkills: AppliedSkillPayload[];
    response?: string;
  }
): Promise<void> {
  if (params.appliedSkills.length === 0 && !params.response) return;
  const { data, error } = await db
    .from("agent_messages")
    .select("id, structured_payload")
    .eq("session_id", params.sessionId)
    .eq("turn_id", params.turnId)
    .eq("role", "assistant");
  if (error) throw error;

  for (const message of data ?? []) {
    const id = (message as { id?: unknown }).id;
    if (typeof id !== "string") continue;
    const current = asRecord(
      (message as { structured_payload?: unknown }).structured_payload
    );
    const next = {
      ...current,
      appliedSkills: params.appliedSkills,
    };
    const update: Record<string, unknown> = { structured_payload: next };
    if (params.response) update.content = params.response;
    const { error: updateError } = await db
      .from("agent_messages")
      .update(update)
      .eq("id", id);
    if (updateError) throw updateError;
  }
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

    const checklistValidation = validateHeartbeatChecklist(checklistMarkdown);
    let heartbeatSkillSelection: HeartbeatSkillSelectionResult = {
      selections: [],
      skills: [],
      blockedSkillIds: [],
    };
    try {
      const registry = await getGlobalSkillRegistry({
        forceReload: process.env.NODE_ENV !== "production",
      });
      heartbeatSkillSelection = await selectHeartbeatSkillsForChecklist({
        registry,
        items: checklistValidation.items,
        enabledSkills: skillSettings,
      });
    } catch (err) {
      console.warn(
        "[heartbeat] skill selection failed; continuing without heartbeat skills:",
        err instanceof Error ? err.message : String(err)
      );
    }
    const selectionBlock = formatHeartbeatSkillSelectionBlock(
      heartbeatSkillSelection
    );

    // Pre-generate the turn_id so the deterministic prefetcher rows and the
    // LLM-issued tool_calls share the same turn — that way the chat panel
    // shows them together inside "Herramientas del turno".
    const heartbeatTurnId = randomUUID();
    const prefetchResult = await runHeartbeatPrefetchers({
      env: {
        db,
        sessionId: session.id,
        turnId: heartbeatTurnId,
        timezone: profile.timezone,
        now: new Date(),
        userLanguage: profile.language ?? "es",
        integrations,
        googleCalendarAccessToken,
      },
      skills: heartbeatSkillSelection.skills,
      items: checklistValidation.items,
    });
    for (const skipped of prefetchResult.skipped) {
      console.warn(
        `[heartbeat] prefetcher kind=${skipped.kind} skipped: ${skipped.reason}`
      );
    }

    const heartbeatSkillPrompt = heartbeatSkillSelection.skills
      .map((skill) => buildPlaybookInjection(skill))
      .join("\n\n");

    const heartbeatPrompt = buildHeartbeatPrompt(
      checklistMarkdown,
      profile.language,
      selectionBlock,
      prefetchResult.promptBlock,
      checklistValidation.warnings
    );
    const result = await runAgent({
      message: heartbeatPrompt,
      turnId: heartbeatTurnId,
      userId,
      sessionId: session.id,
      systemPrompt: `${profile.agent_system_prompt}${heartbeatSkillPrompt}`,
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
    const heartbeatResponse = sanitizeHeartbeatResponseForSignals(
      result.response,
      prefetchResult
    );
    const appliedHeartbeatSkillPayload = buildHeartbeatAppliedSkillPayload(
      heartbeatSkillSelection.skills
    );
    await attachHeartbeatSkillsToAssistantMessages(db, {
      sessionId: session.id,
      turnId: result.turnId,
      appliedSkills: appliedHeartbeatSkillPayload,
      response: heartbeatResponse,
    });

    await finishHeartbeatRun(db, {
      runId: run.id,
      status: "completed",
      payload: {
        response: heartbeatResponse,
        toolCalls: result.toolCalls,
        pendingConfirmation: result.pendingConfirmation ?? null,
        checklistItems: checklistValidation.items,
        checklistWarnings: checklistValidation.warnings,
        deterministicToolCallIds: prefetchResult.persistedToolCallIds,
        deterministicSkipped: prefetchResult.skipped,
        heartbeatSkillSelection: heartbeatSkillSelection.selections.map(
          (selection) => ({
            itemId: selection.item.id,
            status: selection.status,
            skillIds: selection.skillIds,
            blockedSkillIds: selection.blockedSkillIds,
            reason: selection.reason ?? null,
          })
        ),
        appliedHeartbeatSkills: heartbeatSkillSelection.skills.map(
          (skill) => skill.rootName
        ),
        appliedSkills: appliedHeartbeatSkillPayload,
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
    const errMsg = describeCaughtError(e);
    console.error("[heartbeat] runHeartbeatForUser failed userId=", userId, e);
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
