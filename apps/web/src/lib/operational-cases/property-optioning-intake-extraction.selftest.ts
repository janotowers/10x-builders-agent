import assert from "node:assert/strict";
import {
  extractConservativeIntakePatch,
  looksLikePlausibleZoneValue,
  mergeIntakePatches,
  normalizeIntakePatchValues,
} from "./property-optioning-intake-extraction";

// Regresión 2026-08-06: un mensaje de corrección de descripción mal ruteado
// ("…entorno/zona con las coordenadas reales del caso…") quedó guardado como
// property_zone. Una "zona" que parece instrucción no se extrae ni persiste.
assert.equal(
  looksLikePlausibleZoneValue("Las Fuentes, Zapopan, Jalisco"),
  true
);
assert.equal(looksLikePlausibleZoneValue("Colomos Providencia"), true);
assert.equal(
  looksLikePlausibleZoneValue(
    "con las coordenadas reales del caso (sin lat/lng 0) e incluye puntos de interés cercanos en la descripción"
  ),
  false
);
assert.equal(
  looksLikePlausibleZoneValue("regenera el entorno con datos reales"),
  false
);
{
  const misroutedCorrection = extractConservativeIntakePatch(
    "Regenera el entorno/zona con las coordenadas reales del caso (sin lat/lng 0) e incluye puntos de interés cercanos en la descripción"
  );
  assert.equal(misroutedCorrection.property_zone, undefined);
  const normalizedGarbage = normalizeIntakePatchValues({
    property_zone:
      "con las coordenadas reales del caso (sin lat/lng 0) e incluye puntos de interés cercanos en la descripción",
  });
  assert.equal(normalizedGarbage.property_zone, undefined);
}

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
