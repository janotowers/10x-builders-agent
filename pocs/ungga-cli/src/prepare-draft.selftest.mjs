import assert from "node:assert/strict";
import {
  evaluatePrepareDraftSuccess,
  extractPropertyIdFromUrl,
  lastMeaningfulStep,
  resolveUnggaTimeoutMs,
  validateUnggaCliPrepareDraftResult,
} from "./prepare-draft-contract.mjs";

{
  assert.equal(
    extractPropertyIdFromUrl(
      "https://ungga.com/app/propiedades/vowMl9le6jQsOAYuSIIERGuOW1F2EB-WL7415"
    ),
    "vowMl9le6jQsOAYuSIIERGuOW1F2EB-WL7415"
  );
  assert.equal(
    extractPropertyIdFromUrl("https://ungga.com/app/propiedades/nueva"),
    null
  );
}

{
  const prev = { ...process.env };
  delete process.env.UNGGA_CLI_TOTAL_TIMEOUT_MS;
  delete process.env.UNGGA_CLI_TIMEOUT_MS;
  delete process.env.UNGGA_CLI_NAV_TIMEOUT_MS;
  delete process.env.UNGGA_CLI_ACTION_TIMEOUT_MS;
  assert.equal(resolveUnggaTimeoutMs("total"), 600_000);
  assert.equal(resolveUnggaTimeoutMs("nav"), 45_000);
  assert.equal(resolveUnggaTimeoutMs("action"), 15_000);
  process.env.UNGGA_CLI_TIMEOUT_MS = "120000";
  process.env.UNGGA_CLI_NAV_TIMEOUT_MS = "12000";
  assert.equal(resolveUnggaTimeoutMs("total"), 120_000);
  assert.equal(resolveUnggaTimeoutMs("nav"), 12_000);
  process.env.UNGGA_CLI_TOTAL_TIMEOUT_MS = "310000";
  assert.equal(resolveUnggaTimeoutMs("total"), 310_000);
  Object.assign(process.env, prev);
}

{
  assert.equal(
    lastMeaningfulStep([
      { step: "login", ok: true },
      { step: "save_draft", ok: false, error: "disabled" },
      { step: "screenshot", ok: true },
    ])?.step,
    "save_draft"
  );
}

{
  const failedSave = evaluatePrepareDraftSuccess({
    dryRun: false,
    expectedImageCount: 6,
    uploadedImageCount: 6,
    saveOutcome: { ok: false, error: "Botón deshabilitado" },
    draftLinks: null,
  });
  assert.equal(failedSave.ok, false);
  assert.match(failedSave.error ?? "", /deshabilitado|Guardar/i);
}

{
  const missingId = evaluatePrepareDraftSuccess({
    dryRun: false,
    expectedImageCount: 6,
    uploadedImageCount: 6,
    saveOutcome: { ok: true },
    draftLinks: { ungga_property_id: null, draft_url: null },
  });
  assert.equal(missingId.ok, false);
  assert.match(missingId.error ?? "", /GU-ID|draft_url/i);
}

{
  const incompleteMedia = evaluatePrepareDraftSuccess({
    dryRun: false,
    expectedImageCount: 6,
    uploadedImageCount: 2,
    saveOutcome: { ok: true },
    draftLinks: {
      ungga_property_id: "GU-1",
      draft_url: "https://ungga.com/app/propiedades/GU-1",
    },
  });
  assert.equal(incompleteMedia.ok, false);
  assert.match(incompleteMedia.error ?? "", /Media incomplete/);
}

{
  const successExtraThumb = evaluatePrepareDraftSuccess({
    dryRun: false,
    expectedImageCount: 6,
    uploadedImageCount: 7,
    saveOutcome: { ok: true },
    draftLinks: {
      ungga_property_id: "GU-1",
      draft_url: "https://ungga.com/app/propiedades/GU-1",
    },
  });
  assert.equal(successExtraThumb.ok, true);
  assert.equal(successExtraThumb.images_verified, true);
}

{
  const success = evaluatePrepareDraftSuccess({
    dryRun: false,
    expectedImageCount: 6,
    uploadedImageCount: 6,
    saveOutcome: { ok: true },
    draftLinks: {
      ungga_property_id: "GU-1",
      draft_url: "https://ungga.com/app/propiedades/GU-1",
    },
  });
  assert.equal(success.ok, true);
  assert.equal(success.images_verified, true);
  assert.equal(success.ungga_property_id, "GU-1");
}

{
  const falsePositive = validateUnggaCliPrepareDraftResult({
    ok: true,
    mode: "save_draft",
    result: {
      save_outcome: { ok: true },
      draft_url: null,
      ungga_listing_id: null,
      expected_image_count: 6,
      uploaded_image_count: 6,
    },
  });
  assert.equal(falsePositive.ok, false);
}

{
  const incomplete = validateUnggaCliPrepareDraftResult({
    ok: true,
    mode: "save_draft",
    result: {
      save_outcome: { ok: true },
      draft_url: "https://ungga.com/app/propiedades/GU-2",
      ungga_property_id: "GU-2",
      expected_image_count: 6,
      uploaded_image_count: 1,
    },
  });
  assert.equal(incomplete.ok, false);
}

{
  const ok = validateUnggaCliPrepareDraftResult({
    ok: true,
    mode: "save_draft",
    result: {
      save_outcome: { ok: true },
      draft_url: "https://ungga.com/app/propiedades/GU-3",
      ungga_property_id: "GU-3",
      expected_image_count: 6,
      uploaded_image_count: 6,
      images_submitted: true,
      images_verified: true,
    },
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.images_verified, true);
}

console.log("prepare-draft.selftest: ok");
