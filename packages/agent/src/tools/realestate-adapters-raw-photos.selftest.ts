import assert from "node:assert/strict";
import {
  buildPhotoAnalysisOutput,
  normalizeEasyBrokerUploadPairs,
  normalizeAnalyzeImageStorageRef,
  resolveImagePathsFromRawPhotos,
} from "./realestate-adapters";
import { buildPhotoManifestFromRawPhotos } from "../operational-cases/photo-manifest";

assert.deepEqual(resolveImagePathsFromRawPhotos(null), []);
assert.deepEqual(resolveImagePathsFromRawPhotos([]), []);
assert.deepEqual(
  resolveImagePathsFromRawPhotos([
    "bucket-a:path/one.jpg",
    "  bucket-b:path/two.jpg  ",
    "",
  ]),
  ["bucket-a:path/one.jpg", "bucket-b:path/two.jpg"]
);
assert.deepEqual(
  resolveImagePathsFromRawPhotos([
    {
      storage_bucket: "case-photos",
      storage_path: "user/case/1.jpg",
      original_name: "fachada.jpg",
    },
    {
      storage_bucket: "case-photos",
      storage_path: "user/case/2.jpg",
    },
    { storage_bucket: "case-photos" },
    { storage_path: "orphan.jpg" },
    "case-photos:user/case/3.jpg",
  ]),
  [
    "case-photos:user/case/1.jpg",
    "case-photos:user/case/2.jpg",
    "case-documents:orphan.jpg",
    "case-photos:user/case/3.jpg",
  ]
);
assert.equal(
  resolveImagePathsFromRawPhotos(
    Array.from({ length: 40 }, (_, i) => `b:p/${i}.jpg`),
    5
  ).length,
  5
);
assert.equal(
  resolveImagePathsFromRawPhotos(
    Array.from({ length: 40 }, (_, i) => `b:p/${i}.jpg`)
  ).length,
  40,
  "default resolution must not truncate the manifest"
);

const identityManifest = buildPhotoManifestFromRawPhotos([
  "b:p/first.jpg",
  "b:p/broken.jpg",
  "b:p/third.jpg",
]);
identityManifest[1] = {
  ...identityManifest[1],
  error: {
    code: "image_load_failed",
    message: "broken",
    stage: "load",
  },
};
const analysis = buildPhotoAnalysisOutput({}, identityManifest, 2, [
  { path: "b:p/broken.jpg", error: "broken" },
]);
assert.equal(analysis.photo_manifest.length, 3);
assert.equal(analysis.photo_manifest[2].source_path, "b:p/third.jpg");
assert.deepEqual(analysis.missing, ["b:p/broken.jpg"]);

assert.deepEqual(
  normalizeEasyBrokerUploadPairs({
    images: [
      {
        source_path: "case-documents:case/original.jpg",
        upload_path: "account-assets:wm/original.jpg",
        title: "Fachada",
      },
    ],
    image_paths: ["wrong-positional-path.jpg"],
    image_titles: ["Wrong positional title"],
  }),
  [
    {
      source_path: "case-documents:case/original.jpg",
      upload_path: "account-assets:wm/original.jpg",
      title: "Fachada",
    },
  ],
  "identity-safe pairs must take precedence over positional arrays"
);

assert.equal(
  normalizeAnalyzeImageStorageRef(
    "9c32b052-f036-4911-af3c-6722d83193b9/309c2bab/foto.jpg"
  ),
  "case-documents:9c32b052-f036-4911-af3c-6722d83193b9/309c2bab/foto.jpg"
);
assert.equal(
  normalizeAnalyzeImageStorageRef("account-assets:user/asset/a.jpg"),
  "account-assets:user/asset/a.jpg"
);

console.log("realestate-adapters-raw-photos.selftest: ok");
