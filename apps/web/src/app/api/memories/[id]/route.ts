import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  createServerClient,
  deleteMemory,
  getMemoryById,
  logMemoryAction,
} from "@agents/db";

export async function DELETE(
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

    // Loguear ANTES del delete para que el snapshot quede preservado en
    // memory_audit_log incluso si el cascade del DELETE arrastra el
    // memory_id (pongo memoryId=null para que no quede colgada la FK).
    await logMemoryAction(db, {
      userId: user.id,
      memoryId: null,
      action: "delete",
      details: {
        channel: "ui",
        deletedId: id,
        snapshot: { type: snapshot.type, content: snapshot.content },
      },
    });

    const deleted = await deleteMemory(db, {
      userId: user.id,
      memoryId: id,
    });

    return NextResponse.json({ ok: true, deleted });
  } catch (err) {
    console.error("[DELETE /api/memories/:id] failed:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
