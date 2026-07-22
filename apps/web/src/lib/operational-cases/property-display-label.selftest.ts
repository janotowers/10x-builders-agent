import assert from "node:assert/strict";
import {
  resolvePropertyDisplayLabel,
  resolveShortPropertyAddress,
} from "./property-display-label";

assert.equal(
  resolveShortPropertyAddress({
    property_data: {
      street: "Circunvalación Sur",
      exterior_number: "3668",
      neighborhood: "Las Fuentes",
      municipality: "Zapopan",
    },
    property_title: "Casa",
  }),
  "Circunvalación Sur 3668, Las Fuentes"
);

assert.equal(
  resolvePropertyDisplayLabel({
    property_data: {
      street: "Circunvalación Sur",
      exterior_number: "3668",
      neighborhood: "Las Fuentes",
    },
    property_title: "Casa",
  }),
  "Circunvalación Sur 3668, Las Fuentes",
  "short address must win over generic title"
);

assert.equal(
  resolvePropertyDisplayLabel({
    property_title: "Depto Condesa",
  }),
  "Depto Condesa"
);

assert.equal(
  resolvePropertyDisplayLabel({
    property_data: { property_title: "Casa Roma" },
  }),
  "Casa Roma"
);

assert.equal(resolvePropertyDisplayLabel({}), "tu propiedad");
assert.equal(
  resolvePropertyDisplayLabel(null, { fallback: "el inmueble" }),
  "el inmueble"
);

assert.equal(
  resolvePropertyDisplayLabel({
    property_data: { address: "Av. México 100, Guadalajara" },
  }),
  "Av. México 100, Guadalajara"
);

console.log("property-display-label.selftest.ts: ok");
