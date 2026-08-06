import {
  buildOperationalStepLabelMap,
  formatOperationalStepForDisplay,
  friendlyOperationalStepLabel,
  humanizeOperationalStepKey,
} from "./operational-step-labels";

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

const map = buildOperationalStepLabelMap([
  { step_key: "awaiting_documents", step_label: "Solicitar documentos" },
  { step_key: "photos_requested", step_label: "Solicitar fotos" },
]);

assert(
  friendlyOperationalStepLabel("awaiting_documents", map) ===
    "Solicitar documentos",
  "card label: solo step_label del flow"
);
assert(
  friendlyOperationalStepLabel("unknown_step", map) === "Unknown Step",
  "card label: humaniza slug desconocido (sin snake_case crudo)"
);
assert(
  friendlyOperationalStepLabel("property_data_review", {}) ===
    "Revisión de datos de propiedad",
  "Spanish default when flow omits step_label"
);
assert(
  friendlyOperationalStepLabel("property_data_review", {
    property_data_review: "property_data_review",
  }) === "Revisión de datos de propiedad",
  "Spanish default when flow repeats the technical slug as label"
);
assert(
  friendlyOperationalStepLabel(null, map) === null,
  "card label: sin paso ⇒ null"
);
assert(
  formatOperationalStepForDisplay("photos_requested", map) ===
    "Solicitar fotos (photos_requested)",
  "format with DB label"
);
assert(
  formatOperationalStepForDisplay("property_data_review", {}) ===
    "Revisión de datos de propiedad (property_data_review)",
  "debug format keeps Spanish friendly + technical key"
);
assert(
  formatOperationalStepForDisplay("unknown_step", map) ===
    "Unknown Step (unknown_step)",
  "format falls back to humanized key"
);
assert(
  formatOperationalStepForDisplay(null) === "(sin paso)",
  "null step"
);
assert(
  humanizeOperationalStepKey("package_ready") === "Package Ready",
  "humanize slug"
);

console.log("operational-step-labels.selftest.ts: ok");
