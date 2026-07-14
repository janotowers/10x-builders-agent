import assert from "node:assert/strict";
import {
  buildUnggaCliToolResponse,
  normalizeUnggaUiFields,
} from "./realestate-adapters";

{
  const mapped = normalizeUnggaUiFields({
    condition: "good",
    age_range: "unknown",
    country: "MX",
    location_type: "house",
    current_status: "existing",
    land_unit: "m2",
  });
  assert.equal(mapped.condition, "Bueno");
  assert.equal(mapped.age_range, "1-5 años");
  assert.equal(mapped.country, "México");
  assert.equal(mapped.location_type, "Residencial");
  assert.equal(mapped.current_status, "Habitable");
  assert.equal(mapped.land_unit, "m²");
}

{
  const nuevoMapped = normalizeUnggaUiFields({
    condition: "nuevo",
    age_range: "0-5 años",
  });
  assert.equal(nuevoMapped.condition, "Bueno");
  assert.equal(nuevoMapped.age_range, "1-5 años");
}

{
  const out = buildUnggaCliToolResponse(
    {
      action: "prepare_draft",
      image_urls: ["https://example.com/1.jpg", "https://example.com/2.jpg"],
    },
    {
      ok: true,
      mode: "save_draft",
      result: {
        save_outcome: { ok: true },
        ungga_property_id: null,
        draft_url: null,
        expected_image_count: 2,
        uploaded_image_count: 2,
      },
    },
    ""
  );
  assert.equal(out.ok, false);
  assert.equal(out.status, "failed");
  assert.match(String(out.error), /ungga_property_id|draft_url/i);
}

{
  const out = buildUnggaCliToolResponse(
    {
      action: "prepare_draft",
      image_urls: Array.from({ length: 6 }, (_, i) => `https://example.com/${i}.jpg`),
    },
    {
      ok: true,
      mode: "save_draft",
      result: {
        save_outcome: { ok: true },
        ungga_property_id: "GU-OK",
        draft_url: "https://ungga.com/app/propiedades/GU-OK",
        expected_image_count: 6,
        uploaded_image_count: 3,
      },
    },
    ""
  );
  assert.equal(out.ok, false);
  assert.equal(out.images_verified, false);
  assert.match(String(out.error), /Media incomplete/);
}

{
  const out = buildUnggaCliToolResponse(
    {
      action: "prepare_draft",
      image_urls: ["https://example.com/1.jpg"],
    },
    {
      ok: true,
      mode: "save_draft",
      last_step: { step: "media_upload", ok: true },
      result: {
        save_outcome: { ok: true },
        ungga_property_id: "GU-OK",
        draft_url: "https://ungga.com/app/propiedades/GU-OK",
        expected_image_count: 1,
        uploaded_image_count: 1,
        images_submitted: true,
        images_verified: true,
        last_step: { step: "resolve_draft_links", ok: true },
      },
    },
    ""
  );
  assert.equal(out.ok, true);
  assert.equal(out.status, "draft_created");
  assert.equal(out.images_verified, true);
  assert.equal(out.ungga_property_id, "GU-OK");
  assert.equal(out.requires_human_review, true);
}

console.log("realestate-adapters-ungga-cli.selftest: ok");
