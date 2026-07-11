import assert from "node:assert/strict";
import { mergeEasyBrokerCreateInputFromCaseSources } from "./realestate-adapters";

const baseInput = {
  title: "Casa en venta",
  description: "Descripción de prueba lo suficientemente larga.",
  operation: "sale" as const,
  property_type: "Casa",
  price: 1_000_000,
  street: "CIRCUNVALACION SUR",
  location: {
    state: "Jalisco",
    country: "MX",
    municipality: "Zapopan",
  },
  case_id: "case-1",
};

const fromAddress = mergeEasyBrokerCreateInputFromCaseSources(baseInput, {
  propertyData: {
    address: {
      street: "CIRCUNVALACION SUR",
      exterior_number: "3668",
      neighborhood: "Las Fuentes",
      municipality: "Zapopan",
      state: "Jalisco",
      latitude: 20.6200855,
      longitude: -103.4256502,
      geocode_confidence: "high",
    },
  },
});

assert.equal(fromAddress.location?.latitude, 20.6200855);
assert.equal(fromAddress.location?.longitude, -103.4256502);
assert.equal(fromAddress.location?.city, "Zapopan");
assert.equal(fromAddress.location?.neighborhood, "Las Fuentes");
assert.equal(fromAddress.street, "CIRCUNVALACION SUR");

const fromZoneContext = mergeEasyBrokerCreateInputFromCaseSources(
  {
    ...baseInput,
    location: { municipality: "Zapopan", state: "Jalisco", country: "MX" },
  },
  {
    propertyData: { address: { street: "CIRCUNVALACION SUR" } },
    zoneContext: {
      latitude: 20.61,
      longitude: -103.42,
      coordinate_source: "geocode_property_address",
    },
  }
);
assert.equal(fromZoneContext.location?.latitude, 20.61);
assert.equal(fromZoneContext.location?.longitude, -103.42);

const preservesExplicitCoords = mergeEasyBrokerCreateInputFromCaseSources(
  {
    ...baseInput,
    location: {
      latitude: 19.43,
      longitude: -99.13,
      city: "CDMX",
    },
  },
  {
    propertyData: {
      address: { latitude: 20.62, longitude: -103.42 },
    },
  }
);
assert.equal(preservesExplicitCoords.location?.latitude, 19.43);
assert.equal(preservesExplicitCoords.location?.longitude, -99.13);
assert.equal(preservesExplicitCoords.location?.city, "CDMX");

const rejectsNullIsland = mergeEasyBrokerCreateInputFromCaseSources(baseInput, {
  propertyData: {
    address: { latitude: 0, longitude: 0 },
  },
  zoneContext: { latitude: 20.62, longitude: -103.42 },
});
assert.equal(rejectsNullIsland.location?.latitude, 20.62);
assert.equal(rejectsNullIsland.location?.longitude, -103.42);

// Replica del payload que falló en E2E (location sin lat/lng, solo municipality).
const e2eFailureShape = mergeEasyBrokerCreateInputFromCaseSources(
  {
    title: "Casa en venta en Fraccionamiento Las Fuentes, Zapopan",
    description: "x".repeat(80),
    operation: "sale",
    property_type: "Casa",
    price: 6784000,
    street: "CIRCUNVALACION SUR",
    location: {
      state: "Jalisco",
      country: "MX",
      municipality: "Zapopan",
    },
    case_id: "97d9ba19-687d-4fd6-8b7d-75be29b5f285",
  },
  {
    propertyData: {
      address: {
        street: "CIRCUNVALACION SUR",
        exterior_number: "3668",
        neighborhood: "Las Fuentes",
        municipality: "Zapopan",
        state: "Jalisco",
        latitude: 20.6200855,
        longitude: -103.4256502,
      },
    },
  }
);
assert.equal(e2eFailureShape.location?.latitude, 20.6200855);
assert.equal(e2eFailureShape.location?.longitude, -103.4256502);
assert.equal(e2eFailureShape.location?.city, "Zapopan");

console.log("realestate-adapters-easybroker-location.selftest: ok");
