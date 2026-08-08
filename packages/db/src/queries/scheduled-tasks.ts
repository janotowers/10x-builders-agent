import type { DbClient } from "../client";
import type { ToolApprovalPolicy } from "@agents/types";

export interface ScheduledTask {
  id: string;
  user_id: string;
  prompt: string;
  user_request?: string | null;
  display_title?: string | null;
  durable_task_id?: string | null;
  skill_id?: string | null;
  tool_approval_policy?: ToolApprovalPolicy | null;
  approval_policy_version?: number;
  schedule_type: "one_time" | "recurring";
  run_at: string | null;
  cron_expr: string | null;
  timezone: string;
  status: "active" | "paused" | "completed" | "failed";
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
  /**
   * Número de ejecuciones fallidas consecutivas desde la última exitosa.
   * Se resetea a 0 cuando una run completa OK o el usuario reanuda la tarea.
   * Requiere migración 00004_scheduled_tasks_retry.sql (si la migración no
   * está aplicada, el campo llega como undefined y el runner lo trata como 0).
   */
  consecutive_failures?: number;
  /** Mensaje del último error (útil para exponer motivo al auto-pausar). */
  last_failure_error?: string | null;
}

export interface ScheduledTaskRun {
  id: string;
  task_id: string;
  status: "running" | "completed" | "failed";
  started_at: string;
  finished_at: string | null;
  error: string | null;
  agent_session_id: string | null;
  notified: boolean;
  notification_error: string | null;
}

/** Persiste una nueva tarea programada y devuelve la fila creada. */
export async function createScheduledTask(
  db: DbClient,
  params: {
    userId: string;
    prompt: string;
    userRequest?: string | null;
    displayTitle?: string | null;
    durableTaskId?: string | null;
    skillId?: string | null;
    toolApprovalPolicy?: ToolApprovalPolicy | null;
    scheduleType: "one_time" | "recurring";
    runAt?: string;
    cronExpr?: string;
    timezone: string;
    nextRunAt: string;
  }
): Promise<ScheduledTask> {
  const { data, error } = await db
    .from("scheduled_tasks")
    .insert({
      user_id: params.userId,
      prompt: params.prompt,
      user_request: params.userRequest ?? null,
      display_title: params.displayTitle ?? null,
      durable_task_id: params.durableTaskId ?? null,
      skill_id: params.skillId ?? null,
      tool_approval_policy: params.toolApprovalPolicy ?? {},
      schedule_type: params.scheduleType,
      run_at: params.runAt ?? null,
      cron_expr: params.cronExpr ?? null,
      timezone: params.timezone,
      status: "active",
      next_run_at: params.nextRunAt,
    })
    .select()
    .single();
  if (error) throw error;
  return data as ScheduledTask;
}

