import { NextResponse } from "next/server";
import { createServerClient, getOperationalCase } from "@agents/db";
import { createClient } from "@/lib/supabase/server";
import { resolveCaseCoverPhotoRef } from "@/lib/operational-cases/case-cover-photo";

/**
 * Portada autenticada del caso (primera foto del manifiesto / raw_photos).
 * Usada por el preview del resumen final en chat web (paridad visual con Telegram OG).
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ caseId: string }> }
) {
  const { caseId } = await context.params;
  if (!caseId?.trim()) {
    return NextResponse.json({ error: "missing_case_id" }, { status: 400 });
  }

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const db = createServerClient();
    const opCase = await getOperationalCase(db, caseId.trim());
    if (!opCase || opCase.user_id !== user.id) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    const cover = resolveCaseCoverPhotoRef(opCase.context_jsonb);
    if (!cover) {
      return NextResponse.json({ error: "no_cover" }, { status: 404 });
    }

    if (cover.kind === "url") {
      return NextResponse.redirect(cover.url, 302);
    }

    const { data, error } = await db.storage
      .from(cover.bucket)
      .download(cover.path);
    if (error || !data) {
      return NextResponse.json({ error: "download_failed" }, { status: 404 });
    }

    const bytes = Buffer.from(await data.arrayBuffer());
    return new Response(bytes, {
      headers: {
        "Content-Type": cover.contentType,
        "Cache-Control": "private, max-age=300",
        "Content-Disposition": 'inline; filename="cover.jpg"',
      },
    });
  } catch (err) {
    console.error(
      "[GET /api/operational-cases/:caseId/photos/cover] failed:",
      err
    );
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
