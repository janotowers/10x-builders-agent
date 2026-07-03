import {
  buildOperationalStepLabelMap,
  formatOperationalStepForDisplay,
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
  formatOperationalStepForDisplay("photos_requested", map) ===
    "Solicitar fotos (photos_requested)",
  "format with DB label"
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
