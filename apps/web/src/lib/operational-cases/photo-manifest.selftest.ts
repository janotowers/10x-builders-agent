import assert from "node:assert/strict";
import {
  applyPublicUrlsToManifest,
  applyWatermarkOutputsToManifest,
  buildPhotoManifestFromRawPhotos,
  imageTitlesFromManifest,
  manifestsMatchRawPhotosInOrder,
  mergePhotoLabelsIntoManifest,
  manifestNeedsLabelReview,
  publicImageUrlsFromManifest,
} from "./photo-manifest";

const raw = [
  { storage_bucket: "case-documents", storage_path: "c1/a.jpg" },
  { storage_bucket: "case-documents", storage_path: "c1/b.jpg" },
];

let manifest = buildPhotoManifestFromRawPhotos(raw);
assert.equal(manifest.length, 2);
assert.equal(manifest[0].source_path, "case-documents:c1/a.jpg");
assert.equal(manifestNeedsLabelReview(manifest), true);
assert.equal(manifestsMatchRawPhotosInOrder(manifest, raw), true);

manifest = mergePhotoLabelsIntoManifest(manifest, [
  {
    source_path: "case-documents:c1/a.jpg",
    space_label: "Fachada",
    confidence: 0.95,
  },
  {
    source_path: "case-documents:c1/b.jpg",
    space_label: "Cocina",
    confidence: 0.4,
    uncertain: true,
  },
]);
assert.equal(manifest[0].title, "Fachada");
assert.equal(manifestNeedsLabelReview(manifest), true);

const wm = applyWatermarkOutputsToManifest(manifest, [
  {
    input_path: "case-documents:c1/a.jpg",
    output_path: "account-assets:wm/1.jpg",
    ok: true,
  },
  {
    input_path: "case-documents:c1/b.jpg",
    output_path: "account-assets:wm/2.jpg",
    ok: true,
  },
]);
assert.equal(wm.ok, true);
manifest = wm.manifest;

manifest = applyPublicUrlsToManifest(manifest, [
  {
    source_path: "case-documents:c1/a.jpg",
    public_url: "https://example.com/a.jpg",
  },
  {
    source_path: "case-documents:c1/b.jpg",
    public_url: "https://example.com/b.jpg",
  },
]);
assert.deepEqual(publicImageUrlsFromManifest(manifest), [
  "https://example.com/a.jpg",
  "https://example.com/b.jpg",
]);

const titles = imageTitlesFromManifest(manifest, [
  "case-documents:c1/a.jpg",
  "case-documents:c1/b.jpg",
]);
assert.equal(titles[0], "Fachada");
assert.equal(titles[1], null, "uncertain labels must not become titles");

console.log("photo-manifest.selftest: ok");
