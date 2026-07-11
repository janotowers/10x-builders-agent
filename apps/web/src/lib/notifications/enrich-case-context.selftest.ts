import assert from "node:assert/strict";
import { formatPendingCaseContextLine } from "./enrich-case-context";

assert.equal(
  formatPendingCaseContextLine({
    caseId: "309c2bab-9eca-4d2d-90c2-3ab4fe6c0b81",
    caseTitle: "Casa",
    caseStep: "package_ready",
    caseStepLabel: "package_ready",
    caseStatus: "waiting_internal",
    caseStatusLabel: "Esperando asesor",
  }),
  "Caso: Casa · ID: 309c2bab-9eca-4d2d-90c2-3ab4fe6c0b81 · Paso: package_ready · Estado: Esperando asesor"
);

assert.equal(
  formatPendingCaseContextLine({
    caseId: null,
    caseTitle: "Sin id",
    caseStep: null,
    caseStepLabel: null,
    caseStatus: null,
    caseStatusLabel: null,
  }),
  "Caso: Sin id"
);

assert.equal(
  formatPendingCaseContextLine({
    caseId: null,
    caseTitle: null,
    caseStep: null,
    caseStepLabel: null,
    caseStatus: null,
    caseStatusLabel: null,
  }),
  null
);

console.log("enrich-case-context.selftest: ok");
