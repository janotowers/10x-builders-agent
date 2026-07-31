import { NextResponse } from "next/server";
import { createHash, randomUUID } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { CASE_DOCUMENTS_BUCKET, createServerClient } from "@agents/db";
import {
  CHAT_ATTACHMENT_MAX_BYTES,
  CHAT_IMAGE_ATTACHMENT_MAX_BYTES,
  extractAttachmentText,
  isChatImageAttachment,
} from "@/lib/chat/extract-attachment-text";
import {
  documentExtensionFromPath,
  inferCaseDocumentKind,
  safeDocumentPathSegment,
} from "@/lib/operational-cases/case-document-ingestion";

/**
 * Staging de adjuntos del chat web.
 *
 * Auth con el cliente de sesión (usuario); upload con service role porque el
 * bucket `case-documents` solo permite INSERT a service_role (00037). Al enviar
 * el mensaje, `ingestStagedCaseDocument` mueve el archivo a
 * `{userId}/{caseId}/…` y registra la fila — paridad con Telegram.
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

  if (fileValue.size <= 0) {
    return NextResponse.json({ error: "empty_file" }, { status: 400 });
  }
  const mimeType = fileValue.type || "application/octet-stream";
  const isImage = isChatImageAttachment({
    fileName: fileValue.name,
    mimeType,
  });
  const maxBytes = isImage
    ? CHAT_IMAGE_ATTACHMENT_MAX_BYTES
    : CHAT_ATTACHMENT_MAX_BYTES;
  if (fileValue.size > maxBytes) {
    return NextResponse.json(
      {
        error: isImage
          ? "La foto supera el límite de 10 MB."
          : "El archivo supera el límite de 5 MB.",
      },
      { status: 400 }
    );
  }

  try {
    const buffer = Buffer.from(await fileValue.arrayBuffer());
    const { text, truncated } = await extractAttachmentText({
      fileName: fileValue.name,
      mimeType,
      buffer,
    });
    if (!text.trim()) {
      return NextResponse.json(
        { error: "No se pudo extraer texto del archivo." },
        { status: 400 }
      );
    }
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    const extension = documentExtensionFromPath(
      fileValue.name,
      isImage ? "jpg" : "bin"
    );
    const baseName = safeDocumentPathSegment(fileValue.name.replace(/\.[^.]+$/, ""));
    const storagePath = `${user.id}/chat-staging/${randomUUID()}-${baseName}.${extension}`;
    // Service role: la política del bucket deniega INSERT al JWT de usuario.
    const db = createServerClient();
    const { error: uploadError } = await db.storage
      .from(CASE_DOCUMENTS_BUCKET)
      .upload(storagePath, buffer, {
        contentType: mimeType,
        upsert: false,
      });
    if (uploadError) {
      console.error("[chat/attachments] storage upload failed:", {
        code: uploadError.name,
        message: uploadError.message,
        bucket: CASE_DOCUMENTS_BUCKET,
        path: `${user.id}/chat-staging/…`,
      });
      return NextResponse.json(
        { error: "No se pudo guardar el adjunto para el caso." },
        { status: 500 }
      );
    }
    const suggestedKind = isImage
      ? "property_photo"
      : inferCaseDocumentKind({
          text,
          fileName: fileValue.name,
        });
    return NextResponse.json({
      fileName: fileValue.name,
      mimeType,
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
