import path from "node:path";
import { NextResponse } from "next/server";
import { createServerClient } from "@agents/db";
import { createClient } from "@/lib/supabase/server";

const GENERATED_DOCUMENT_BUCKET = "account-assets";
const GENERATED_DOCUMENT_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function safeDownloadName(value: string) {
  const base = path.basename(value) || "contrato.docx";
  return base.endsWith(".docx") ? base : `${base}.docx`;
}

export async function GET(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const url = new URL(request.url);
    const bucket = cleanText(url.searchParams.get("bucket"));
    const storagePath = cleanText(url.searchParams.get("path"));
    if (!bucket || !storagePath) {
      return NextResponse.json(
        { error: "bucket and path are required" },
        { status: 400 }
      );
    }
    if (bucket !== GENERATED_DOCUMENT_BUCKET) {
      return NextResponse.json({ error: "bucket_not_allowed" }, { status: 403 });
    }
    if (!storagePath.startsWith(`${user.id}/generated-documents/`)) {
      return NextResponse.json({ error: "path_not_allowed" }, { status: 403 });
    }

    const db = createServerClient();
    const { data, error } = await db.storage.from(bucket).download(storagePath);
    if (error || !data) {
      return NextResponse.json(
        { error: error?.message ?? "download_failed" },
        { status: 404 }
      );
    }

    return new Response(data, {
      headers: {
        "Content-Type": GENERATED_DOCUMENT_CONTENT_TYPE,
        "Content-Disposition": `attachment; filename="${safeDownloadName(storagePath)}"`,
        "Cache-Control": "private, max-age=60",
      },
    });
  } catch (err) {
    console.error("[GET /api/tool-readiness/generated-document] failed:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
