import assert from "node:assert/strict";
import { extractSurfaceTotalM2FromTextForTest } from "./operational-cases-adapters";

assert.equal(
  extractSurfaceTotalM2FromTextForTest(
    "la cual cuenta con una superficie total de 116.93 ciento dieciseis punto noventa y tres metros cuadrados"
  ),
  116.93
);

assert.equal(
  extractSurfaceTotalM2FromTextForTest(
    "la cual cuenta con una superficie total de I16.93 ciento dieciseis punto noventa y tres metros cuadrados"
  ),
  116.93
);

assert.equal(
  extractSurfaceTotalM2FromTextForTest(
    "la unidad privativa cuenta con una superficie total de ciento dieciseis punto noventa y tres metros cuadrados"
  ),
  116.93
);

console.log("operational-cases-adapters selftest ok");
