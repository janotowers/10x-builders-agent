import type { DbClient } from "../client";

export interface ScheduledTask {
  id: string;
  user_id: string;
  prompt: string;
  schedule_type: "one_time" | "recurring";
  run_at: string | null;
  cron_expr: string | null;
  timezone: string;
  status: "active" | "paused" | "completed" | "failed";
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
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
 * una tarea one_time como completed.
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
      })
      .eq("id", task.id);
    if (error) throw error;
  }
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
