import assert from "node:assert/strict";
import { emptyPublicationState, applyPublicationEvent } from "./publication-workflow";
import {
  formatPublicationCredentialFailureNotifyText,
  formatPublicationReviewNotifyText,
  formatUnggaPrepareDraftFailureNotifyText,
  looksLikePublicationCredentialAuthFailure,
  looksLikeUnggaPrepareDraftCommissionFailure,
  looksLikeUnggaPrepareDraftFailure,
  looksLikeUnggaPrepareDraftMediaFailure,
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
ungga = applyPublicationEvent(ungga, {
  type: "media_submitted",
  destination: "ungga",
  expected_count: 2,
});
ungga = applyPublicationEvent(ungga, {
  type: "media_verified",
  destination: "ungga",
  remote_count: 2,
});
const unggaDry = runPublicationPreflight({
  destination: "ungga",
  publication: ungga,
  context: baseContext(),
  remote: { ungga_property_id: "GU-1", dry_run: true, image_count: 2 },
});
assert.equal(unggaDry.status, "review_required");
assert.ok(unggaDry.issues.some((i) => i.code === "ungga_dry_run_not_persisted"));

let unggaMissingMedia = emptyPublicationState();
unggaMissingMedia = applyPublicationEvent(unggaMissingMedia, {
  type: "approval_decided",
  destination: "ungga",
  approval: "approved",
});
unggaMissingMedia = applyPublicationEvent(unggaMissingMedia, {
  type: "draft_created",
  destination: "ungga",
  artifact: {
    ungga_property_id: "GU-2",
    draft_url: "https://ungga.com/app/propiedades/GU-2",
  },
});
const unggaMediaBlock = runPublicationPreflight({
  destination: "ungga",
  publication: unggaMissingMedia,
  context: baseContext(),
  remote: { ungga_property_id: "GU-2", image_count: 0 },
});
assert.equal(unggaMediaBlock.status, "review_required");
assert.ok(
  unggaMediaBlock.issues.some(
    (i) =>
      i.code === "ungga_media_not_submitted" ||
      i.code === "ungga_media_not_verified"
  )
);

const unggaPass = runPublicationPreflight({
  destination: "ungga",
  publication: ungga,
  context: baseContext(),
  remote: { ungga_property_id: "GU-1", image_count: 2 },
  options: { requireWatermark: true },
});
assert.equal(unggaPass.status, "pass", unggaPass.summary);

// Ungga often shows extra thumbs; remote_count >= expected is OK.
const unggaExtraThumbs = emptyPublicationState();
unggaExtraThumbs.destinations.ungga = {
  ...ungga.destinations.ungga,
  media: {
    required: true,
    submitted: true,
    verified: true,
    expected_count: 2,
    remote_count: 3,
    last_checked_at: null,
  },
};
const unggaExtraPass = runPublicationPreflight({
  destination: "ungga",
  publication: unggaExtraThumbs,
  context: baseContext(),
  remote: { ungga_property_id: "GU-1", image_count: 3 },
  options: { requireWatermark: true },
});
assert.equal(
  unggaExtraPass.status,
  "pass",
  `extra thumbs must pass: ${unggaExtraPass.summary}`
);

const unggaTooFew = runPublicationPreflight({
  destination: "ungga",
  publication: unggaExtraThumbs,
  context: baseContext(),
  remote: { ungga_property_id: "GU-1", image_count: 1 },
  options: { requireWatermark: true },
});
assert.equal(unggaTooFew.status, "review_required");
assert.ok(
  unggaTooFew.issues.some((i) => i.code === "ungga_media_count_mismatch")
);

const noWatermarkRequired = runPublicationPreflight({
  destination: "easybroker",
  publication,
  context: baseContext({
    photo_manifest: [
      {
        source_path: "a",
        sequence: 0,
        space_label: "Fachada",
        confidence: 0.95,
        public_url: "https://example.com/a.jpg",
      },
      {
        source_path: "b",
        sequence: 1,
        space_label: "Cocina",
        confidence: 0.95,
        public_url: "https://example.com/b.jpg",
      },
    ],
  }),
  remote: { status: "not_published", image_count: 2, images_ready: true },
  options: { requireWatermark: false },
});
assert.equal(
  noWatermarkRequired.status,
  "pass",
  "missing watermarked_path must not block when watermark is not configured"
);

const text = formatPublicationReviewNotifyText("ungga", unggaMediaBlock, {
  last_step: { step: "media_upload", ok: false, error: "timeout" },
  expected_image_count: 2,
  uploaded_image_count: 0,
  has_draft_artifact: true,
  ungga_property_id: "GU-2",
});
assert.ok(text.includes("Revisión requerida"));
assert.ok(text.includes("Último paso"));
assert.ok(text.includes("GU-2"));
assert.ok(text.includes("Aprobar y continuar"));

assert.equal(
  looksLikePublicationCredentialAuthFailure(
    'EasyBroker respondió 401: Your API key is invalid — {"error":"Your API key is invalid"}'
  ),
  true
);
assert.equal(looksLikePublicationCredentialAuthFailure("timeout"), false);
const credText = formatPublicationCredentialFailureNotifyText("easybroker");
assert.ok(credText.includes("API key"));
assert.ok(credText.includes("Ajustes"));
assert.ok(credText.includes("Ya actualicé la API key"));
assert.ok(credText.includes("Pausar publicación"));
assert.ok(!credText.includes("Corregir etiquetas"));
const credViaReview = formatPublicationReviewNotifyText(
  "easybroker",
  unggaMediaBlock,
  {
    last_step: {
      step: "create_draft:easybroker:new",
      ok: false,
      error: "EasyBroker respondió 401: Your API key is invalid",
    },
    credential_failure: true,
  }
);
assert.ok(credViaReview.includes("credencial no es válida"));
assert.ok(!credViaReview.includes("listing_id"));

assert.equal(
  looksLikeUnggaPrepareDraftCommissionFailure(
    "Commission not verified: expected 4%, got null",
    {
      commission_verify: { error: "commission_input_not_filled", persisted: false },
      last_step: { step: "verify_commission", error: "commission_input_not_filled" },
      commission_verified: false,
    }
  ),
  true
);
assert.equal(
  looksLikeUnggaPrepareDraftCommissionFailure("commission_input_not_filled"),
  true
);
assert.equal(
  looksLikeUnggaPrepareDraftCommissionFailure("timeout while uploading"),
  false
);
// Bare commission_verified=false must NOT label navigation/form failures as commission.
assert.equal(
  looksLikeUnggaPrepareDraftCommissionFailure(
    "No listing fields found at https://ungga.com/app/propiedades. Adjust UNGGA_CLI_PUBLISH_PATH/selectors.",
    {
      last_step: {
        step: "prepare_draft",
        error:
          "No listing fields found at https://ungga.com/app/propiedades. Adjust UNGGA_CLI_PUBLISH_PATH/selectors.",
      },
      commission_verified: false,
    }
  ),
  false
);
assert.equal(
  looksLikeUnggaPrepareDraftFailure(
    "No listing fields found at https://ungga.com/app/propiedades. Adjust UNGGA_CLI_PUBLISH_PATH/selectors.",
    {
      last_step: {
        step: "prepare_draft",
        error:
          "No listing fields found at https://ungga.com/app/propiedades. Adjust UNGGA_CLI_PUBLISH_PATH/selectors.",
      },
    }
  ),
  true
);
assert.equal(
  looksLikeUnggaPrepareDraftFailure("commission_input_not_filled"),
  true
);
assert.equal(
  looksLikeUnggaPrepareDraftMediaFailure(
    "ungga_media_source_unreachable: image download HTTP 404 for index 0",
    { last_step: { step: "media_preflight", error: "image download HTTP 404 for index 0" } }
  ),
  true
);
assert.equal(
  looksLikeUnggaPrepareDraftMediaFailure(
    "Media incomplete: expected 6 photos, observed 0 (cause: image download HTTP 404 for index 0)"
  ),
  true
);
assert.equal(
  looksLikeUnggaPrepareDraftMediaFailure("No listing fields found at /app/propiedades"),
  false
);
assert.equal(
  looksLikeUnggaPrepareDraftFailure(
    "ungga_media_source_unreachable: image download HTTP 404 for index 0",
    { last_step: { step: "media_preflight", error: "image download HTTP 404 for index 0" } }
  ),
  true
);
const prepareFailText = formatUnggaPrepareDraftFailureNotifyText({
  cause: "commission",
  commission_expected: 4,
  commission_actual: null,
  last_step: { step: "verify_commission", ok: false, error: "commission_input_not_filled" },
  commission_verify: { error: "commission_input_not_filled", stage: "fill_input" },
});
assert.ok(prepareFailText.includes("No pude publicar en Ungga"));
assert.ok(prepareFailText.includes("comisión del 4%"));
assert.ok(prepareFailText.includes("Reintentar publicación en Ungga"));
assert.ok(prepareFailText.includes("Pausar y avisar a soporte"));
assert.ok(!prepareFailText.includes("Corregir etiquetas"));
assert.ok(!prepareFailText.includes("No hay GU-ID de borrador"));
const formFailText = formatUnggaPrepareDraftFailureNotifyText({
  cause: "form",
  last_step: {
    step: "prepare_draft",
    ok: false,
    error:
      "No listing fields found at https://ungga.com/app/propiedades. Adjust UNGGA_CLI_PUBLISH_PATH/selectors.",
  },
});
assert.ok(formFailText.includes("no se pudo completar el borrador en el formulario"));
assert.ok(formFailText.includes("No listing fields found"));
assert.ok(formFailText.includes("Reintentar publicación en Ungga"));
assert.ok(!formFailText.includes("comisión del"));
assert.ok(!formFailText.includes("Comisión observada"));
const mediaFailText = formatUnggaPrepareDraftFailureNotifyText({
  cause: "media",
  last_step: {
    step: "media_preflight",
    ok: false,
    error: "ungga_media_source_unreachable: image download HTTP 404 for index 0",
  },
});
assert.ok(mediaFailText.includes("no se pudieron cargar las fotos"));
assert.ok(mediaFailText.includes("Detalle técnico"));
assert.ok(mediaFailText.includes("HTTP 404"));
assert.ok(!mediaFailText.includes("formulario"));
assert.ok(mediaFailText.includes("Reintentar publicación en Ungga"));
const prepareViaReview = formatPublicationReviewNotifyText(
  "ungga",
  {
    status: "review_required",
    summary: "Fallo prepare_draft",
    issues: [
      {
        code: "ungga_draft_missing",
        field: "artifact.ungga_property_id",
        severity: "critical",
        message: "No hay GU-ID de borrador Ungga para publicar.",
      },
      {
        code: "ungga_media_not_verified",
        field: "media.verified",
        severity: "critical",
        message: "Ungga no verificó las 6 fotos esperadas antes de publicar.",
      },
    ],
  },
  {
    prepare_draft_failure: true,
    has_draft_artifact: false,
    ungga_property_id: null,
    commission_expected: 4,
    commission_actual: null,
    last_step: {
      step: "verify_commission",
      ok: false,
      error: "Commission not verified: expected 4%, got null",
    },
    commission_verify: { error: "commission_input_not_filled" },
  }
);
assert.ok(prepareViaReview.includes("No pude publicar en Ungga"));
assert.ok(prepareViaReview.includes("comisión del 4%"));
assert.ok(!prepareViaReview.includes("No hay GU-ID de borrador"));
assert.ok(!prepareViaReview.includes("fotos esperadas"));
assert.ok(prepareViaReview.includes("Reintentar publicación en Ungga"));
const formViaReview = formatPublicationReviewNotifyText(
  "ungga",
  {
    status: "review_required",
    summary: "Fallo prepare_draft",
    issues: [
      {
        code: "ungga_draft_missing",
        field: "artifact.ungga_property_id",
        severity: "critical",
        message: "No hay GU-ID de borrador Ungga para publicar.",
      },
    ],
  },
  {
    prepare_draft_failure: true,
    has_draft_artifact: false,
    ungga_property_id: null,
    last_step: {
      step: "prepare_draft",
      ok: false,
      error:
        "No listing fields found at https://ungga.com/app/propiedades. Adjust UNGGA_CLI_PUBLISH_PATH/selectors.",
    },
  }
);
assert.ok(formViaReview.includes("no se pudo completar el borrador en el formulario"));
assert.ok(formViaReview.includes("No listing fields found"));
assert.ok(!formViaReview.includes("comisión del"));
assert.ok(formViaReview.includes("Reintentar publicación en Ungga"));
const mediaViaReview = formatPublicationReviewNotifyText(
  "ungga",
  {
    status: "review_required",
    summary: "Fallo prepare_draft (formulario)",
    issues: [
      {
        code: "ungga_prepare_draft_failed",
        field: "prepare_draft",
        severity: "critical",
        message: "No se pudo abrir/completar el formulario.",
      },
    ],
  },
  {
    prepare_draft_failure: true,
    has_draft_artifact: false,
    ungga_property_id: null,
    last_step: {
      step: "media_preflight",
      ok: false,
      error: "ungga_media_source_unreachable: image download HTTP 404 for index 0",
    },
  }
);
assert.ok(mediaViaReview.includes("no se pudieron cargar las fotos"));
assert.ok(!mediaViaReview.includes("abrir/completar el formulario"));
assert.ok(mediaViaReview.includes("Reintentar publicación en Ungga"));
const notCalledText = formatUnggaPrepareDraftFailureNotifyText({
  last_step: {
    step: "prepare_draft",
    ok: false,
    error: "ungga_publish_listing_not_called",
  },
});
assert.ok(notCalledText.includes("la herramienta no se invocó"));
assert.ok(!notCalledText.includes("formulario"));
assert.ok(notCalledText.includes("Reintentar publicación en Ungga"));

console.log("publication-preflight.selftest: ok");
