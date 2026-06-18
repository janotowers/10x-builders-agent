import { NextResponse } from "next/server";
import { createHash, randomUUID } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { CASE_DOCUMENTS_BUCKET } from "@agents/db";
import {
  CHAT_ATTACHMENT_MAX_BYTES,
  extractAttachmentText,
} from "@/lib/chat/extract-attachment-text";
import {
  documentExtensionFromPath,
  inferCaseDocumentKind,
  safeDocumentPathSegment,
} from "@/lib/operational-cases/case-document-ingestion";

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

  if (fileValue.size <= 0) {
    return NextResponse.json({ error: "empty_file" }, { status: 400 });
  }
  if (fileValue.size > CHAT_ATTACHMENT_MAX_BYTES) {
    return NextResponse.json(
      { error: "El archivo supera el límite de 5 MB." },
      { status: 400 }
    );
  }

  try {
    const buffer = Buffer.from(await fileValue.arrayBuffer());
    const { text, truncated } = await extractAttachmentText({
      fileName: fileValue.name,
      mimeType: fileValue.type || "application/octet-stream",
      buffer,
    });
    if (!text.trim()) {
      return NextResponse.json(
        { error: "No se pudo extraer texto del archivo." },
        { status: 400 }
      );
    }
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    const extension = documentExtensionFromPath(fileValue.name, "bin");
    const baseName = safeDocumentPathSegment(fileValue.name.replace(/\.[^.]+$/, ""));
    const storagePath = `${user.id}/chat-attachments/${randomUUID()}-${baseName}.${extension}`;
    const { error: uploadError } = await supabase.storage
      .from(CASE_DOCUMENTS_BUCKET)
      .upload(storagePath, buffer, {
        contentType: fileValue.type || "application/octet-stream",
        upsert: false,
      });
    if (uploadError) {
      return NextResponse.json(
        { error: "No se pudo guardar el adjunto para el caso." },
        { status: 500 }
      );
    }
    const suggestedKind = inferCaseDocumentKind({
      text,
      fileName: fileValue.name,
    });
    return NextResponse.json({
      fileName: fileValue.name,
      mimeType: fileValue.type || "application/octet-stream",
      sizeBytes: fileValue.size,
      text,
      truncated,
      storageBucket: CASE_DOCUMENTS_BUCKET,
      storagePath,
      sha256,
      suggestedKind,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "No se pudo procesar el archivo.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
