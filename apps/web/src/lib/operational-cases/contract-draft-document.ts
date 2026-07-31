/**
 * Flujo de contrato de comisión — binding sobre el patrón genérico
 * `generated-case-document.ts` (PATTERN_GENERATED_CASE_DOCUMENT_ACCESS).
 */

import type { DbClient } from "@agents/db";
import type { OperationalCase } from "@agents/types";
import {
  CONTRACT_DRAFT_DOCUMENT_BINDING,
  buildCaseDocumentDownloadUrl,
  buildGeneratedDocumentContextPatch,
  createSignedUrlForStoredDocument,
  defaultDownloadLabel,
  downloadGeneratedCaseDocumentForUser,
  normalizeNotifyTextReplacingSignedUrls,
  parseGeneratedDocumentFromContext,
  resolveGeneratedDocumentDeliveryUrl,
  syncGeneratedDocumentFromToolCalls,
  type GeneratedCaseDocumentRef,
  type ToolCallLike,
} from "./generated-case-document";

export {
  CONTRACT_DRAFT_DOCUMENT_BINDING,
  GENERATED_DOCUMENT_BUCKET,
  GENERATED_CASE_DOCUMENT_SIGNED_URL_TTL_SECONDS as CONTRACT_DRAFT_SIGNED_URL_TTL_SECONDS,
  parseGenerateDocumentRenderResult,
} from "./generated-case-document";

export const COMMISSION_CONTRACT_TEMPLATE_SLUG =
  CONTRACT_DRAFT_DOCUMENT_BINDING.defaultTemplateSlug ?? "commission_contract";

export type ContractDraftRef = GeneratedCaseDocumentRef;

const binding = CONTRACT_DRAFT_DOCUMENT_BINDING;

/** Alias legacy; la ruta canónica es /documents/contract_draft/download */
export function contractDraftDownloadPath(caseId: string) {
  return `/api/operational-cases/${encodeURIComponent(caseId)}/contract-draft/download`;
}

export function buildContractDraftDownloadUrl(caseId: string) {
  return buildCaseDocumentDownloadUrl(caseId, binding);
}

export function contractDraftDownloadLabel(storagePath?: string | null) {
  return defaultDownloadLabel(storagePath, binding.defaultDownloadLabel);
}

/** Acciones HITL en timeline web (= botones inline de Telegram). */
export const CONTRACT_REVIEW_WEB_ACTIONS = [
  { id: "approve_send" as const, label: "Enviar por email" },
  {
    id: "request_changes" as const,
    label: "Subir contrato corregido y enviar",
  },
];

/**
 * Texto + adjunto para el timeline web. Telegram manda el DOCX con
 * sendDocument; en web el paridad es enlace markdown clickable + chip
 * de descarga autenticada (no URL pública/token de contacto externo).
 */
export function buildContractReviewWebChatPresentation(params: {
  caseId: string;
  storagePath?: string | null;
  includeButtonsHint?: boolean;
}): {
  text: string;
  downloadUrl: string;
  attachment: {
    fileName: string;
    downloadUrl: string;
    contentType: string;
  };
  actions: typeof CONTRACT_REVIEW_WEB_ACTIONS;
} {
  const downloadUrl = buildContractDraftDownloadUrl(params.caseId);
  const fileName =
    typeof params.storagePath === "string" && params.storagePath.trim()
      ? params.storagePath.split(/[/\\]/).pop() || "contrato_comision.docx"
      : "contrato_comision.docx";
  const buttonsHint =
    params.includeButtonsHint === false
      ? "Responde “mándalo al dueño” o “pedir cambios”."
      : "Responde “mándalo al dueño” o “pedir cambios”, o usa los botones.";
  return {
    downloadUrl,
    text: [
      "Borrador de contrato listo para revisión.",
      "",
      `[Descargar borrador del contrato](${downloadUrl})`,
      "",
      buttonsHint,
    ].join("\n"),
    attachment: {
      fileName,
      downloadUrl,
      contentType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    },
    actions: CONTRACT_REVIEW_WEB_ACTIONS,
  };
}

export function normalizeContractReviewNotifyText(params: {
  text: string;
  caseId?: string;
  storagePath?: string | null;
}) {
  return normalizeNotifyTextReplacingSignedUrls({
    ...params,
    binding,
  });
}

export function parseContractDraftFromContext(context: unknown) {
  return parseGeneratedDocumentFromContext(context, binding);
}

export function buildContractDraftContextPatch(params: {
  caseId: string;
  render: {
    output_bucket: string;
    output_path: string;
    template_slug: string;
  };
}) {
  const patch = buildGeneratedDocumentContextPatch({
    caseId: params.caseId,
    binding,
    render: params.render,
  });
  return patch as { contract_draft: ContractDraftRef };
}

export async function createSignedUrlForStoredDraft(
  db: DbClient,
  draft: ContractDraftRef
) {
  return createSignedUrlForStoredDocument(db, draft);
}

export async function resolveContractDraftDeliveryUrl(
  db: DbClient,
  params: {
    caseId: string;
    context: Record<string, unknown>;
    forExternalAudience?: boolean;
  }
) {
  return resolveGeneratedDocumentDeliveryUrl(db, {
    ...params,
    binding,
  });
}

export async function syncContractDraftFromToolCalls(
  db: DbClient,
  opCase: OperationalCase,
  toolCalls: ToolCallLike[]
) {
  return syncGeneratedDocumentFromToolCalls(db, opCase, toolCalls, binding);
}

export {
  assertOperationalCaseOwnedByUser,
  safeGeneratedDocumentFilename as safeContractDraftFilename,
} from "./generated-case-document";

export async function downloadContractDraftForUser(params: {
  db: DbClient;
  userId: string;
  caseId: string;
}) {
  return downloadGeneratedCaseDocumentForUser({
    ...params,
    binding,
  });
}
