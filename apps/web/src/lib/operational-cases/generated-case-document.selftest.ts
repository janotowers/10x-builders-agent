import assert from "node:assert/strict";
import {
  CONTRACT_DRAFT_DOCUMENT_BINDING,
  buildCaseDocumentDownloadUrl,
  buildGeneratedDocumentContextPatch,
  caseDocumentDownloadPath,
  dedupeConcatenatedSiteOriginInUrl,
  generatedDocumentHasStoredOutput,
  normalizeNotifyTextReplacingSignedUrls,
  rewriteCaseDocumentDownloadLinksInText,
  parseGenerateDocumentRenderResult,
  parseGeneratedDocumentFromContext,
} from "./generated-case-document";

process.env.NEXT_PUBLIC_SITE_URL = "https://app.test";

assert.equal(
  caseDocumentDownloadPath("case-1", "contract_draft"),
  "/api/operational-cases/case-1/documents/contract_draft/download"
);
assert.equal(
  buildCaseDocumentDownloadUrl("case-1", CONTRACT_DRAFT_DOCUMENT_BINDING),
  "https://app.test/api/operational-cases/case-1/documents/contract_draft/download"
);

const patch = buildGeneratedDocumentContextPatch({
  caseId: "case-1",
  binding: CONTRACT_DRAFT_DOCUMENT_BINDING,
  render: {
    output_bucket: "account-assets",
    output_path: "u1/generated-documents/commission_contract/x.docx",
    template_slug: "commission_contract",
  },
});
assert.ok(patch.contract_draft?.output_path?.includes("generated-documents"));
assert.ok(patch.contract_draft?.doc_url?.includes("documents/contract_draft"));

assert.equal(
  generatedDocumentHasStoredOutput(
    { contract_draft: { output_path: "u/x.docx" } },
    CONTRACT_DRAFT_DOCUMENT_BINDING
  ),
  true
);

const longUrl =
  "https://proj.supabase.co/storage/v1/object/sign/account-assets/u1/x.docx?token=abc";
const normalized = normalizeNotifyTextReplacingSignedUrls({
  text: `Ver: ${longUrl}`,
  caseId: "case-1",
  binding: CONTRACT_DRAFT_DOCUMENT_BINDING,
});
assert.ok(!normalized.includes("supabase.co"));

const relative = `Descargar: ${caseDocumentDownloadPath("case-1", "contract_draft")}`;
const rewritten = rewriteCaseDocumentDownloadLinksInText({
  text: relative,
  caseId: "case-1",
  binding: CONTRACT_DRAFT_DOCUMENT_BINDING,
});
assert.ok(rewritten.includes("https://app.test/api/operational-cases/case-1/documents/contract_draft/download"));

const alreadyAbsolute = `Descargar: https://app.test${caseDocumentDownloadPath("case-1", "contract_draft")}`;
const noDoubleHost = rewriteCaseDocumentDownloadLinksInText({
  text: alreadyAbsolute,
  caseId: "case-1",
  binding: CONTRACT_DRAFT_DOCUMENT_BINDING,
});
assert.equal(
  noDoubleHost,
  `Descargar: https://app.test${caseDocumentDownloadPath("case-1", "contract_draft")}`
);
const doubled = `https://app.testhttps://app.test${caseDocumentDownloadPath("case-1", "contract_draft")}`;
assert.equal(
  dedupeConcatenatedSiteOriginInUrl(doubled),
  `https://app.test${caseDocumentDownloadPath("case-1", "contract_draft")}`
);

assert.equal(
  parseGenerateDocumentRenderResult(
    { ok: true, status: "rendered", output_path: "u/a.docx" },
    "listing_description"
  )?.template_slug,
  "listing_description"
);

assert.equal(
  parseGeneratedDocumentFromContext(
    { contract_draft: { template_slug: "commission_contract" } },
    CONTRACT_DRAFT_DOCUMENT_BINDING
  )?.template_slug,
  "commission_contract"
);

console.log("generated-case-document.selftest: ok");