/** Lista las tareas activas de un usuario. */
export async function listScheduledTasks(
  db: DbClient,
  userId: string
): Promise<ScheduledTask[]> {
  const { data, error } = await db
    .from("scheduled_tasks")
    .select("*")
    .eq("user_id", userId)
    .in("status", ["active", "paused"])
    .order("next_run_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as ScheduledTask[];
}

export async function getScheduledTaskForUser(
  db: DbClient,
  taskId: string,
  userId: string
): Promise<ScheduledTask | null> {
  const { data, error } = await db
    .from("scheduled_tasks")
    .select("*")
    .eq("id", taskId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return (data as ScheduledTask | null) ?? null;
}

/**
 * Lee las tareas activas cuyo next_run_at ya venció (≤ now).
 * Llamado desde el cron endpoint (service-role o supabaseAdmin).
 */
export async function getDueTasks(db: DbClient): Promise<ScheduledTask[]> {
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("scheduled_tasks")
    .select("*")
    .eq("status", "active")
    .lte("next_run_at", now);
  if (error) throw error;
  return (data ?? []) as ScheduledTask[];
}

/**
 * Marca una tarea como `running` en una operación atómica para evitar
 * doble ejecución. Devuelve true si la actualización afectó exactamente 1 fila.
 */
export async function markTaskRunning(
  db: DbClient,
  taskId: string
): Promise<boolean> {
  const now = new Date().toISOString();
  // Actualización condicional: solo si status sigue siendo 'active'.
  // PostgREST no rellena `count` en UPDATE salvo opciones extra; usamos .select()
  // para saber si hubo exactamente una fila actualizada (lock atómico).
  const { data, error } = await db
    .from("scheduled_tasks")
    .update({ status: "paused", updated_at: now })
    .eq("id", taskId)
    .eq("status", "active")
    .select("id");
  if (error) {
    console.error("markTaskRunning error:", error);
    return false;
  }
  return Array.isArray(data) && data.length > 0;
}

/**
 * Registra el inicio de una ejecución y devuelve el run_id.
 * Debe llamarse después de obtener el lock con markTaskRunning.
 */
export async function createTaskRun(
  db: DbClient,
  taskId: string
): Promise<ScheduledTaskRun> {
  const { data, error } = await db
    .from("scheduled_task_runs")
    .insert({ task_id: taskId })
    .select()
    .single();
  if (error) throw error;
  return data as ScheduledTaskRun;
}

/** Actualiza el run con resultado, sesión y flag de notificación. */
export async function finishTaskRun(
  db: DbClient,
  runId: string,
  params: {
    status: "completed" | "failed";
    error?: string;
    agentSessionId?: string;
    notified: boolean;
    notificationError?: string;
  }
) {
  const { error } = await db
    .from("scheduled_task_runs")
    .update({
      status: params.status,
      finished_at: new Date().toISOString(),
      error: params.error ?? null,
      agent_session_id: params.agentSessionId ?? null,
      notified: params.notified,
      notification_error: params.notificationError ?? null,
    })
    .eq("id", runId);
  if (error) throw error;
}

/**
 * Reactiva una tarea recurrente actualizando next_run_at, o marca
 * una tarea one_time como completed. Resetea `consecutive_failures` y
 * `last_failure_error` porque este camino solo se llama tras un run exitoso.
 */
export async function rescheduleOrComplete(
  db: DbClient,
  task: ScheduledTask,
  nextRunAt: string | null
) {
  const now = new Date().toISOString();
  if (task.schedule_type === "recurring" && nextRunAt) {
    const { error } = await db
      .from("scheduled_tasks")
      .update({
        status: "active",
        last_run_at: now,
        next_run_at: nextRunAt,
        updated_at: now,
        consecutive_failures: 0,
        last_failure_error: null,
      })
      .eq("id", task.id);
    if (error) throw error;
  } else {
    const { error } = await db
      .from("scheduled_tasks")
      .update({
        status: "completed",
        last_run_at: now,
        next_run_at: null,
        updated_at: now,
        consecutive_failures: 0,
        last_failure_error: null,
      })
      .eq("id", task.id);
    if (error) throw error;
  }
}

/**
 * Registra un fallo recuperable: incrementa `consecutive_failures`, guarda el
 * último error y agenda `next_run_at` al momento de reintento, manteniendo la
 * tarea `active` para que el siguiente tick del cron la retome.
 *
 * No cuenta con RETURNING atómico sobre incremento en PostgREST, por lo que
 * hacemos un read-modify-write. Es aceptable porque `markTaskRunning` actúa
 * como lock optimista (la tarea está `paused` temporalmente mientras se
 * ejecuta el run), así que nadie más toca esta fila en este instante.
 */
export async function markTaskRetry(
  db: DbClient,
  params: {
    taskId: string;
    nextRetryAt: string;
    errorMsg: string;
    currentFailures: number;
  }
): Promise<number> {
  const now = new Date().toISOString();
  const nextFailures = params.currentFailures + 1;
  const { error } = await db
    .from("scheduled_tasks")
    .update({
      status: "active",
      next_run_at: params.nextRetryAt,
      consecutive_failures: nextFailures,
      last_failure_error: params.errorMsg.slice(0, 2000),
      updated_at: now,
    })
    .eq("id", params.taskId);
  if (error) throw error;
  return nextFailures;
}

/**
 * Auto-pausa una tarea tras superar el máximo de fallos consecutivos.
 * Deja `consecutive_failures` y `last_failure_error` con el último valor para
 * que la UI/agente pueda explicarle al usuario por qué se pausó.
 */
export async function markTaskPausedDueToFailures(
  db: DbClient,
  params: { taskId: string; errorMsg: string; failures: number }
) {
  const now = new Date().toISOString();
  const { error } = await db
    .from("scheduled_tasks")
    .update({
      status: "paused",
      consecutive_failures: params.failures,
      last_failure_error: params.errorMsg.slice(0, 2000),
      updated_at: now,
    })
    .eq("id", params.taskId);
  if (error) throw error;
}

/**
 * Cambia el status de una tarea programada, validando que pertenezca al usuario.
 * Devuelve la fila actualizada o null si no existe, no pertenece al usuario, o
 * la transición solicitada no era aplicable (p. ej. ya está en ese status).
 *
 * Transiciones permitidas por esta función:
 *   active  → paused     (pausar)
 *   paused  → active     (reanudar; el caller debe recalcular next_run_at si aplica)
 *   active|paused → completed  (cancelar/finalizar)
 *
 * Nota: esta función no decide reglas de calendario. El caller puede pasar
 * `nextRunAt` al reanudar recurrentes para evitar reactivar fechas vencidas.
 */
export async function setScheduledTaskStatus(
  db: DbClient,
  params: {
    taskId: string;
    userId: string;
    newStatus: "active" | "paused" | "completed";
    nextRunAt?: string | null;
  }
): Promise<ScheduledTask | null> {
  const now = new Date().toISOString();
  // Cuando el usuario reanuda una tarea (paused → active), reseteamos el
  // contador de fallos y el último error: damos a la tarea un "borrón y cuenta
  // nueva" para que la política de auto-pausa no la vuelva a pausar
  // inmediatamente si el primer run post-resume falla.
  const update: Record<string, unknown> = {
    status: params.newStatus,
    updated_at: now,
  };
  if (params.newStatus === "active") {
    update.consecutive_failures = 0;
    update.last_failure_error = null;
  }
  if ("nextRunAt" in params) {
    update.next_run_at = params.nextRunAt;
  }

  let query = db
    .from("scheduled_tasks")
    .update(update)
    .eq("id", params.taskId)
    .eq("user_id", params.userId);
  if (params.newStatus === "paused") {
    query = query.eq("status", "active");
  } else if (params.newStatus === "active") {
    query = query.eq("status", "paused");
  } else {
    query = query.in("status", ["active", "paused"]);
  }
  const { data, error } = await query.select().maybeSingle();
  if (error) {
    console.error("setScheduledTaskStatus error:", error);
    return null;
  }
  return (data as ScheduledTask | null) ?? null;
}

/** Obtiene el chat_id de Telegram vinculado a un user_id, o null. */
export async function getTelegramChatId(
  db: DbClient,
  userId: string
): Promise<number | null> {
  const { data } = await db
    .from("telegram_accounts")
    .select("chat_id")
    .eq("user_id", userId)
    .maybeSingle();
  return (data as { chat_id: number } | null)?.chat_id ?? null;
}
