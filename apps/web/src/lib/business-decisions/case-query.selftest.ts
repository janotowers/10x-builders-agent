import assert from "node:assert/strict";
import {
  formatCaseStatusQueryAnswer,
  formatPricingProposalQueryAnswer,
  looksLikeSideQuestionNotData,
  parseCaseQueryIntent,
} from "./case-query";

// ---- parseCaseQueryIntent: price queries ----------------------------------
assert.equal(
  parseCaseQueryIntent("¿Cuál fue el precio ideal que aprobamos?"),
  "price"
);
assert.equal(parseCaseQueryIntent("qué precio aprobamos"), "price");
assert.equal(parseCaseQueryIntent("cuál es el precio de salida?"), "price");
assert.equal(
  parseCaseQueryIntent("me recuerdas el precio mínimo"),
  "price"
);
assert.equal(parseCaseQueryIntent("¿cuáles fueron los precios?"), "price");

// ---- parseCaseQueryIntent: status queries ----------------------------------
assert.equal(parseCaseQueryIntent("¿Cómo va el caso?"), "status");
assert.equal(parseCaseQueryIntent("como vamos"), "status");
assert.equal(parseCaseQueryIntent("¿en qué paso vamos?"), "status");
assert.equal(parseCaseQueryIntent("estatus del caso"), "status");
assert.equal(parseCaseQueryIntent("¿qué sigue?"), "status");
assert.equal(parseCaseQueryIntent("estado del proceso"), "status");

// ---- parseCaseQueryIntent: decisions/data must never match -----------------
assert.equal(parseCaseQueryIntent("APROBAR PRECIO"), null);
assert.equal(parseCaseQueryIntent("aprobado"), null);
assert.equal(
  parseCaseQueryIntent("AJUSTAR PRECIO salida=23000 ideal=22000"),
  null
);
assert.equal(parseCaseQueryIntent("rechazar precio"), null);
assert.equal(parseCaseQueryIntent("baja el precio de salida"), null);
assert.equal(parseCaseQueryIntent("ok"), null);
assert.equal(parseCaseQueryIntent("sí"), null);
assert.equal(parseCaseQueryIntent("maria@example.com"), null);
assert.equal(
  parseCaseQueryIntent("el precio me parece bien"),
  null,
  "non-interrogative price mention is not a query"
);
assert.equal(
  parseCaseQueryIntent("¿puedes cambiar el precio de salida?"),
  null,
  "change request phrased as question is a decision, not a read-only query"
);
assert.equal(parseCaseQueryIntent(""), null);

// ---- looksLikeSideQuestionNotData ------------------------------------------
assert.equal(
  looksLikeSideQuestionNotData("¿Por qué necesitas el correo del propietario?"),
  true
);
assert.equal(
  looksLikeSideQuestionNotData("¿qué significa exclusiva?"),
  true
);
assert.equal(
  looksLikeSideQuestionNotData("cuál fue el precio ideal que aprobamos?"),
  true
);
// Data replies keep the current claiming behavior:
assert.equal(looksLikeSideQuestionNotData("maria@example.com"), false);
assert.equal(
  looksLikeSideQuestionNotData("sí se comparte comisión 50%"),
  false
);
assert.equal(looksLikeSideQuestionNotData("comisión 5%, exclusiva, 6 meses"), false);
assert.equal(looksLikeSideQuestionNotData("no exclusiva"), false);
assert.equal(
  looksLikeSideQuestionNotData("¿exclusiva? sí"),
  false,
  "question-shaped boolean answer still counts as data"
);
assert.equal(
  looksLikeSideQuestionNotData("¿por qué 5%?"),
  false,
  "digits keep the message claimed (conservative)"
);
assert.equal(looksLikeSideQuestionNotData("dueño@dominio.mx ¿va?"), false);
assert.equal(looksLikeSideQuestionNotData(""), false);

// ---- formatPricingProposalQueryAnswer ---------------------------------------
const pendingAnswer = formatPricingProposalQueryAnswer({
  salida: 2500000,
  ideal: 2300000,
  minimo: 2100000,
  approval_status: "pending",
});
assert.ok(pendingAnswer);
assert.match(pendingAnswer!, /Salida \(publicación\): \$2,500,000/);
assert.match(pendingAnswer!, /Ideal: \$2,300,000/);
assert.match(pendingAnswer!, /Mínimo: \$2,100,000/);
assert.match(pendingAnswer!, /pendientes de aprobación/);

const approvedAnswer = formatPricingProposalQueryAnswer({
  salida: 2500000,
  ideal: 2300000,
  minimo: 2100000,
  approval_status: "approved",
  approved_at: "2026-07-20T18:00:00.000Z",
});
assert.ok(approvedAnswer);
assert.match(approvedAnswer!, /aprobados/);

assert.equal(formatPricingProposalQueryAnswer(null), null);
assert.equal(formatPricingProposalQueryAnswer({}), null);
assert.equal(
  formatPricingProposalQueryAnswer({ salida: 1000, ideal: 0, minimo: 900 }),
  null,
  "incomplete proposal must fall through to the agent"
);

// ---- formatCaseStatusQueryAnswer ---------------------------------------------
const statusAnswer = formatCaseStatusQueryAnswer({
  context: {
    caseId: "case-1",
    caseTitle: "Depto Roma Norte",
    caseStep: "price_proposal_pending",
    caseStepLabel: "Propuesta de precio",
    caseStatus: "active",
    caseStatusLabel: "Activo",
  },
  pendingKinds: ["price_approval", "price_approval"],
});
assert.match(statusAnswer, /«Depto Roma Norte»/);
assert.match(statusAnswer, /Propuesta de precio \(price_proposal_pending\)/);
assert.match(statusAnswer, /Estado: Activo/);
assert.match(statusAnswer, /Pendientes por decidir: Aprobación de precio$/m);

const noPendingAnswer = formatCaseStatusQueryAnswer({
  context: {
    caseId: "case-2",
    caseTitle: null,
    caseStep: "published",
    caseStepLabel: null,
    caseStatus: "completed",
    caseStatusLabel: "Completado",
  },
  pendingKinds: [],
});
assert.match(noPendingAnswer, /Pendientes por decidir: ninguno/);
assert.match(noPendingAnswer, /Paso actual: published/);

console.log("case-query.selftest: ok");
