import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  buildExternalCaseDocumentDownloadUrl,
  buildPublicCaseDocumentDownloadUrl,
  caseDocumentOutputPathFingerprint,
  createCaseDocumentDownloadToken,
  verifyCaseDocumentDownloadToken,
} from "./case-document-download-token";

process.env.CRON_SECRET = "test-download-secret";
process.env.NEXT_PUBLIC_SITE_URL = "https://app.test";

const token = createCaseDocumentDownloadToken({
  caseId: "case-1",
  userId: "user-1",
  documentKey: "contract_draft",
  outputPath: "user-1/generated-documents/commission_contract/x.docx",
});
assert.ok(token);

const payload = verifyCaseDocumentDownloadToken(token!);
assert.equal(payload?.caseId, "case-1");
assert.equal(
  payload?.pathFingerprint,
  caseDocumentOutputPathFingerprint(
    "user-1/generated-documents/commission_contract/x.docx"
  )
);
assert.equal(payload?.outputPath, undefined);

const legacyBody = Buffer.from(
  JSON.stringify({
    c: "case-1",
    u: "user-1",
    d: "contract_draft",
    p: "user-1/generated-documents/commission_contract/x.docx",
    e: Math.floor(Date.now() / 1000) + 3600,
  }),
  "utf8"
).toString("base64url");
const legacySig = createHmac("sha256", "test-download-secret")
  .update(legacyBody)
  .digest("base64url");
const legacyPayload = verifyCaseDocumentDownloadToken(`${legacyBody}.${legacySig}`);
assert.equal(
  legacyPayload?.outputPath,
  "user-1/generated-documents/commission_contract/x.docx"
);

assert.ok(verifyCaseDocumentDownloadToken(`${token}x`) === null);

const external = buildExternalCaseDocumentDownloadUrl({
  caseId: "case-1",
  userId: "user-1",
  documentKey: "contract_draft",
  outputPath: "user-1/generated-documents/commission_contract/x.docx",
});
assert.ok(external?.includes("/api/public/operational-cases/documents/download?token="));
assert.ok(
  (external?.length ?? 0) < 280,
  `external URL should be compact, got length ${external?.length}`
);

const publicUrl = buildPublicCaseDocumentDownloadUrl(token!);
assert.ok(publicUrl.startsWith("https://app.test/api/public/"));

console.log("case-document-download-token.selftest: ok");
