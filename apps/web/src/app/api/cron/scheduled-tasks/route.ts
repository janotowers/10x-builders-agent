/**
 * POST /api/cron/scheduled-tasks
 *
 * Called every minute by Supabase Cron (pg_cron + pg_net).
 * Finds due tasks, runs the agent for each one (with bounded concurrency), and sends the result to Telegram.
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
  getUserSkillSettings,
  getUserIntegrations,
  getGoogleCalendarAccessToken,
  getDueTasks,
  markTaskRunning,
  createTaskRun,
  finishTaskRun,
  rescheduleOrComplete,
  markTaskRetry,
  markTaskPausedDueToFailures,
  getTelegramChatId,
  getOrCreateSession,
  createWorkRun,
  createWorkItemsForWorkRun,
  getDurableTask,
} from "@agents/db";
import { runAgent } from "@agents/agent";
import {
  sendTelegramMarkdownMessage,
  sendTelegramMessage,
  truncateTelegramText,
} from "@/lib/telegram/send-message";
import { Cron } from "croner";
import { ensureAgentToolDepsWired } from "@/lib/agent/wire-tool-deps";
import type { ScheduledTask } from "@agents/db";
import { normalizeToolApprovalPolicy } from "@agents/agent";
import {
  durableTaskSpecSchema,
  durableTaskTemplatesToWorkItems,
} from "@agents/workflows";
import { notify } from "@/lib/notify";
import { TOOL_CONFIRMATION_PENDING_KIND } from "@/lib/notifications/pending-inbox-dedupe";
import {
  buildScheduledTaskToolApprovalPolicy,
  isScheduledTaskLegacyAutoApproveEnabled,
} from "@/lib/scheduled-tasks/scheduled-task-tool-policy";

const CRON_SECRET = process.env.CRON_SECRET ?? "";

// ─────────────────────────────────────────────────────────────────────────────
// Retry policy
// ─────────────────────────────────────────────────────────────────────────────
// Política de reintentos tras fallo en una run:
//   1. Si el error parece "persistente" (402 Payment Required, 401 Unauthorized,
//      403 Forbidden, etc.) → auto-pausar ya: reintentar no cambia nada y solo
//      gasta créditos LLM.
//   2. En cualquier otro error → reintentar en ~RETRY_GAP_MINUTES minutos,
//      hasta MAX_CONSECUTIVE_FAILURES intentos consecutivos. Si se supera →
//      auto-pausar la tarea y notificar al usuario por Telegram.
//   3. Un run OK resetea el contador (ver rescheduleOrComplete).
//
// Para recurring tasks: cap el próximo reintento al min(now+gap, próximo tick
// natural del cron). Si el cron es "*/5 * * * *" (cada 5 min), el gap de 2 min
// se respeta; si el cron es "0 9 * * *" (diario), el gap cuenta y el reintento
// cae en +2 min aunque el cron natural sea mañana.
const MAX_CONSECUTIVE_FAILURES = 3;
const RETRY_GAP_MINUTES = 2;
const DEFAULT_SCHEDULED_TASKS_CONCURRENCY = 5;

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

/**
 * Heurística ligera para detectar errores que no se van a resolver con un
 * reintento en 2 minutos (auth, crédito, cuota, config). Si el error es de
 * este tipo, pasamos directo a auto-pausa sin quemar 3 intentos.
 *
 * Intencionalmente conservadora: ante la duda tratamos el error como
 * transitorio y reintentamos.
 */
function isPersistentError(msg: string): boolean {
  const m = msg.toLowerCase();
  // OpenRouter / crédito
  if (m.includes("402") || m.includes("requires more credits")) return true;
  if (m.includes("insufficient_quota") || m.includes("quota exceeded"))
    return true;
  // Auth
  if (m.includes("401") || m.includes("unauthorized")) return true;
  if (m.includes("403") || m.includes("forbidden")) return true;
  // Bad request (prompt/tool schema roto en la tarea)
  if (m.includes("400 bad request")) return true;
  return false;
}

/**
 * Devuelve el ISO del próximo reintento, acotado por el siguiente tick natural
 * del cron si la tarea es recurrente (así nunca reintentamos "después" de la
 * próxima ejecución legítima).
 */
function computeNextRetryAt(task: ScheduledTask): string {
  const gapMs = RETRY_GAP_MINUTES * 60_000;
  const retryAt = new Date(Date.now() + gapMs);
  if (task.schedule_type === "recurring" && task.cron_expr) {
    const naturalNext = computeNextRunAt(task.cron_expr, task.timezone);
    if (naturalNext) {
      const natural = new Date(naturalNext);
      if (natural.getTime() < retryAt.getTime()) {
        return natural.toISOString();
      }
    }
  }
  return retryAt.toISOString();
}

