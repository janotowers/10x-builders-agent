import assert from "node:assert/strict";
import { parseTitularidadReviewDecision } from "./titularidad-review";

assert.equal(
  parseTitularidadReviewDecision("solicitar evidencia al propietario").intent,
  "request_external_evidence"
);
assert.equal(
  parseTitularidadReviewDecision("yo subiré documentos").intent,
  "request_internal_docs"
);
assert.equal(
  parseTitularidadReviewDecision("pedir documentos").intent,
  "request_internal_docs"
);
assert.equal(
  parseTitularidadReviewDecision("continuar bajo excepción").intent,
  "continue_override"
);
assert.equal(
  parseTitularidadReviewDecision("aprobar titularidad").intent,
  "continue_override"
);
assert.equal(parseTitularidadReviewDecision("hola").intent, "unclear");

assert.equal(
  parseTitularidadReviewDecision(
    "continuar bajo excepción: revisé INE y escritura"
  ).intent,
  "continue_override"
);

console.log("titularidad-review.selftest: ok");
