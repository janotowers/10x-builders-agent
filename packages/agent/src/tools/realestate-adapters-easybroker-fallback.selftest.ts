import assert from "node:assert/strict";
import {
  buildEasyBrokerMlsToolResponse,
  resolveComparableSearchAttemptTrace,
} from "./realestate-adapters";

const exhaustedTrace = resolveComparableSearchAttemptTrace({
  strictFilters: { zona: "Las Fuentes", min_area_m2: 124, max_area_m2: 270 },
  attempts: [
    {
      level: "strict",
      reason: "canonical_strict",
      filters: { zona: "Las Fuentes", min_area_m2: 124, max_area_m2: 270 },
      count: 0,
      ok: true,
    },
    {
      level: "expanded",
      reason: "expand_area_band",
      filters: { zona: "Las Fuentes", min_area_m2: 117, max_area_m2: 307 },
      count: 0,
      ok: true,
    },
    {
      level: "wide",
      reason: "expand_area_band_wide",
      filters: { zona: "Las Fuentes", min_area_m2: 109, max_area_m2: 350 },
      count: 0,
      ok: true,
    },
    {
      level: "location_only",
      reason: "location_operation_and_type_only",
      filters: { zona: "Las Fuentes", property_type: "Casa", operation: "sale" },
      count: 0,
      ok: true,
    },
  ],
  appliedFallbackLevel: null,
});
assert.equal(exhaustedTrace.search_attempts.exhausted, true);
assert.equal(exhaustedTrace.search_attempts.last_attempt_level, "location_only");
assert.equal(exhaustedTrace.search_attempts.applied_level, null);
assert.equal(
  (exhaustedTrace.filters_used as { min_area_m2?: number }).min_area_m2,
  undefined
);
assert.equal((exhaustedTrace.filters_used as { zona?: string }).zona, "Las Fuentes");

const successTrace = resolveComparableSearchAttemptTrace({
  strictFilters: { zona: "Las Fuentes", min_area_m2: 124, max_area_m2: 270 },
  attempts: [
    {
      level: "strict",
      reason: "canonical_strict",
      filters: { zona: "Las Fuentes", min_area_m2: 124, max_area_m2: 270 },
      count: 0,
      ok: true,
    },
    {
      level: "expanded",
      reason: "expand_area_band",
      filters: { zona: "Las Fuentes", min_area_m2: 117, max_area_m2: 307 },
      count: 3,
      ok: true,
    },
  ],
  appliedFallbackLevel: "expanded",
});
assert.equal(successTrace.search_attempts.exhausted, false);
assert.equal(successTrace.search_attempts.applied_level, "expanded");
assert.equal((successTrace.filters_used as { min_area_m2?: number }).min_area_m2, 117);

const unverifiedClosed = buildEasyBrokerMlsToolResponse(
  "easybroker_search_closed_deals",
  { zona: "Las Fuentes", property_type: "Casa", operation: "sale" },
  {
    ok: false,
    error: "status_filter_not_applied",
    result: {
      ok: false,
      count: 5,
      results: [{ id: "A1", price: 1_000_000, property_type: "Casa" }],
      status_filter: {
        requested: true,
        applied: false,
        verified: false,
        selected_label: null,
      },
    },
    metrics: [
      {
        step: "apply_status_filter",
        ok: false,
        requested: true,
        applied: false,
        verified: false,
      },
    ],
  },
  "",
  "account"
);
assert.equal(unverifiedClosed.ok, false);
assert.equal(unverifiedClosed.status, "filter_not_applied");
assert.equal(unverifiedClosed.count, 0);
assert.deepEqual(unverifiedClosed.results, []);
assert.equal(unverifiedClosed.historical_status_filter_unverified, true);

const verifiedClosedEmpty = buildEasyBrokerMlsToolResponse(
  "easybroker_search_closed_deals",
  { zona: "Las Fuentes", property_type: "Casa", operation: "sale" },
  {
    ok: true,
    result: {
      ok: true,
      count: 0,
      results: [],
      status_filter: {
        requested: true,
        applied: true,
        verified: true,
        selected_label: "Solo cerradas",
      },
    },
    metrics: [
      {
        step: "apply_status_filter",
        ok: true,
        requested: true,
        applied: true,
        verified: true,
        selected_label: "Solo cerradas",
      },
    ],
  },
  "",
  "account"
);
assert.equal(verifiedClosedEmpty.ok, true);
assert.equal(verifiedClosedEmpty.status, "success");
assert.equal(verifiedClosedEmpty.count, 0);
assert.match(String(verifiedClosedEmpty.caveat), /Solo cerradas verificado/);

const listingsHouseMatch = buildEasyBrokerMlsToolResponse(
  "easybroker_search_listings",
  { zona: "Las Fuentes", property_type: "house", operation: "sale" },
  {
    ok: true,
    result: {
      ok: true,
      results: [
        {
          id: "A1",
          title: "Casa en venta",
          property_type: "Casa",
          operation: "sale",
          price: 3_000_000,
          area_m2: 140,
          location: "Las Fuentes, Zapopan",
        },
      ],
    },
    metrics: [],
  },
  "",
  "account"
);
assert.equal(listingsHouseMatch.count, 1);
assert.equal((listingsHouseMatch.results as Array<{ id: string }>)[0]?.id, "A1");

console.log("realestate-adapters-easybroker-fallback.selftest: ok");
