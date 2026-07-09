import assert from "node:assert/strict";
import {
  accountAssetToStorageRef,
  resolveImagePathsFromRawPhotos,
  TEST_PROPERTY_LISTING_PHOTOS_MAX,
  TEST_PROPERTY_LISTING_PHOTOS_PACKAGE_READY_MIN,
} from "./test-property-listing-photos";

assert.equal(
  accountAssetToStorageRef({
    storage_bucket: "case-documents",
    storage_path: "user/case/photo.jpg",
  }),
  "case-documents:user/case/photo.jpg"
);

assert.deepEqual(
  resolveImagePathsFromRawPhotos([
    "account-assets:test/a.jpg",
    {
      storage_bucket: "case-documents",
      storage_path: "u/c/b.jpg",
    },
    { storage_bucket: "", storage_path: "skip" },
    42,
  ]),
  ["account-assets:test/a.jpg", "case-documents:u/c/b.jpg"]
);

assert.equal(resolveImagePathsFromRawPhotos(null).length, 0);
assert.equal(
  resolveImagePathsFromRawPhotos(Array(10).fill("x"), 3).length,
  3
);
assert.equal(TEST_PROPERTY_LISTING_PHOTOS_PACKAGE_READY_MIN, 5);
assert.equal(TEST_PROPERTY_LISTING_PHOTOS_MAX, 30);

console.log("test-property-listing-photos.selftest: ok");