function sanitizeScheduledTaskPromptForExecution(prompt: string): string {
  const cleaned = prompt
    // Legacy scheduled tasks may contain command examples created before we
    // fixed the prompt wording, e.g. "... echo; done. Devuélveme ...". The
    // period belongs to the Spanish sentence, but the model often copies it
    // into bash as `done.`, which is a syntax error. Convert only obvious
    // control-word sentence punctuation into shell-safe separators.
    .replace(/\b(done|fi|esac)\.\s+(?=(Devu[eé]lveme|Resume|Dame|Env[ií]a|M[aá]ndame)\b)/gi, "$1; ")
    .replace(/\b(done|fi|esac)\.\s*$/gi, "$1");

  const executionGuard = `Esta es la ejecución automática de una tarea ya programada. NO vuelvas a llamar schedule_task ni reagendes nada; ejecuta lo solicitado AHORA y devuelve el resultado en este mismo turno.`;
  const bashHint = cleaned !== prompt
    ? ` Si usas bash, no copies puntuación de la oración dentro del comando ("done" o "done;", nunca "done.").`
    : "";

  return `${cleaned}\n\nNota de ejecución: ${executionGuard}${bashHint}`;
}

interface TaskResult {
  task_id: string;
  status: "ok" | "skipped" | "error";
  error?: string;
}

function parseScheduledTasksConcurrency(raw: string | undefined): number {
  const trimmed = raw?.trim();
  if (!trimmed) return DEFAULT_SCHEDULED_TASKS_CONCURRENCY;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return DEFAULT_SCHEDULED_TASKS_CONCURRENCY;
  return Math.max(1, Math.min(20, Math.floor(parsed)));
}

