import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  createServerClient,
  deleteHeartbeatChecklistTemplate,
} from "@agents/db";

type Params = { id: string };

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<Params> }
) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const db = createServerClient();
    const deleted = await deleteHeartbeatChecklistTemplate(db, {
      userId: user.id,
      templateId: id,
    });
    if (!deleted) {
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[DELETE /api/heartbeat-checklist-templates/[id]] failed:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

