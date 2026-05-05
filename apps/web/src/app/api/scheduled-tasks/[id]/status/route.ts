import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServerClient, setScheduledTaskStatus } from "@agents/db";

type Params = { id: string };

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
  const updated = await setScheduledTaskStatus(db, {
    taskId: id,
    userId: user.id,
    newStatus: action === "pause" ? "paused" : "active",
  });

  if (!updated) {
    return NextResponse.json(
      { error: "Scheduled task not found or not editable" },
      { status: 404 }
    );
  }

  return NextResponse.json({ ok: true, task: updated });
}
