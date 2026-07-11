import assert from "node:assert/strict";
import {
  applyPublicUrlsToManifest,
  applyWatermarkOutputsToManifest,
  buildPhotoManifestFromRawPhotos,
  mergePhotoLabelsIntoManifest,
  photoUploadPairsFromManifest,
} from "./photo-manifest";

const raw = Array.from({ length: 12 }, (_, index) => ({
  storage_bucket: "case-documents",
  storage_path: `case/photo-${index}.jpg`,
}));
let manifest = buildPhotoManifestFromRawPhotos(raw);
assert.equal(manifest.length, 12, "manifest must never truncate raw photos");

manifest = mergePhotoLabelsIntoManifest(manifest, [
  {
    source_path: "case-documents:case/photo-0.jpg",
    sha256: "a".repeat(64),
    space_label: "Fachada",
    confidence: 0.98,
  },
  {
    source_path: "case-documents:case/photo-1.jpg",
    space_label: null,
    confidence: null,
    uncertain: true,
    error: {
      code: "image_load_failed",
      message: "bad image",
      stage: "load",
    },
  },
]);
assert.equal(manifest[0].sha256, "a".repeat(64));
assert.equal(manifest[1].error?.code, "image_load_failed");
assert.equal(manifest[2].sequence, 2, "a failed image must not shift later entries");

const watermarked = applyWatermarkOutputsToManifest(manifest, [
  {
    input_path: "case-documents:case/photo-0.jpg",
    output_bucket: "account-assets",
    output_path: "wm/photo-0.jpg",
    ok: true,
  },
  {
    input_path: "case-documents:case/photo-1.jpg",
    ok: false,
    error: "watermark failed",
  },
]);
assert.equal(
  watermarked.manifest[0].watermarked_path,
  "account-assets:wm/photo-0.jpg"
);
assert.ok(watermarked.missing.includes("case-documents:case/photo-1.jpg"));
assert.equal(watermarked.manifest[1].error?.stage, "watermark");

const withUrls = applyPublicUrlsToManifest(
  watermarked.manifest,
  [
    {
      source_path: "case-documents:case/photo-0.jpg",
      public_url: "https://cdn.example/photo-0.jpg",
      title: "Fachada",
    },
  ],
  "easybroker"
);
assert.equal(withUrls[0].destinations?.easybroker?.uploaded, true);
assert.equal(withUrls[0].public_url, "https://cdn.example/photo-0.jpg");
assert.equal(
  photoUploadPairsFromManifest(withUrls)[0].upload_path,
  "account-assets:wm/photo-0.jpg"
);
assert.equal(photoUploadPairsFromManifest(withUrls)[1].title, null);

console.log("photo-manifest.selftest: ok");
