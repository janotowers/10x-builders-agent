import assert from "node:assert/strict";
import {
  buildComparableSearchFilters,
  classifyComparableSearchOutcome,
  deriveComparableAreaBand,
  requiresAvaclick,
  sanitizeComparableSearchFilters,
} from "./comparable-search-contract";

const propertyData = {
  property_type: "Casa",
  operation: "sale",
  property_zone: "Las Fuentes, Zapopan, Jalisco",
  area_construida_m2: 146,
  area_total_m2: 138,
  bedrooms: 2,
  bathrooms: 2,
};

const areaBand = deriveComparableAreaBand({ propertyData });
assert.ok(areaBand, "area band debe existir");
assert.equal(areaBand?.area_basis, "constructed");
assert.equal(areaBand?.min_area_m2, 124);
assert.equal(areaBand?.max_area_m2, 270);

assert.equal(requiresAvaclick(propertyData), true);
assert.equal(
  requiresAvaclick({ property_type: "Terreno industrial" }),
  false
);

const canonical = buildComparableSearchFilters({ context: propertyData });
assert.equal(canonical.search_validity, "valid");
assert.equal(canonical.filters.zona, "Las Fuentes, Zapopan, Jalisco");
assert.equal(canonical.filters.operation, "sale");
assert.equal(canonical.filters.property_type, "Casa");
assert.equal(canonical.filters.min_area_m2, 124);
assert.equal(canonical.filters.max_area_m2, 270);
assert.equal(canonical.filters.min_bedrooms, undefined);
assert.equal(canonical.filters.min_bathrooms, undefined);

const sanitizedInvalid = sanitizeComparableSearchFilters({
  raw: {
    zona: "Las Fuentes",
    operation: "sale",
    property_type: "Casa",
    min_area_m2: 0,
    max_area_m2: 0,
    min_price: 0,
    max_price: 0,
    parking_spaces: 0,
  },
  propertyData,
});
assert.equal(sanitizedInvalid.search_validity, "valid");
assert.equal(sanitizedInvalid.filters.min_area_m2, 124);
assert.equal(sanitizedInvalid.filters.max_area_m2, 270);
assert.equal(sanitizedInvalid.filters.min_price, undefined);
assert.equal(sanitizedInvalid.filters.max_price, undefined);
assert.equal(sanitizedInvalid.filters.min_parking_spaces, undefined);
assert.equal(sanitizedInvalid.fallback_filters?.min_area_m2, 117);
assert.equal(sanitizedInvalid.fallback_filters?.max_area_m2, 307);

const sanitizedRangeInvalid = sanitizeComparableSearchFilters({
  raw: {
    zona: "Las Fuentes",
    operation: "sale",
    property_type: "Casa",
    min_area_m2: 180,
    max_area_m2: 150,
  },
  propertyData,
});
assert.equal(sanitizedRangeInvalid.search_validity, "invalid_filters");
assert.ok(sanitizedRangeInvalid.invalid_fields.includes("min_area_m2"));
assert.ok(sanitizedRangeInvalid.invalid_fields.includes("max_area_m2"));

const sanitizedOutOfBandRange = sanitizeComparableSearchFilters({
  raw: {
    zona: "Las Fuentes",
    operation: "sale",
    property_type: "Casa",
    min_area_m2: 60,
    max_area_m2: 90,
  },
  propertyData,
});
assert.equal(sanitizedOutOfBandRange.search_validity, "valid");
assert.equal(sanitizedOutOfBandRange.filters.min_area_m2, 124);
assert.equal(sanitizedOutOfBandRange.filters.max_area_m2, 270);
assert.ok(
  sanitizedOutOfBandRange.warnings.some((warning) =>
    warning.includes("Se reemplazo rango de area provisto")
  )
);

const sanitizedInventedPriceCap = sanitizeComparableSearchFilters({
  raw: {
    zona: "Las Fuentes",
    operation: "sale",
    property_type: "Casa",
    max_price: 10_000_000,
  },
  propertyData,
});
assert.equal(sanitizedInventedPriceCap.search_validity, "valid");
assert.equal(sanitizedInventedPriceCap.filters.max_price, undefined);
assert.ok(
  sanitizedInventedPriceCap.warnings.some((warning) =>
    warning.includes("Se descartaron filtros de precio provistos")
  )
);

