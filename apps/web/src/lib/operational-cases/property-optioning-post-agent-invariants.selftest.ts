import assert from "node:assert/strict";
import { mergeDocumentSurfacesIntoContextPropertyData } from "./property-optioning-post-agent-invariants";

{
  const result = mergeDocumentSurfacesIntoContextPropertyData({
    context: {
      property_data: {
        bedrooms: 3,
      },
    },
    documentFields: {
      area_total_m2: 138,
      area_total_m2_source: "predial",
      area_construida_m2: 146,
      area_construida_m2_source: "predial",
    },
  });
  assert.equal(result.changed, true);
  assert.equal(result.context.property_data?.area_total_m2, 138);
  assert.equal(result.context.property_data?.area_construida_m2, 146);
  assert.equal(result.context.property_data?.area_construida_m2_source, "predial");
}

{
  const result = mergeDocumentSurfacesIntoContextPropertyData({
    context: {
      property_data: {
        area_construida_m2: 90,
        area_construida_m2_source: "escritura",
      },
    },
    documentFields: {
      area_construida_m2: 146,
      area_construida_m2_source: "predial",
    },
  });
  assert.equal(result.changed, true);
  assert.equal(result.context.property_data?.area_construida_m2, 146);
  assert.equal(result.context.property_data?.area_construida_m2_source, "predial");
}

{
  const result = mergeDocumentSurfacesIntoContextPropertyData({
    context: {
      property_data: {
        area_construida_m2: 146,
        area_construida_m2_source: "predial",
      },
    },
    documentFields: {
      area_construida_m2: 120,
      area_construida_m2_source: "escritura",
    },
  });
  assert.equal(result.changed, false);
  assert.equal(result.context.property_data?.area_construida_m2, 146);
}

{
  const result = mergeDocumentSurfacesIntoContextPropertyData({
    context: { property_data: { floors: 2 } },
    documentFields: {},
  });
  assert.equal(result.changed, false);
  assert.equal(result.context.property_data?.floors, 2);
}

console.log("property-optioning-post-agent-invariants.selftest: ok");
