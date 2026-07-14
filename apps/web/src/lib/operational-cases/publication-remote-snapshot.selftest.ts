import assert from "node:assert/strict";
import {
  canUseUnggaCliEvidence,
  isUnggaApiCredentialsMissingError,
  unggaMediaCountSatisfied,
  unggaSnapshotFromCliEvidence,
} from "./publication-remote-snapshot";

assert.equal(isUnggaApiCredentialsMissingError(new Error("ungga_api_credentials_missing")), true);
assert.equal(isUnggaApiCredentialsMissingError(new Error("other")), false);

assert.equal(
  canUseUnggaCliEvidence({
    unggaPropertyId: "hqPByZJvUmIbuo9pmV88",
    mediaRequired: true,
    mediaVerified: true,
  }),
  true
);
assert.equal(
  canUseUnggaCliEvidence({
    unggaPropertyId: "hqPByZJvUmIbuo9pmV88",
    mediaRequired: true,
    mediaVerified: false,
  }),
  false
);
assert.equal(
  canUseUnggaCliEvidence({
    unggaPropertyId: "",
    mediaRequired: false,
    mediaVerified: false,
  }),
  false
);

assert.equal(unggaMediaCountSatisfied(7, 6), true);
assert.equal(unggaMediaCountSatisfied(6, 6), true);
assert.equal(unggaMediaCountSatisfied(5, 6), false);
assert.equal(unggaMediaCountSatisfied(null, 6), false);

const snapshot = unggaSnapshotFromCliEvidence({
  unggaPropertyId: "hqPByZJvUmIbuo9pmV88",
  draftUrl: "https://ungga.com/app/propiedades/hqPByZJvUmIbuo9pmV88",
  imageCount: 7,
});
assert.equal(snapshot.ungga_property_id, "hqPByZJvUmIbuo9pmV88");
assert.equal(snapshot.status, "draft");
assert.equal(snapshot.image_count, 7);
assert.equal(snapshot.raw.source, "cli_evidence");

console.log("publication-remote-snapshot.selftest: ok");
