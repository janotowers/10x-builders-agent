import { NextResponse } from "next/server";
import { Cron } from "croner";
import { createClient } from "@/lib/supabase/server";
import {
  createServerClient,
  getScheduledTaskForUser,
  setScheduledTaskStatus,
} from "@agents/db";

type Params = { id: string };

function computeNextRunAt(cronExpr: string, timezone: string): string | null {
  try {
    const cron = new Cron(cronExpr, { timezone });
    const next = cron.nextRun();
    return next ? next.toISOString() : null;
  } catch {
    return null;
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<Params> }
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const action = body.action;
  if (action !== "pause" && action !== "resume") {
    return NextResponse.json(
      { error: "action must be pause or resume" },
      { status: 400 }
    );
  }

  const db = createServerClient();
  let nextRunAt: string | null | undefined;
  if (action === "resume") {
    const task = await getScheduledTaskForUser(db, id, user.id);
    if (!task || task.status !== "paused") {
      return NextResponse.json(
        { error: "Scheduled task not found or not paused" },
        { status: 404 }
      );
    }
    if (task.schedule_type === "one_time") {
      const scheduledAt = task.next_run_at ?? task.run_at;
      if (!scheduledAt || new Date(scheduledAt).getTime() <= Date.now()) {
        return NextResponse.json(
          {
            error:
              "Esta tarea de una sola vez ya tiene fecha pasada. Programa una nueva tarea para ejecutarla otra vez.",
          },
          { status: 409 }
        );
      }
      nextRunAt = scheduledAt;
    } else {
      if (!task.cron_expr) {
        return NextResponse.json(
          { error: "La tarea recurrente no tiene cron_expr configurado." },
          { status: 409 }
        );
      }
      nextRunAt = computeNextRunAt(task.cron_expr, task.timezone);
      if (!nextRunAt) {
        return NextResponse.json(
          { error: "No se pudo calcular la próxima ejecución recurrente." },
          { status: 409 }
        );
      }
    }
  }

  const updated = await setScheduledTaskStatus(db, {
    taskId: id,
    userId: user.id,
    newStatus: action === "pause" ? "paused" : "active",
    nextRunAt,
  });

  if (!updated) {
    return NextResponse.json(
      { error: "Scheduled task not found or not editable" },
      { status: 404 }
    );
  }

  return NextResponse.json({ ok: true, task: updated });
}
