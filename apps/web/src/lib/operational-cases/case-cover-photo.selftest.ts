import assert from "node:assert/strict";
import {
  buildListingPublishedSummaryCoverAttachment,
  caseCoverPhotoApiPath,
  extractEasybrokerUrlFromSummaryText,
  parseStorageRef,
  resolveCaseCoverPhotoRef,
} from "./case-cover-photo";

assert.deepEqual(parseStorageRef("case-documents:c1/a.jpg"), {
  bucket: "case-documents",
  path: "c1/a.jpg",
});
assert.deepEqual(parseStorageRef("c1/a.jpg"), {
  bucket: "case-documents",
  path: "c1/a.jpg",
});
assert.equal(parseStorageRef("https://cdn.example/a.jpg"), null);

const fromManifest = resolveCaseCoverPhotoRef({
  photo_manifest: [
    {
      source_path: "case-documents:c1/raw.jpg",
      sequence: 0,
      watermarked_path: "case-documents:c1/wm.jpg",
    },
  ],
  raw_photos: ["case-documents:c1/other.jpg"],
});
assert.deepEqual(fromManifest, {
  kind: "storage",
  bucket: "case-documents",
  path: "c1/wm.jpg",
  contentType: "image/jpeg",
});

const fromPublicUrl = resolveCaseCoverPhotoRef({
  photo_manifest: [
    {
      source_path: "case-documents:c1/raw.jpg",
      sequence: 0,
      public_url: "https://cdn.example/public.jpg",
    },
  ],
});
assert.deepEqual(fromPublicUrl, {
  kind: "url",
  url: "https://cdn.example/public.jpg",
  contentType: "image/jpeg",
});

const fromRaw = resolveCaseCoverPhotoRef({
  raw_photos: [
    { storage_bucket: "case-documents", storage_path: "c1/first.png" },
  ],
});
assert.deepEqual(fromRaw, {
  kind: "storage",
  bucket: "case-documents",
  path: "c1/first.png",
  contentType: "image/png",
});

assert.equal(resolveCaseCoverPhotoRef({}), null);

const summaryText = `**Resumen final de publicación**

- EasyBroker: https://www.easybroker.com/mx/listings/casa-demo
- Ungga: https://ungga.com/app/propiedades/abc
`;
assert.equal(
  extractEasybrokerUrlFromSummaryText(summaryText),
  "https://www.easybroker.com/mx/listings/casa-demo"
);

const attachment = buildListingPublishedSummaryCoverAttachment({
  caseId: "41635b3a-0b11-4bd5-86ee-0c181850b490",
  contextJsonb: {
    raw_photos: ["case-documents:c1/a.jpg"],
    published: {
      easybroker: {
        public_url: "https://www.easybroker.com/mx/listings/casa-demo",
      },
    },
  },
  text: summaryText,
});
assert.ok(attachment);
assert.equal(
  attachment?.downloadUrl,
  caseCoverPhotoApiPath("41635b3a-0b11-4bd5-86ee-0c181850b490")
);
assert.equal(
  attachment?.href,
  "https://www.easybroker.com/mx/listings/casa-demo"
);
assert.equal(attachment?.contentType, "image/jpeg");

assert.equal(
  buildListingPublishedSummaryCoverAttachment({
    caseId: "empty",
    contextJsonb: {},
  }),
  null
);

console.log("case-cover-photo.selftest: ok");
