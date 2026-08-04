import assert from "node:assert/strict";
import { businessDecisionHandler } from "./registry";
import {
  detectPriceApprovalAmountMismatch,
  extractApprovalAmount,
  parsePriceApprovalDecision,
} from "./price-approval";
import {
  appendResidualAcknowledgment,
  residualFromRemainder,
} from "./residual-intent";

assert.equal(businessDecisionHandler("price_approval").notificationKind, "price_approval");

assert.deepEqual(parsePriceApprovalDecision("APROBAR PRECIO"), {
  intent: "approve",
  approvalAmount: null,
  residual: null,
});

assert.equal(parsePriceApprovalDecision("sí").intent, "approve");
assert.equal(parsePriceApprovalDecision("sí apruebo").intent, "approve");
assert.equal(
  parsePriceApprovalDecision("sí apruebo").residual,
  null,
  "restating approve after sí must not yield residual"
);
assert.equal(parsePriceApprovalDecision("si apruebo el precio").intent, "approve");
assert.equal(parsePriceApprovalDecision("si apruebo el precio").residual, null);

assert.deepEqual(parsePriceApprovalDecision("salida 24 ideal 22.5 minimo 19"), {
  intent: "adjust",
  patch: {
    salida: 24000,
    ideal: 22500,
    minimo: 19000,
  },
  residual: null,
});

assert.equal(parsePriceApprovalDecision("ajustar precio").intent, "unclear");
assert.equal(parsePriceApprovalDecision("no entiendo").intent, "unclear");

// ── Slice 0.1: residual-intent preservation ─────────────────────────────────

// Single-intent approval: no residual.
assert.equal(parsePriceApprovalDecision("Aprobar").residual, null);
assert.equal(
  parsePriceApprovalDecision("Apruebo el precio propuesto").residual,
  null,
  "propuesto reitera el objeto; no es residual"
);

// Mixed-intent approval: the unmatched remainder is preserved verbatim-ish.
{
  const parsed = parsePriceApprovalDecision(
    "Aprobar precio y agenda una visita con el dueño mañana"
  );
  assert.equal(parsed.intent, "approve");
  const residual = residualFromRemainder(parsed.residual);
  assert.ok(residual, "mixed-intent approval must yield residual");
  assert.equal(residual.text, "agenda una visita con el dueño mañana");
  assert.equal(residual.reason, "unparsed_remainder");
  const message = appendResidualAcknowledgment("Precio aprobado.", residual);
  assert.ok(
    message.includes("No actué sobre: “agenda una visita con el dueño mañana”"),
    "acknowledgment line must be appended"
  );
}

// Mixed-intent adjust: fields + verb consumed, the rest is residual.
{
  const parsed = parsePriceApprovalDecision(
    "AJUSTAR PRECIO salida=23000 y avísale al notario"
  );
  assert.equal(parsed.intent, "adjust");
  assert.equal(parsed.patch?.salida, 23000);
  const residual = residualFromRemainder(parsed.residual);
  assert.ok(residual, "mixed-intent adjust must yield residual");
  assert.equal(residual.text, "avísale al notario");
}

// Single-intent adjust: no residual after removing consumed segments.
{
  const parsed = parsePriceApprovalDecision("AJUSTAR PRECIO salida=23000");
  assert.equal(parsed.intent, "adjust");
  assert.equal(residualFromRemainder(parsed.residual), null);
}

// Reject consumes the remainder as rejection reason: no residual.
{
  const parsed = parsePriceApprovalDecision("Rechazar, el precio está muy alto");
  assert.equal(parsed.intent, "reject");
  assert.equal(parsed.residual, null);
}

// No acknowledgment line without residual.
assert.equal(appendResidualAcknowledgment("Listo.", null), "Listo.");

// ── Slice 0.2: price-approval amount binding ────────────────────────────────

// Amount extraction forms.
assert.deepEqual(extractApprovalAmount(" $4.8 millones")?.candidates, [4_800_000]);
assert.deepEqual(extractApprovalAmount(" 5,200,000")?.candidates?.[0], 5_200_000);
assert.deepEqual(extractApprovalAmount(" 3.5 mdp")?.candidates, [3_500_000]);
assert.deepEqual(extractApprovalAmount(" 500 mil")?.candidates, [500_000]);
assert.equal(extractApprovalAmount("sin monto aquí"), null);

// "Aprobar $4.8 millones" parses as approval naming 4.8M, amount consumed.
{
  const parsed = parsePriceApprovalDecision("Aprobar $4.8 millones");
  assert.equal(parsed.intent, "approve");
  assert.equal(parsed.approvalAmount, 4_800_000);
  assert.equal(residualFromRemainder(parsed.residual), null);
}

const proposal = { salida: 5_200_000, ideal: 4_950_000, minimo: 4_500_000 };

// Mismatching amount ⇒ clarification path (mismatch=true), never approval.
{
  const parsed = parsePriceApprovalDecision("Aprobar $4.8 millones");
  const check = detectPriceApprovalAmountMismatch({
    approvalAmountCandidates: parsed.approvalAmountCandidates,
    proposal,
  });
  assert.equal(check.mismatch, true);
  assert.equal(check.namedAmount, 4_800_000);
  assert.equal(check.salida, 5_200_000);
}

// Bare approval (no amount) approves as today.
{
  const parsed = parsePriceApprovalDecision("Aprobar");
  const check = detectPriceApprovalAmountMismatch({
    approvalAmountCandidates: parsed.approvalAmountCandidates,
    proposal,
  });
  assert.equal(check.mismatch, false);
}

// Matching amount (salida) approves.
{
  const parsed = parsePriceApprovalDecision("Aprobar $5.2 millones");
  const check = detectPriceApprovalAmountMismatch({
    approvalAmountCandidates: parsed.approvalAmountCandidates,
    proposal,
  });
  assert.equal(check.mismatch, false);
}

// Matching amount (ideal) also approves.
{
  const parsed = parsePriceApprovalDecision("Aprobar 4,950,000");
  const check = detectPriceApprovalAmountMismatch({
    approvalAmountCandidates: parsed.approvalAmountCandidates,
    proposal,
  });
  assert.equal(check.mismatch, false);
}

// Unitless value scales are considered exactly ("aprobar 5200" ⇒ 5,200,000? no —
// candidates are 5200 | 5,200,000; 5,200,000 matches salida).
{
  const parsed = parsePriceApprovalDecision("Aprobar 5.2");
  const check = detectPriceApprovalAmountMismatch({
    approvalAmountCandidates: parsed.approvalAmountCandidates,
    proposal,
  });
  assert.equal(check.mismatch, false);
}

console.log("price approval decision selftest passed");
