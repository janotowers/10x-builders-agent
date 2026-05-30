import { NextResponse } from "next/server";
import {
  CONTRACT_DRAFT_DOCUMENT_BINDING,
  caseDocumentDownloadPath,
} from "@/lib/operational-cases/generated-case-document";

/**
 * Alias legacy → ruta canónica /documents/contract_draft/download
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ caseId: string }> }
) {
  const { caseId } = await context.params;
  const url = new URL(request.url);
  const target = new URL(
    caseDocumentDownloadPath(caseId, CONTRACT_DRAFT_DOCUMENT_BINDING.documentKey),
    url.origin
  );
  return NextResponse.redirect(target, { status: 307 });
}
