import assert from "node:assert/strict";
import {
  buildContractDraftDownloadUrl,
  buildContractReviewWebChatPresentation,
  contractDraftDownloadPath,
  normalizeContractReviewNotifyText,
  parseGenerateDocumentRenderResult,
} from "./contract-draft-document";

process.env.NEXT_PUBLIC_SITE_URL = "https://app.test";

assert.equal(
  contractDraftDownloadPath("abc-123"),
  "/api/operational-cases/abc-123/contract-draft/download"
);
assert.equal(
  buildContractDraftDownloadUrl("abc-123"),
  "https://app.test/api/operational-cases/abc-123/documents/contract_draft/download"
);

const webPresentation = buildContractReviewWebChatPresentation({
  caseId: "abc-123",
  storagePath: "u/generated-documents/commission_contract/foo.docx",
});
assert.match(
  webPresentation.text,
  /\[Descargar borrador del contrato\]\(https:\/\/app\.test\/api\/operational-cases\/abc-123\/documents\/contract_draft\/download\)/
);
assert.equal(webPresentation.attachment.fileName, "foo.docx");
assert.equal(
  webPresentation.attachment.downloadUrl,
  "https://app.test/api/operational-cases/abc-123/documents/contract_draft/download"
);
assert.equal(webPresentation.actions.length, 2);
assert.equal(webPresentation.actions[0]?.id, "approve_send");
assert.equal(webPresentation.actions[0]?.label, "Enviar por email");
assert.equal(webPresentation.actions[1]?.id, "request_changes");
assert.equal(
  webPresentation.actions[1]?.label,
  "Subir contrato corregido y enviar"
);

const longUrl =
  "https://proj.supabase.co/storage/v1/object/sign/account-assets/u1/generated-documents/commission_contract/x.docx?token=abc";
const normalized = normalizeContractReviewNotifyText({
  text: `Revisa el borrador: ${longUrl}`,
  caseId: "case-1",
  storagePath: "u1/generated-documents/commission_contract/x.docx",
});
assert.ok(!normalized.includes("supabase.co"));
assert.ok(normalized.includes("documents/contract_draft/download"));
assert.ok(normalized.includes("Descargar"));

assert.equal(
  parseGenerateDocumentRenderResult({
    ok: true,
    status: "rendered",
    output_path: "u/generated-documents/commission_contract/1.docx",
    output_bucket: "account-assets",
  })?.output_path,
  "u/generated-documents/commission_contract/1.docx"
);

console.log("contract-draft-document.selftest: ok");
