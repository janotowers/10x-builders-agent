import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServerClient } from "@agents/db";
import { inferCaseDocumentKind } from "@/lib/operational-cases/case-document-ingestion";
import { ingestGenericAttachment } from "@/lib/attachments";

/**
 * Generic Web Chat attachment ingestion. The resulting envelope can be used by
 * a reusable skill without a case; case-bound flows copy the same object into
 * their canonical evidence pipeline when routing resolves a case.
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const formData = await request.formData().catch(() => null);
  const fileValue = formData?.get("file");
  if (!(fileValue instanceof File)) {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }

  const mimeType = fileValue.type || "application/octet-stream";

  try {
    const bytes = new Uint8Array(await fileValue.arrayBuffer());
    const stored = await ingestGenericAttachment({
      db: createServerClient(),
      userId: user.id,
      fileName: fileValue.name,
      mimeType,
      bytes,
      channel: "web",
      source: "upload",
      metadata: { source: "web_chat_upload" },
    });
    const suggestedKind = stored.format === "image"
      ? "property_photo"
      : inferCaseDocumentKind({
          text: stored.text,
          fileName: fileValue.name,
        });
    return NextResponse.json({
      ...stored.envelope,
      text:
        stored.text ||
        `[Archivo adjunto disponible por metadata: ${fileValue.name}]`,
      truncated: stored.truncated,
      suggestedKind,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "No se pudo procesar el archivo.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
