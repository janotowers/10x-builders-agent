import assert from "node:assert/strict";
import { detectPhotoAnalysisStaleness } from "./photo-analysis-staleness";

const freshContext = {
  raw_photos: ["bucket:a.jpg", "bucket:b.jpg"],
  photo_analysis: {
    source_paths: ["bucket:b.jpg", "bucket:a.jpg"],
  },
};
assert.equal(detectPhotoAnalysisStaleness(freshContext), false);

const staleContext = {
  raw_photos: ["bucket:a.jpg", "bucket:c.jpg"],
  photo_analysis: {
    source_paths: ["bucket:a.jpg", "bucket:b.jpg"],
  },
};
assert.equal(detectPhotoAnalysisStaleness(staleContext), true);

console.log("photo-analysis-staleness.selftest: ok");

