import { NextResponse } from "next/server";
import { createServerClient } from "@agents/db";
import { createClient } from "@/lib/supabase/server";
import {
  GENERATED_CASE_DOCUMENT_BINDINGS,
  downloadGeneratedCaseDocumentForUser,
} from "@/lib/operational-cases/generated-case-document";

const DOCX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export async function GET(
  _request: Request,
  context: { params: Promise<{ caseId: string; documentKey: string }> }
) {
  const { caseId, documentKey } = await context.params;
  const binding = GENERATED_CASE_DOCUMENT_BINDINGS[documentKey];
  if (!binding) {
    return NextResponse.json({ error: "unknown_document_key" }, { status: 404 });
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
    const result = await downloadGeneratedCaseDocumentForUser({
      db,
      userId: user.id,
      caseId,
      binding,
    });

    if ("error" in result) {
      if (result.error === "not_found") {
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      }
      if (result.error === "no_document") {
        return NextResponse.json(
          {
            error: "no_document",
            hint: "Genera el documento con generate_document_from_template antes de descargar.",
          },
          { status: 404 }
        );
      }
      if (result.error === "path_not_allowed") {
        return NextResponse.json({ error: "path_not_allowed" }, { status: 403 });
      }
      return NextResponse.json(
        { error: result.error, message: result.message },
        { status: 404 }
      );
    }

    return new Response(result.data, {
      headers: {
        "Content-Type": DOCX_CONTENT_TYPE,
        "Content-Disposition": `attachment; filename="${result.filename}"`,
        "Cache-Control": "private, max-age=60",
      },
    });
  } catch (err) {
    console.error(
      "[GET /api/operational-cases/:caseId/documents/:documentKey/download] failed:",
      err
    );
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
