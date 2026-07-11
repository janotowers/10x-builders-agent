import assert from "node:assert/strict";
import { emptyPublicationState, applyPublicationEvent } from "./publication-workflow";
import {
  formatPublicationReviewNotifyText,
  runPublicationPreflight,
} from "./publication-preflight";

function baseContext(overrides: Record<string, unknown> = {}) {
  return {
    listing_description_approved: { headline: "Casa", description: "Desc" },
    pricing_proposal: { approval_status: "approved", salida: 1000000 },
    contract_review: { status: "sent_by_email" },
    raw_photos: ["a", "b"],
    photo_manifest: [
      {
        source_path: "a",
        sequence: 0,
        space_label: "Fachada",
        confidence: 0.95,
        public_url: "https://example.com/a.jpg",
        watermarked_path: "wm:a",
      },
      {
        source_path: "b",
        sequence: 1,
        space_label: "Cocina",
        confidence: 0.92,
        public_url: "https://example.com/b.jpg",
        watermarked_path: "wm:b",
      },
    ],
    ...overrides,
  };
}

let publication = emptyPublicationState();
publication = applyPublicationEvent(publication, {
  type: "approval_decided",
  destination: "easybroker",
  approval: "approved",
});
publication = applyPublicationEvent(publication, {
  type: "draft_created",
  destination: "easybroker",
  artifact: { listing_id: "EB-1", remote_status: "not_published" },
});
publication = applyPublicationEvent(publication, {
  type: "media_submitted",
  destination: "easybroker",
  expected_count: 2,
});
publication = applyPublicationEvent(publication, {
  type: "media_verified",
  destination: "easybroker",
  remote_count: 2,
});

const pass = runPublicationPreflight({
  destination: "easybroker",
  publication,
  context: baseContext(),
  remote: { status: "not_published", image_count: 2, images_ready: true },
  options: { requireWatermark: true },
});
assert.equal(pass.status, "pass", pass.summary);

const lowConfidence = runPublicationPreflight({
  destination: "easybroker",
  publication,
  context: baseContext({
    photo_manifest: [
      {
        source_path: "a",
        sequence: 0,
        space_label: "Fachada",
        confidence: 0.2,
        public_url: "https://example.com/a.jpg",
        watermarked_path: "wm:a",
      },
      {
        source_path: "b",
        sequence: 1,
        space_label: "Cocina",
        confidence: 0.9,
        public_url: "https://example.com/b.jpg",
        watermarked_path: "wm:b",
      },
    ],
  }),
  remote: { images_ready: true, image_count: 2 },
});
assert.equal(lowConfidence.status, "review_required");
assert.ok(
  lowConfidence.issues.some((i) => i.code === "photo_label_low_confidence")
);

const waiting = runPublicationPreflight({
  destination: "easybroker",
  publication: applyPublicationEvent(
    applyPublicationEvent(publication, {
      type: "media_submitted",
      destination: "easybroker",
      expected_count: 2,
    }),
    // reset verified by rebuilding media_processing state
    {
      type: "media_submitted",
      destination: "easybroker",
      expected_count: 2,
    }
  ),
  context: baseContext(),
  remote: { images_ready: false, image_count: 0 },
});
assert.equal(waiting.status, "waiting");

let ungga = emptyPublicationState();
ungga = applyPublicationEvent(ungga, {
  type: "approval_decided",
  destination: "ungga",
  approval: "approved",
});
ungga = applyPublicationEvent(ungga, {
  type: "draft_created",
  destination: "ungga",
  artifact: { ungga_property_id: "GU-1", draft_url: "https://ungga.com/app/propiedades/GU-1" },
});
const unggaDry = runPublicationPreflight({
  destination: "ungga",
  publication: ungga,
  context: baseContext(),
  remote: { ungga_property_id: "GU-1", dry_run: true },
});
assert.equal(unggaDry.status, "review_required");
assert.ok(unggaDry.issues.some((i) => i.code === "ungga_dry_run_not_persisted"));

const text = formatPublicationReviewNotifyText("easybroker", lowConfidence);
assert.ok(text.includes("Revisión requerida"));
assert.ok(text.includes("Aprobar y continuar"));

console.log("publication-preflight.selftest: ok");
