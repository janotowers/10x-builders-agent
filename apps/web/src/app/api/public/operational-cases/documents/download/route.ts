import { NextResponse } from "next/server";
import { createServerClient, getOperationalCase } from "@agents/db";
import {
  caseDocumentOutputPathFingerprint,
  verifyCaseDocumentDownloadToken,
} from "@/lib/operational-cases/case-document-download-token";
import {
  GENERATED_CASE_DOCUMENT_BINDINGS,
  GENERATED_DOCUMENT_BUCKET,
  buildFriendlyGeneratedDocumentFilename,
  resolveGeneratedDocumentOutputPathFromCase,
  safeGeneratedDocumentFilename,
} from "@/lib/operational-cases/generated-case-document";
import type { OperationalCase } from "@agents/types";

const DOCX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token")?.trim();
  if (!token) {
    return NextResponse.json({ error: "missing_token" }, { status: 400 });
  }

  const payload = verifyCaseDocumentDownloadToken(token);
  if (!payload) {
    return NextResponse.json({ error: "invalid_or_expired_token" }, { status: 403 });
  }

  const binding = GENERATED_CASE_DOCUMENT_BINDINGS[payload.documentKey];
  if (!binding) {
    return NextResponse.json({ error: "unknown_document_key" }, { status: 404 });
  }

  try {
    const db = createServerClient();
    let opCase: OperationalCase | null = null;
    let outputPath = payload.outputPath?.trim() ?? "";
    if (!outputPath) {
      opCase = await getOperationalCase(db, payload.caseId);
      if (!opCase || opCase.user_id !== payload.userId) {
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      }
      const ref = await resolveGeneratedDocumentOutputPathFromCase(db, {
        caseId: payload.caseId,
        context: (opCase.context_jsonb ?? {}) as Record<string, unknown>,
        binding,
      });
      outputPath = ref?.output_path?.trim() ?? "";
      if (
        payload.pathFingerprint &&
        outputPath &&
        caseDocumentOutputPathFingerprint(outputPath) !== payload.pathFingerprint
      ) {
        return NextResponse.json({ error: "document_superseded" }, { status: 410 });
      }
    }
    if (
      !outputPath ||
      !outputPath.startsWith(`${payload.userId}/generated-documents/`)
    ) {
      return NextResponse.json({ error: "path_not_allowed" }, { status: 403 });
    }

    const { data, error } = await db.storage
      .from(GENERATED_DOCUMENT_BUCKET)
      .download(outputPath);

    if (error || !data) {
      return NextResponse.json(
        { error: "download_failed", message: error?.message },
        { status: 404 }
      );
    }

    if (!opCase) {
      opCase = await getOperationalCase(db, payload.caseId).catch(() => null);
    }
    const filename =
      opCase && opCase.user_id === payload.userId
        ? buildFriendlyGeneratedDocumentFilename({
            opCase,
            binding,
            storagePath: outputPath,
            fallbackName: `${binding.documentKey}.docx`,
          })
        : safeGeneratedDocumentFilename(
            outputPath,
            `${binding.documentKey}.docx`
          );

    return new Response(data, {
      headers: {
        "Content-Type": DOCX_CONTENT_TYPE,
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    console.error(
      "[GET /api/public/operational-cases/documents/download] failed:",
      err
    );
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
