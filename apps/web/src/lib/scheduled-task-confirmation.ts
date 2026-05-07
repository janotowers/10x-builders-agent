type Queryable = {
  from(table: string): any;
};

function normalizeScheduleType(value: unknown): "one_time" | "recurring" | null {
  return value === "one_time" || value === "recurring" ? value : null;
}

function normalizeTimezone(value: unknown, fallback?: string | null): string {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : fallback || "UTC";
}

export function isScheduleTaskConfirmation(value: {
  toolName?: string | null;
  args?: Record<string, unknown> | null;
}): value is { toolName: "schedule_task"; args: Record<string, unknown> } {
  return value.toolName === "schedule_task" && Boolean(value.args);
}

export async function findExistingScheduledTaskForConfirmation(
  db: Queryable,
  params: {
    userId: string;
    args: Record<string, unknown>;
    fallbackTimezone?: string | null;
  }
): Promise<Record<string, unknown> | null> {
  const prompt = typeof params.args.prompt === "string" ? params.args.prompt : "";
  const scheduleType = normalizeScheduleType(params.args.schedule_type);
  if (!prompt || !scheduleType) return null;

  let query = db
    .from("scheduled_tasks")
    .select(
      "id, prompt, display_title, skill_id, schedule_type, run_at, cron_expr, timezone, next_run_at, status"
    )
    .eq("user_id", params.userId)
    .eq("prompt", prompt)
    .eq("schedule_type", scheduleType)
    .in("status", ["active", "paused"])
    .order("created_at", { ascending: false })
    .limit(1);

  if (scheduleType === "recurring") {
    const cronExpr =
      typeof params.args.cron_expr === "string"
        ? params.args.cron_expr.trim()
        : "";
    if (!cronExpr) return null;
    query = query
      .eq("cron_expr", cronExpr)
      .eq("timezone", normalizeTimezone(params.args.timezone, params.fallbackTimezone));
  } else {
    const runAt =
      typeof params.args.run_at === "string" ? params.args.run_at : "";
    const runAtTime = new Date(runAt).getTime();
    if (!Number.isFinite(runAtTime)) return null;
    query = query.eq("run_at", new Date(runAtTime).toISOString());
  }

  const { data, error } = await query.maybeSingle();
  if (error || !data || typeof data !== "object") return null;
  return data as Record<string, unknown>;
}
