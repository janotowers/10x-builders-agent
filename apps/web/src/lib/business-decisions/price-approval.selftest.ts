import assert from "node:assert/strict";
import { businessDecisionHandler } from "./registry";
import { parsePriceApprovalDecision } from "./price-approval";

assert.equal(businessDecisionHandler("price_approval").notificationKind, "price_approval");

assert.deepEqual(parsePriceApprovalDecision("APROBAR PRECIO"), {
  intent: "approve",
});

assert.deepEqual(parsePriceApprovalDecision("salida 24 ideal 22.5 minimo 19"), {
  intent: "adjust",
  patch: {
    salida: 24000,
    ideal: 22500,
    minimo: 19000,
  },
});

assert.equal(parsePriceApprovalDecision("ajustar precio").intent, "unclear");
assert.equal(parsePriceApprovalDecision("no entiendo").intent, "unclear");

console.log("price approval decision selftest passed");
