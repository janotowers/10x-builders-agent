import assert from "node:assert/strict";
import {
  mapNaturalAndTechnicalLabels,
  naturalAndTechnicalLabel,
  naturalLabelForSlug,
} from "./readiness-labels";

assert.equal(
  naturalAndTechnicalLabel("photo_analysis"),
  "análisis de fotos (photo_analysis)"
);
assert.equal(naturalAndTechnicalLabel("case_form"), "formulario del caso");
assert.equal(naturalAndTechnicalLabel("formulario del caso"), "formulario del caso");
assert.equal(naturalAndTechnicalLabel("artefactos previos"), "artefactos previos");
assert.equal(naturalLabelForSlug("manual_overrides"), "overrides manuales");

const mapped = mapNaturalAndTechnicalLabels([
  "prior_artifacts",
  "formulario del caso",
  "manual_overrides",
]);
assert.deepEqual(mapped, [
  "artefactos previos del caso",
  "formulario del caso",
  "overrides manuales",
]);

console.log("readiness-labels.selftest: ok");
