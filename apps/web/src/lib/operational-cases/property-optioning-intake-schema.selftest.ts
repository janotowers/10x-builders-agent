import assert from "node:assert/strict";
import type { OperationalCaseIntakeField } from "@agents/types";
import {
  hydratePropertyOptioningTestContextDraft,
  isPropertyOptioningAreaFieldPair,
} from "./property-optioning-intake-schema";

const schema: OperationalCaseIntakeField[] = [
  { name: "area_total_m2", label: "Total", type: "number", required: false },
  { name: "area_construida_m2", label: "Construida", type: "number", required: false },
];

assert.equal(isPropertyOptioningAreaFieldPair(schema, 0), true);
assert.equal(isPropertyOptioningAreaFieldPair(schema, 1), false);

const draft = hydratePropertyOptioningTestContextDraft(schema, {
  area_m2: 450,
  property_data: { area_total_m2: 116.93 },
});
assert.equal(draft.area_construida_m2, "450");
assert.equal(draft.area_total_m2, "116.93");

console.log("property-optioning-intake-schema.selftest: ok");
