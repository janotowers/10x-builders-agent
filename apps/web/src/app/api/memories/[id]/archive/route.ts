import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  createServerClient,
  archiveMemory,
  getMemoryById,
  logMemoryAction,
} from "@agents/db";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    if (!id) {
      return NextResponse.json({ error: "id required" }, { status: 400 });
    }

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const db = createServerClient();
    const snapshot = await getMemoryById(db, {
      userId: user.id,
      memoryId: id,
    });
    if (!snapshot) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (snapshot.archived_at) {
      return NextResponse.json({ ok: true, archived: false, alreadyArchived: true });
    }

    const archived = await archiveMemory(db, {
      userId: user.id,
      memoryId: id,
    });
    await logMemoryAction(db, {
      userId: user.id,
      memoryId: id,
      action: "archive",
      details: {
        channel: "ui",
        snapshot: { type: snapshot.type, content: snapshot.content },
      },
    });

    return NextResponse.json({ ok: true, archived });
  } catch (err) {
    console.error("[POST /api/memories/:id/archive] failed:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
