import assert from "node:assert/strict";
import {
  CONTRACT_DRAFT_DOCUMENT_BINDING,
  buildCaseDocumentDownloadUrl,
  buildFriendlyGeneratedDocumentFilename,
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

const friendlyWithAddress = buildFriendlyGeneratedDocumentFilename({
  opCase: {
    id: "11112222-3333-4444-5555-666677778888",
    context_jsonb: {
      property_data: { address: "Av. Reforma 123, Cuauhtémoc" },
    },
    external_contact_jsonb: { display_name: "Juan Pérez" },
    created_at: "2026-06-29T10:00:00.000Z",
  },
  binding: CONTRACT_DRAFT_DOCUMENT_BINDING,
  storagePath: "u1/generated-documents/commission_contract/171-case.docx",
});
assert.equal(
  friendlyWithAddress,
  "contrato-comision-av-reforma-123-cuauhtemoc-11112222-2026-06-29.docx"
);

const friendlyWithContactFallback = buildFriendlyGeneratedDocumentFilename({
  opCase: {
    id: "abcd1234efgh",
    context_jsonb: {},
    external_contact_jsonb: { display_name: "María José" },
    created_at: "2026-01-05T00:00:00.000Z",
  },
  binding: CONTRACT_DRAFT_DOCUMENT_BINDING,
  storagePath: "u1/generated-documents/commission_contract/x.docx",
});
assert.equal(
  friendlyWithContactFallback,
  "contrato-comision-maria-jose-abcd1234-2026-01-05.docx"
);

const friendlyNoLabel = buildFriendlyGeneratedDocumentFilename({
  opCase: {
    id: "zzzz9999",
    context_jsonb: {},
    external_contact_jsonb: null,
    created_at: "2026-03-10T00:00:00.000Z",
  },
  binding: CONTRACT_DRAFT_DOCUMENT_BINDING,
  storagePath: "u1/generated-documents/commission_contract/x.docx",
});
assert.equal(
  friendlyNoLabel,
  "contrato-comision-zzzz9999-2026-03-10.docx"
);

console.log("generated-case-document.selftest: ok");
