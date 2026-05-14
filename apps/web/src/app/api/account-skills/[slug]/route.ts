/**
 * DELETE /api/account-skills/[slug] → soft-deletes una account_skill (status=archived).
 *                                     Para borrar de verdad usa el SQL admin.
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  createServerClient,
  getAccountSkill,
  upsertAccountSkill,
} from "@agents/db";

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ slug: string }> }
) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { slug } = await context.params;
    const db = createServerClient();
    const existing = await getAccountSkill(db, user.id, slug);
    if (!existing) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    const archived = await upsertAccountSkill(db, {
      userId: user.id,
      slug,
      bodyMd: existing.body_md,
      metadata: existing.metadata_jsonb,
      status: "archived",
    });
    return NextResponse.json({ ok: true, skill: archived });
  } catch (err) {
    console.error("[DELETE /api/account-skills/:slug] failed:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
