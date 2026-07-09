import assert from "node:assert/strict";
import { resolveAssetRequirementPresentation } from "./asset-requirement-presentation";

const listingPhotos = resolveAssetRequirementPresentation({
  asset_key: "test_property_listing_photos",
  accept: ["image/jpeg"],
  collection: true,
});
assert.equal(listingPhotos.kind, "listing_photo");
assert.equal(listingPhotos.addButtonLabel, "Agregar fotos");
assert.equal(listingPhotos.showDocumentKindSelector, false);
assert.equal(listingPhotos.collectionReadyLabel, "fotos listas");

const propertyDocument = resolveAssetRequirementPresentation({
  asset_key: "test_property_document",
  accept: ["application/pdf"],
  collection: false,
});
assert.equal(propertyDocument.kind, "property_document");
assert.equal(propertyDocument.showDocumentKindSelector, true);
assert.equal(propertyDocument.replaceButtonLabel, "Reemplazar documento");

const watermark = resolveAssetRequirementPresentation({
  asset_key: "listing_photo_watermark",
  accept: ["image/png"],
  collection: false,
});
assert.equal(watermark.kind, "watermark_image");
assert.equal(watermark.currentPrefix, "Watermark actual");

console.log("asset-requirement-presentation.selftest: ok");
