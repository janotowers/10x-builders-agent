/**
 * POST /api/cron/scheduled-tasks
 *
 * Called every minute by Supabase Cron (pg_cron + pg_net).
 * Finds due tasks, runs the agent for each one, and sends the result to Telegram.
 *
 * Auth: Bearer token in Authorization header matching CRON_SECRET env var.
 * This route is excluded from the Supabase session middleware (see middleware.ts).
 */
import { NextResponse } from "next/server";
import {
  createServerClient,
  decryptToken,
  getProfile,
  getUserToolSettings,
  getUserIntegrations,
  getGoogleCalendarAccessToken,
  getDueTasks,
  markTaskRunning,
  createTaskRun,
  finishTaskRun,
  rescheduleOrComplete,
  getTelegramChatId,
  getOrCreateSession,
} from "@agents/db";
import { runAgent } from "@agents/agent";
import {
  sendTelegramMessage,
  truncateTelegramText,
} from "@/lib/telegram/send-message";
import { Cron } from "croner";
import type { ScheduledTask } from "@agents/db";

const CRON_SECRET = process.env.CRON_SECRET ?? "";

function isAuthorized(request: Request): boolean {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return CRON_SECRET.length > 0 && token === CRON_SECRET;
}

/** Compute next occurrence of a cron expression in the given timezone. */
function computeNextRunAt(cronExpr: string, timezone: string): string | null {
  try {
    const cron = new Cron(cronExpr, { timezone });
    const next = cron.nextRun();
    return next ? next.toISOString() : null;
  } catch {
    return null;
  }
}

interface TaskResult {
  task_id: string;
  status: "ok" | "skipped" | "error";
  error?: string;
}

async function runTask(
  db: ReturnType<typeof createServerClient>,
  task: ScheduledTask
): Promise<TaskResult> {
  // Atomic lock: if another worker already picked it up, skip
  const locked = await markTaskRunning(db, task.id);
  if (!locked) {
    return { task_id: task.id, status: "skipped" };
  }

  const run = await createTaskRun(db, task.id);
  let agentSessionId: string | undefined;
  let notified = false;
  let notificationError: string | undefined;

  try {
    // Load user context
    const profile = await getProfile(db, task.user_id);
    const toolSettings = await getUserToolSettings(db, task.user_id);
    const integrations = await getUserIntegrations(db, task.user_id);

    const githubIntegration = integrations.find(
      (i) => i.provider === "github"
    );
    let githubToken: string | undefined;
    if (githubIntegration) {
      const raw = (
        githubIntegration as unknown as { encrypted_tokens?: string }
      ).encrypted_tokens;
      if (raw) {
        try {
          githubToken = decryptToken(raw);
        } catch {
          // No GitHub token available
        }
      }
    }

    const googleCalendarAccessToken =
      (await getGoogleCalendarAccessToken(db, task.user_id)) ?? undefined;

    // Get or create a dedicated cron session for this user
    const session = await getOrCreateSession(db, task.user_id, "cron");
    agentSessionId = session.id;

    // Run the agent with autoApproveTools=true: the user already approved
    // this exact task when scheduling it (schedule_task is itself HITL),
    // so inner risky tools (bash/write_file/etc.) execute without a second approval.
    const result = await runAgent({
      message: task.prompt,
      userId: task.user_id,
      sessionId: session.id,
      systemPrompt: profile.agent_system_prompt,
      db,
      enabledTools: toolSettings,
      integrations,
      githubToken,
      userTimezone: profile.timezone,
      googleCalendarAccessToken,
      autoApproveTools: true,
    });

    const chatId = await getTelegramChatId(db, task.user_id);

    console.log(
      `[cron] task ${task.id} run finished — toolCalls=${JSON.stringify(
        result.toolCalls
      )} responseLen=${result.response?.length ?? 0}`
    );

    // Notify via Telegram with the agent response (distinct from the "you scheduled this" reply in chat)
    if (chatId) {
      const prefix = "📬 Resultado automático (tarea programada)\n\n";
      const trimmed = result.response?.trim() ?? "";
      let responseText: string;
      if (trimmed.length > 0) {
        responseText = truncateTelegramText(prefix + trimmed);
      } else {
        responseText = truncateTelegramText(
          `${prefix}El agente terminó sin texto de respuesta. Si esperabas datos (p. ej. noticias vía bash/curl), comprueba en el servidor que BASH_TOOL_ENABLED=true y que el modelo haya llamado a la herramienta bash.\n\nPrompt ejecutado:\n«${task.prompt.slice(0, 1200)}»`
        );
      }
      try {
        await sendTelegramMessage(chatId, responseText, undefined, {
          throwOnError: true,
        });
        notified = true;
      } catch (e) {
        notificationError = (e as Error)?.message ?? "Error enviando Telegram";
      }
    } else {
      notificationError = "no_telegram_link";
    }

    // Reschedule or mark completed
    const nextRunAt =
      task.schedule_type === "recurring" && task.cron_expr
        ? computeNextRunAt(task.cron_expr, task.timezone)
        : null;
    await rescheduleOrComplete(db, task, nextRunAt);

    await finishTaskRun(db, run.id, {
      status: "completed",
      agentSessionId,
      notified,
      notificationError,
    });

    return { task_id: task.id, status: "ok" };
  } catch (e) {
    const errMsg = (e as Error)?.message ?? "Unknown error";
    console.error(`[cron] task ${task.id} failed:`, errMsg);

    try {
      await finishTaskRun(db, run.id, {
        status: "failed",
        error: errMsg,
        agentSessionId,
        notified: false,
        notificationError: notificationError,
      });
      // On failure, keep task active so it can retry next minute
      await db
        .from("scheduled_tasks")
        .update({ status: "active", updated_at: new Date().toISOString() })
        .eq("id", task.id);
    } catch (finishErr) {
      console.error("[cron] failed to update run record:", finishErr);
    }

    return { task_id: task.id, status: "error", error: errMsg };
  }
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = createServerClient();

  let dueTasks: ScheduledTask[] = [];
  try {
    dueTasks = await getDueTasks(db);
  } catch (e) {
    console.error("[cron] getDueTasks failed:", e);
    return NextResponse.json(
      { error: "Failed to read scheduled tasks" },
      { status: 500 }
    );
  }

  if (dueTasks.length === 0) {
    return NextResponse.json({ processed: 0, results: [] });
  }

  // Run tasks concurrently (limit by the minute budget, tasks are lightweight)
  const results: TaskResult[] = await Promise.all(
    dueTasks.map((task) => runTask(db, task))
  );

  console.log(
    `[cron] processed ${results.length} tasks:`,
    results.map((r) => `${r.task_id}=${r.status}`).join(", ")
  );

  return NextResponse.json({ processed: results.length, results });
}
