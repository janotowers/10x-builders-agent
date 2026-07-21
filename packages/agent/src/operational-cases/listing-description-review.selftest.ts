import assert from "node:assert/strict";
import {
  formatListingDescriptionReviewNotifyText,
  sanitizeListingDescriptionCommercialCopy,
} from "./listing-description-review";

const text = formatListingDescriptionReviewNotifyText(
  {
    headline: "Departamento en renta con estilo contemporáneo",
    short_description: "Amplio departamento de 3 recámaras y 2 baños.",
    description:
      "Este departamento en renta se encuentra en una zona con excelente conectividad y servicios cercanos.",
    ingredients_used: [
      "property_type",
      "photo_analysis.visible_spaces",
      "photo_analysis.features_by_space",
    ],
    missing_ingredients: [
      "estado de baños",
      "parking photos",
      "area_built_m2",
    ],
  },
  { maxDescriptionLength: 1000 }
);

assert.match(text, /\*\*Revisión de descripción comercial\*\*/);
assert.match(text, /\*\*Título:\*\* Departamento/);
assert.match(text, /\*\*Resumen corto:\*\* Amplio departamento/);
assert.match(text, /\*\*Descripción:\*\* Este departamento/);
assert.match(text, /\*\*Posibles mejoras futuras \(opcionales\):\*\*/);
assert.match(
  text,
  /\*\*Título:\*\*[^\n]+\n\n\*\*Resumen corto:\*\*/,
  "blank line between Título and Resumen corto"
);
assert.match(
  text,
  /\*\*Resumen corto:\*\*[^\n]+\n\n\*\*Descripción:\*\*/,
  "blank line between Resumen corto and Descripción"
);
assert.match(
  text,
  /\*\*Descripción:\*\*[^\n]+\n\n\*\*Posibles mejoras futuras/,
  "blank line between Descripción and Posibles mejoras"
);
assert.match(text, /superficie construida/);
assert.match(text, /estado de baños/);
assert.match(text, /fotos del estacionamiento/);
assert.match(text, /No son requisitos para aprobar ni continuar/);
assert.match(text, /no solicita una nueva carga/);
assert.doesNotMatch(text, /Información que aún no se tiene/);
assert.doesNotMatch(text, /Cobertura visual por completar/);
assert.doesNotMatch(text, /Ingredientes usados/);
assert.doesNotMatch(text, /photo_analysis/);
assert.doesNotMatch(text, /area_built_m2/);
assert.doesNotMatch(text, /parking photos/);
assert.doesNotMatch(text, /Headline/);
assert.doesNotMatch(text, /Descripcion:/);
assert.doesNotMatch(text, /\n{4,}/);

const truncated = formatListingDescriptionReviewNotifyText(
  {
    description: "a".repeat(80),
  },
  { maxDescriptionLength: 30 }
);

assert.match(truncated, /texto recortado/);
assert.match(truncated, /Aprobar descripción o Pedir cambios/);
assert.doesNotMatch(truncated, /_Texto recortado/);

const contextFiltered = formatListingDescriptionReviewNotifyText(
  {
    headline: "Casa en renta",
    description: "Casa amplia en Colomos Providencia.",
    missing_ingredients: [
      "municipio",
      "estado",
      "colonia o zona",
      "superficie construida",
      "fotos de baños",
    ],
  },
  {
    currentContext: {
      property_data: {
        address: {
          city: "Guadalajara",
          state: "Jalisco",
          neighborhood: "Colomos Providencia",
        },
        construction_size: 450,
      },
    },
  }
);

assert.doesNotMatch(contextFiltered, /municipio/);
assert.doesNotMatch(contextFiltered, /estado/);
assert.doesNotMatch(contextFiltered, /colonia o zona/);
assert.doesNotMatch(contextFiltered, /superficie construida/);
assert.match(contextFiltered, /Posibles mejoras futuras \(opcionales\):\*\*/);
assert.match(contextFiltered, /fotos de baños/);

const rootConstructionSizeFiltered = formatListingDescriptionReviewNotifyText(
  {
    headline: "Casa en renta",
    description: "Casa amplia.",
    missing_ingredients: ["superficie construida"],
  },
  {
    currentContext: {
      construction_size: 450,
      property_data: {
        address: {
          city: "Guadalajara",
          state: "Jalisco",
        },
      },
    },
  }
);

assert.doesNotMatch(rootConstructionSizeFiltered, /superficie construida/);

const sanitizedCommercialCopy = sanitizeListingDescriptionCommercialCopy(
  "La propiedad cuenta con 3 recámaras, 2 baños y espacio para 2 vehículos, aunque el estacionamiento no es claramente visible en las imágenes. Está cerca de parques."
);
assert.equal(
  sanitizedCommercialCopy,
  "La propiedad cuenta con 3 recámaras, 2 baños y espacio para 2 vehículos. Está cerca de parques."
);
assert.doesNotMatch(sanitizedCommercialCopy, /imágenes|visible/i);

const priceSanitized = sanitizeListingDescriptionCommercialCopy(
  "La propiedad tiene una superficie total de 138 m² y un precio de venta de $6,784,000 MXN. Su patio con techo translúcido complementa el espacio."
);
assert.equal(
  priceSanitized,
  "Su patio con techo translúcido complementa el espacio."
);
assert.doesNotMatch(priceSanitized, /\$|6,784,000|MXN|precio de venta/i);

const structuredCommercialValuesSanitized =
  sanitizeListingDescriptionCommercialCopy(
    "Casa funcional en Las Fuentes. Renta mensual: 35,000 pesos. Comisión del 4%. Cuenta con iluminación natural."
  );
assert.equal(
  structuredCommercialValuesSanitized,
  "Casa funcional en Las Fuentes. Cuenta con iluminación natural."
);

console.log("listing-description-review selftest ok");