async function runWithConcurrency(
  tasks: ScheduledTask[],
  worker: (task: ScheduledTask) => Promise<TaskResult>,
  concurrency: number
): Promise<TaskResult[]> {
  const safeConcurrency = Math.max(1, Math.min(concurrency, 20));
  const queue = [...tasks];
  const results: TaskResult[] = [];

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
    if (task.durable_task_id) {
      const durableTask = await getDurableTask(
        db,
        task.user_id,
        task.durable_task_id
      );
      if (!durableTask || durableTask.status !== "active") {
        throw new Error("scheduled_durable_task_not_active");
      }
      const parsedSpec = durableTaskSpecSchema.safeParse(
        durableTask.spec_jsonb
      );
      if (!parsedSpec.success) {
        throw new Error("scheduled_durable_task_spec_invalid");
      }
      const workRun = await createWorkRun(db, {
        userId: task.user_id,
        durableTaskId: durableTask.id,
        status: "running",
        startedAt: new Date().toISOString(),
        scheduledTaskId: task.id,
        retentionExpiresAt: new Date(
          Date.now() +
            parsedSpec.data.retention_policy.result_days * 86_400_000
        ).toISOString(),
      });
      await createWorkItemsForWorkRun(db, {
        userId: task.user_id,
        workRunId: workRun.id,
        workflowDefinitionVersion: durableTask.version,
        templates: durableTaskTemplatesToWorkItems(parsedSpec.data),
        onEnterState: "run",
      });
      const nextRunAt =
        task.schedule_type === "recurring" && task.cron_expr
          ? computeNextRunAt(task.cron_expr, task.timezone)
          : null;
      await rescheduleOrComplete(db, task, nextRunAt);
      await finishTaskRun(db, run.id, {
        status: "completed",
        notified: false,
      });
      return { task_id: task.id, status: "ok" };
    }

    // Load user context
    const profile = await getProfile(db, task.user_id);
    const toolSettings = await getUserToolSettings(db, task.user_id);
    const skillSettings = await getUserSkillSettings(db, task.user_id);
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

    // Slice 0.3 — risk-scoped allowlist. Scheduling a task (HITL) no longer
    // implies blanket approval of every inner side effect: low-risk tools
    // auto-execute; medium/high-risk tools route to the pending inbox unless
    // the legacy escape hatch (SCHEDULED_TASKS_LEGACY_AUTOAPPROVE=true) is on.
    // `autoApproveTools` stays true for its non-approval cron semantics
    // (prompt addendum, memory no-ops); the explicit per-tool policy takes
    // precedence over it in `resolveToolApprovalMode`, so approvals are
    // governed by the allowlist alone.
    const legacyAutoApprove = isScheduledTaskLegacyAutoApproveEnabled();
    const taskPolicy = normalizeToolApprovalPolicy(task.tool_approval_policy);
    const result = await runAgent({
      message: sanitizeScheduledTaskPromptForExecution(task.prompt),
      userId: task.user_id,
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
      channel: "cron",
      googleCalendarAccessToken,
      autoApproveTools: true,
      forcedSkillId: task.skill_id ?? null,
      toolApprovalPolicy: legacyAutoApprove
        ? taskPolicy
        : buildScheduledTaskToolApprovalPolicy({ taskPolicy }),
    });

    const chatId = await getTelegramChatId(db, task.user_id);

    console.log(
      `[cron] task ${task.id} run finished — toolCalls=${JSON.stringify(
        result.toolCalls
      )} responseLen=${result.response?.length ?? 0} pending_confirmation=${
        result.pendingConfirmation ? "yes" : "no"
      }`
    );

    // Slice 0.3: a non-allowlisted tool paused the run awaiting approval.
    // Surface it in the pending inbox (web card + Telegram approve/reject
    // buttons via the shared notify path) instead of auto-executing. This is
    // information, not a regression: it reveals tasks that silently depended
    // on blanket auto-approval.
    if (result.pendingConfirmation) {
      console.warn(
        `[cron] task ${task.id} routed tool "${result.pendingConfirmation.toolName}" to the pending inbox (risk allowlist; legacy_autoapprove=off)`
      );
      try {
        await notify(
          db,
          task.user_id,
          {
            kind: TOOL_CONFIRMATION_PENDING_KIND,
            text: `La tarea programada necesita tu aprobación para ejecutar «${result.pendingConfirmation.toolName}».\n\n${result.pendingConfirmation.message}`,
            data: {
              title: "Aprobación pendiente (tarea programada)",
              action_url: "/chat/pending",
              scheduled_task_id: task.id,
              pending_tool_name: result.pendingConfirmation.toolName,
              pending_tool_call_id: result.pendingConfirmation.toolCallId,
            },
          },
          "high"
        );
        notified = true;
      } catch (notifyError) {
        notificationError =
          (notifyError as Error)?.message ?? "Error notificando aprobación pendiente";
      }

      const nextRunAtPending =
        task.schedule_type === "recurring" && task.cron_expr
          ? computeNextRunAt(task.cron_expr, task.timezone)
          : null;
      await rescheduleOrComplete(db, task, nextRunAtPending);
      await finishTaskRun(db, run.id, {
        status: "completed",
        agentSessionId,
        notified,
        notificationError,
      });
      return { task_id: task.id, status: "ok" };
    }

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
        await sendTelegramMarkdownMessage(chatId, responseText, undefined, {
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

      // Política de retry/auto-pausa
      const currentFailures = task.consecutive_failures ?? 0;
      const persistent = isPersistentError(errMsg);
      const wouldExceedCap = currentFailures + 1 >= MAX_CONSECUTIVE_FAILURES;
      const shouldAutoPause = persistent || wouldExceedCap;

      if (shouldAutoPause) {
        const failures = currentFailures + 1;
        await markTaskPausedDueToFailures(db, {
          taskId: task.id,
          errorMsg: errMsg,
          failures,
        });

        // Notificar al usuario por Telegram para que no se entere por logs
        const chatId = await getTelegramChatId(db, task.user_id);
        if (chatId) {
          const reason = persistent
            ? `un error que no se resolverá reintentando (${errMsg.slice(0, 200)})`
            : `${failures} fallos consecutivos. Último error: ${errMsg.slice(0, 200)}`;
          const msg = truncateTelegramText(
            `⏸️ Tarea programada pausada\n\nPausé automáticamente la tarea por ${reason}.\n\nPrompt:\n«${task.prompt.slice(0, 500)}»\n\nCuando lo arregles, pídeme "reanuda la tarea" y la reactivo.`
          );
          try {
            await sendTelegramMessage(chatId, msg);
          } catch (notifyErr) {
            console.error(
              "[cron] failed to notify auto-pause via Telegram:",
              notifyErr
            );
          }
        }

        return {
          task_id: task.id,
          status: "error",
          error: `auto-paused: ${errMsg}`,
        };
      }

      // Retry transitorio: agendamos el siguiente intento en ~RETRY_GAP_MINUTES
      const nextRetryAt = computeNextRetryAt(task);
      await markTaskRetry(db, {
        taskId: task.id,
        nextRetryAt,
        errorMsg: errMsg,
        currentFailures,
      });
    } catch (finishErr) {
      console.error("[cron] failed to update run record:", finishErr);
      // Último recurso: dejar la tarea no activa para no generar retry storm
      try {
        await db
          .from("scheduled_tasks")
          .update({ status: "paused", updated_at: new Date().toISOString() })
          .eq("id", task.id);
      } catch {
        // swallow
      }
    }

    return { task_id: task.id, status: "error", error: errMsg };
  }
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  ensureAgentToolDepsWired();
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

  const concurrency = parseScheduledTasksConcurrency(
    process.env.SCHEDULED_TASKS_CONCURRENCY
  );
  const results = await runWithConcurrency(
    dueTasks,
    (task) => runTask(db, task),
    concurrency
  );

  console.log(
    `[cron] processed ${results.length}/${dueTasks.length} tasks (concurrency=${concurrency}):`,
    results.map((r) => `${r.task_id}=${r.status}`).join(", ")
  );

  return NextResponse.json({ processed: results.length, results });
}
