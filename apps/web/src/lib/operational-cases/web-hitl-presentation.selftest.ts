import assert from "node:assert/strict";
import {
  buildWebHitlSubmitRequest,
  buildWebHitlActions,
  WEB_HITL_MIRROR_KINDS,
} from "./web-hitl-client";
import { buildWebHitlPresentation } from "./web-hitl-presentation";

process.env.NEXT_PUBLIC_SITE_URL = "https://app.test";

assert.ok(WEB_HITL_MIRROR_KINDS.has("price_approval"));
assert.ok(WEB_HITL_MIRROR_KINDS.has("listing_description_review"));

const price = buildWebHitlActions("price_approval");
assert.equal(price.length, 2);
assert.equal(price[0]?.id, "approve");
assert.equal(price[1]?.requiresNotes, true);

const priceSubmit = buildWebHitlSubmitRequest({
  kind: "price_approval",
  notificationId: "n1",
  action: price[0]!,
});
assert.ok(!("error" in priceSubmit));
if (!("error" in priceSubmit)) {
  assert.equal(priceSubmit.url, "/api/business-decisions/price-approval");
  assert.equal(priceSubmit.body.action, "approve");
}

const contract = buildWebHitlPresentation({
  kind: "contract_review",
  caseId: "case-1",
  text: "ignored",
});
assert.match(contract.text, /Descargar borrador del contrato/);
assert.equal(contract.attachments?.length, 1);
assert.ok(contract.actions.some((a) => a.id === "approve_send"));

const listing = buildWebHitlPresentation({
  kind: "listing_description_review",
  caseId: "case-1",
  text: "Revisa la descripción.",
  notificationId: "notif-ld",
  data: {
    listing_description_txt: "Casa amplia...",
    listing_description_txt_filename: "descripcion_comercial.txt",
  },
});
assert.equal(listing.attachments?.length, 1);
assert.ok(
  listing.attachments?.[0]?.downloadUrl?.includes(
    "listing-description-review/download"
  )
);
assert.match(listing.text, /\[Descargar descripción\]\(/);
assert.ok(!listing.text.includes("descripcion_comercial.txt]("));
assert.ok(listing.actions.some((a) => a.id === "approve"));

const cdr = buildWebHitlActions("contract_data_review", {
  missing_fields: [
    { key: "exclusive", kind: "boolean", optional: false, label: "Exclusiva" },
  ],
});
assert.equal(cdr.length, 2);
assert.deepEqual(cdr[0]?.body, { patch: { exclusive: true } });

const cdrMulti = buildWebHitlActions("contract_data_review", {
  missing_fields: [
    { key: "exclusive", kind: "boolean", optional: false },
    { key: "owner_email", kind: "text", optional: false },
  ],
});
assert.equal(cdrMulti.length, 0);

const upload = buildWebHitlSubmitRequest({
  kind: "photos_upload_requested",
  notificationId: "n-up",
  action: { id: "upload_done", label: "Terminé de subir" },
});
assert.ok(!("error" in upload));
if (!("error" in upload)) {
  assert.equal(upload.url, "/api/business-decisions/upload-batch-complete");
  assert.deepEqual(upload.body, { notification_id: "n-up" });
}

const titularidad = buildWebHitlActions("titularidad_review");
assert.ok(titularidad.some((a) => a.id === "continue_override"));
assert.ok(titularidad.some((a) => a.id === "request_external_evidence"));
assert.ok(titularidad.some((a) => a.id === "request_internal_docs"));
assert.equal(
  titularidad.find((a) => a.id === "continue_override")?.requiresNotes,
  true
);

console.log("web-hitl-presentation.selftest: ok");
