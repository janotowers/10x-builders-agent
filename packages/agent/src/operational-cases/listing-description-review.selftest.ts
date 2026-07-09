import assert from "node:assert/strict";
import { formatListingDescriptionReviewNotifyText } from "./listing-description-review";

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
assert.match(text, /\*\*Descripción:\*\* Este departamento/);
assert.match(text, /\*\*Información que aún no se tiene:\*\* superficie construida/);
assert.match(text, /\*\*Cobertura visual por completar:\*\* estado de baños/);
assert.match(text, /fotos del estacionamiento/);
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
assert.match(contextFiltered, /Cobertura visual por completar:\*\* fotos de baños/);

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

console.log("listing-description-review selftest ok");
