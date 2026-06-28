import assert from "node:assert/strict";
import { extractManualBuiltAreaM2FromTextForTest } from "./property-data-review";

assert.equal(extractManualBuiltAreaM2FromTextForTest("146 m2"), 146);
assert.equal(
  extractManualBuiltAreaM2FromTextForTest("La superficie construida correcta es 145.5 m²"),
  145.5
);
assert.equal(
  extractManualBuiltAreaM2FromTextForTest("Corrige area construida: 146"),
  146
);
assert.equal(
  extractManualBuiltAreaM2FromTextForTest("confirmo la informacion, gracias"),
  null
);

console.log("property-data-review.selftest: ok");
