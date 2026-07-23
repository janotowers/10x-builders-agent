import assert from "node:assert/strict";
import {
  extractConservativeIntakePatch,
  mergeIntakePatches,
  normalizeIntakePatchValues,
} from "./property-optioning-intake-extraction";

assert.deepEqual(
  extractConservativeIntakePatch(
    "El título sería: Casa en venta en Las Fuentes. La zona/colonia: Las Fuentes, Zapopan, Jalisco, Operación: Venta"
  ),
  {
    property_title: "Casa en venta en Las Fuentes",
    property_zone: "Las Fuentes, Zapopan, Jalisco",
    operation_type: "Venta",
    property_type: "Casa",
  }
);

assert.deepEqual(
  extractConservativeIntakePatch(
    "Casa en venta en Las Fuentes. Zona: Las Fuentes, Zapopan, Jalisco, Operación: Venta"
  ),
  {
    property_title: "Casa en venta en Las Fuentes",
    property_zone: "Las Fuentes, Zapopan, Jalisco",
    operation_type: "Venta",
    property_type: "Casa",
  }
);

assert.deepEqual(
  extractConservativeIntakePatch(
    "Es una casa en venta en Las Fuentes. La zona/colonia: Las Fuentes, Zapopan, Jalisco"
  ),
  {
    property_title: "Casa en venta en Las Fuentes",
    property_zone: "Las Fuentes, Zapopan, Jalisco",
    operation_type: "Venta",
    property_type: "Casa",
  }
);

assert.deepEqual(
  extractConservativeIntakePatch(
    "Casa en venta en Las Fuentes. La zona es Las Fuentes, Zapopan, Jalisco"
  ),
  {
    property_title: "Casa en venta en Las Fuentes",
    property_zone: "Las Fuentes, Zapopan, Jalisco",
    operation_type: "Venta",
    property_type: "Casa",
  }
);

assert.deepEqual(
  extractConservativeIntakePatch(
    "Casa en venta en Las Fuentes, zona Las Fuentes, Zapopan, Jalisco"
  ),
  {
    property_title: "Casa en venta en Las Fuentes",
    property_zone: "Las Fuentes, Zapopan, Jalisco",
    operation_type: "Venta",
    property_type: "Casa",
  }
);

assert.deepEqual(
  normalizeIntakePatchValues({
    property_title: "  Casa en venta en Las Fuentes ",
    property_zone: " Las Fuentes, Zapopan ",
    operation_type: "venta",
    property_type: "casa",
  }),
  {
    property_title: "Casa en venta en Las Fuentes",
    property_zone: "Las Fuentes, Zapopan",
    operation_type: "Venta",
    property_type: "Casa",
  }
);

assert.deepEqual(
  mergeIntakePatches(
    {
      property_title: "Casa real",
      property_zone: "Zona real",
    },
    {
      property_title: "Titulo regex incorrecto con zona",
      operation_type: "Venta",
      property_type: "Casa",
    }
  ),
  {
    property_title: "Casa real",
    property_zone: "Zona real",
    operation_type: "Venta",
    property_type: "Casa",
  }
);

assert.deepEqual(
  mergeIntakePatches(
    {
      property_title: "casa en venta",
      property_zone: "Las Fuentes, Zapopan, Jalisco",
      operation_type: "Venta",
      property_type: "Casa",
    },
    {
      property_title: "Casa en venta en Las Fuentes",
      property_zone: "Las Fuentes, Zapopan, Jalisco",
      operation_type: "Venta",
      property_type: "Casa",
    }
  ),
  {
    property_title: "Casa en venta en Las Fuentes",
    property_zone: "Las Fuentes, Zapopan, Jalisco",
    operation_type: "Venta",
    property_type: "Casa",
  }
);

assert.deepEqual(
  mergeIntakePatches(
    {
      property_zone: "Las Fuentes, Zapopan, Jalisco",
      operation_type: "Venta",
      property_type: "Casa",
    },
    {}
  ),
  {
    property_title: "Casa en venta en Las Fuentes, Zapopan, Jalisco",
    property_zone: "Las Fuentes, Zapopan, Jalisco",
    operation_type: "Venta",
    property_type: "Casa",
  }
);

assert.deepEqual(
  mergeIntakePatches(
    {
      property_title: "Es una casa en venta",
      property_zone: "Las Fuentes, Zapopan, Jalisco",
      operation_type: "Venta",
      property_type: "Casa",
    },
    {}
  ),
  {
    property_title: "Es una casa en venta en Las Fuentes, Zapopan, Jalisco",
    property_zone: "Las Fuentes, Zapopan, Jalisco",
    operation_type: "Venta",
    property_type: "Casa",
  }
);

// LLM often collapses the title to bare property_type ("Casa"); prefer the
// descriptive deterministic title from free text.
assert.deepEqual(
  mergeIntakePatches(
    {
      property_title: "Casa",
      property_zone: "Las Fuentes, Zapopan, Jalisco",
      operation_type: "Venta",
      property_type: "Casa",
    },
    {
      property_title: "Casa en venta en Las Fuentes",
      property_zone: "Las Fuentes, Zapopan, Jalisco",
      operation_type: "Venta",
      property_type: "Casa",
    }
  ),
  {
    property_title: "Casa en venta en Las Fuentes",
    property_zone: "Las Fuentes, Zapopan, Jalisco",
    operation_type: "Venta",
    property_type: "Casa",
  }
);

// Bare LLM title with no deterministic title → compose type + operation + zone.
assert.deepEqual(
  mergeIntakePatches(
    {
      property_title: "Casa",
      property_zone: "Las Fuentes, Zapopan, Jalisco",
      operation_type: "Venta",
      property_type: "Casa",
    },
    {}
  ),
  {
    property_title: "Casa en venta en Las Fuentes, Zapopan, Jalisco",
    property_zone: "Las Fuentes, Zapopan, Jalisco",
    operation_type: "Venta",
    property_type: "Casa",
  }
);

console.log("property-optioning-intake-extraction.selftest.ts: ok");
