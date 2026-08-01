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

// Storage gana sobre public_url (aunque el CDN sea válido).
const prefersStorageOverPublicUrl = resolveCaseCoverPhotoRef({
  photo_manifest: [
    {
      source_path: "case-documents:c1/raw.jpg",
      sequence: 0,
      public_url: "https://cdn.example/public.jpg",
    },
  ],
});
assert.deepEqual(prefersStorageOverPublicUrl, {
  kind: "storage",
  bucket: "case-documents",
  path: "c1/raw.jpg",
  contentType: "image/jpeg",
});

// public_url como fallback si el path preferido no es usable (p. ej. túnel).
const fromPublicUrlFallback = resolveCaseCoverPhotoRef({
  photo_manifest: [
    {
      source_path: "https://bad.ngrok-free.dev/gone.jpg",
      sequence: 0,
      public_url: "https://cdn.example/public.jpg",
    },
  ],
});
assert.deepEqual(fromPublicUrlFallback, {
  kind: "url",
  url: "https://cdn.example/public.jpg",
  contentType: "image/jpeg",
});

// Túnel ngrok en public_url no se usa; se queda el storage.
const skipsNgrokPublicUrl = resolveCaseCoverPhotoRef({
  photo_manifest: [
    {
      source_path: "case-documents:c1/raw.jpg",
      sequence: 0,
      public_url:
        "https://unadvised-shortsightedly-darla.ngrok-free.dev/api/public/x.jpg",
    },
  ],
});
assert.deepEqual(skipsNgrokPublicUrl, {
  kind: "storage",
  bucket: "case-documents",
  path: "c1/raw.jpg",
  contentType: "image/jpeg",
});

// Solo public_url de túnel → se ignora y se usa raw_photos.
const ngrokOnlyFallsToRaw = resolveCaseCoverPhotoRef({
  photo_manifest: [
    {
      source_path: "https://bad.ngrok-free.dev/gone.jpg",
      sequence: 0,
      public_url:
        "https://unadvised-shortsightedly-darla.ngrok-free.dev/api/public/x.jpg",
    },
  ],
  raw_photos: [
    { storage_bucket: "case-documents", storage_path: "c1/first.png" },
  ],
});
assert.deepEqual(ngrokOnlyFallsToRaw, {
  kind: "storage",
  bucket: "case-documents",
  path: "c1/first.png",
  contentType: "image/png",
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