const sanitizedInBandButNotCanonical = sanitizeComparableSearchFilters({
  raw: {
    zona: "Las Fuentes",
    operation: "sale",
    property_type: "Casa",
    min_area_m2: 96,
    max_area_m2: 176,
  },
  propertyData,
});
assert.equal(sanitizedInBandButNotCanonical.search_validity, "valid");
assert.equal(sanitizedInBandButNotCanonical.filters.min_area_m2, 124);
assert.equal(sanitizedInBandButNotCanonical.filters.max_area_m2, 270);
assert.ok(
  sanitizedInBandButNotCanonical.warnings.some((warning) =>
    warning.includes("banda canonica estricta")
  )
);

const sanitizedWithSoftRooms = sanitizeComparableSearchFilters({
  raw: {
    zona: "Las Fuentes",
    operation: "sale",
    property_type: "Casa",
    min_area_m2: 124,
    max_area_m2: 168,
    bedrooms: 3,
    bathrooms: 2,
    parking_spaces: 2,
  },
  propertyData,
});
assert.equal(sanitizedWithSoftRooms.filters.bedrooms, undefined);
assert.equal(sanitizedWithSoftRooms.filters.bathrooms, undefined);
assert.equal(sanitizedWithSoftRooms.filters.parking_spaces, undefined);
assert.equal(sanitizedWithSoftRooms.filters.min_bedrooms, undefined);
assert.equal(sanitizedWithSoftRooms.filters.min_bathrooms, undefined);
assert.equal(sanitizedWithSoftRooms.filters.min_parking_spaces, undefined);
assert.equal(sanitizedWithSoftRooms.fallback_filter_ladder?.[0]?.level, "expanded");
assert.equal(sanitizedWithSoftRooms.fallback_filter_ladder?.[0]?.filters.min_area_m2, 117);
assert.equal(sanitizedWithSoftRooms.fallback_filter_ladder?.[0]?.filters.max_area_m2, 307);
assert.equal(sanitizedWithSoftRooms.fallback_filter_ladder?.[1]?.level, "wide");
assert.equal(sanitizedWithSoftRooms.fallback_filter_ladder?.[1]?.filters.min_area_m2, 109);
assert.equal(sanitizedWithSoftRooms.fallback_filter_ladder?.[1]?.filters.max_area_m2, 350);
assert.equal(
  sanitizedWithSoftRooms.fallback_filter_ladder?.[2]?.level,
  "location_only"
);
assert.equal(
  sanitizedWithSoftRooms.fallback_filter_ladder?.[2]?.filters.min_area_m2,
  undefined
);
assert.equal(
  sanitizedWithSoftRooms.fallback_filter_ladder?.[2]?.filters.min_bedrooms,
  undefined
);

const propertyDataNoArea = {
  property_type: "Casa",
  operation: "sale",
  property_zone: "Las Fuentes, Zapopan, Jalisco",
  bedrooms: 3,
  bathrooms: 2,
};
const sanitizedNoTrustedArea = sanitizeComparableSearchFilters({
  raw: {
    zona: "Las Fuentes",
    operation: "sale",
    property_type: "Casa",
    min_area_m2: 60,
    max_area_m2: 90,
  },
  propertyData: propertyDataNoArea,
});
assert.equal(sanitizedNoTrustedArea.search_validity, "valid");
assert.equal(sanitizedNoTrustedArea.filters.min_area_m2, undefined);
assert.equal(sanitizedNoTrustedArea.filters.max_area_m2, undefined);
assert.equal(sanitizedNoTrustedArea.filters.area_basis, undefined);
assert.ok(
  sanitizedNoTrustedArea.warnings.some((warning) =>
    warning.includes("Se descartaron filtros de area provistos")
  )
);

const sanitizedNoContext = sanitizeComparableSearchFilters({
  raw: {
    zona: "Las Fuentes",
    operation: "sale",
    property_type: "Casa",
    min_area_m2: 60,
    max_area_m2: 90,
  },
});
assert.equal(sanitizedNoContext.filters.min_area_m2, 60);
assert.equal(sanitizedNoContext.filters.max_area_m2, 90);

assert.equal(
  classifyComparableSearchOutcome({
    usable_count: 0,
    search_validity: "valid",
  }),
  "insufficient_market_data"
);
assert.equal(
  classifyComparableSearchOutcome({
    usable_count: 0,
    search_validity: "invalid_filters",
  }),
  "invalid_filters"
);
assert.equal(
  classifyComparableSearchOutcome({
    usable_count: 0,
    search_validity: "valid",
    missing_required_source: true,
  }),
  "missing_required_source"
);

console.log("comparable-search-contract.selftest: ok");
