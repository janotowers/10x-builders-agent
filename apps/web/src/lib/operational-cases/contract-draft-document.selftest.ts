import assert from "node:assert/strict";
import {
  buildContractDraftDownloadUrl,
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
