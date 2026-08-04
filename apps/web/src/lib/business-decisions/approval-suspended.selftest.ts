/**
 * Selftests del parser de decisiones sobre aprobaciones suspendidas
 * (Slice 3.3-2).
 *
 * El contrato clave es la NO-colisión con el gate de price_approval: los
 * verbos de este parser son explícitos (re-aprobar / revocar) y un "aprobar"
 * simple debe quedar unclear aquí (le pertenece al parser de precio), y a la
 * inversa: "re-aprobar" no debe activar el approve del parser de precio.
 */
import assert from "node:assert/strict";
import { parseApprovalSuspendedDecision } from "./approval-suspended";
import { parsePriceApprovalDecision } from "./price-approval";

function run(): void {
  // Re-aprobación: variantes aceptadas.
  for (const text of [
    "re-aprobar",
    "RE-APROBAR",
    "reaprobar",
    "re-apruebo",
    "reapruebo",
    "aprobar de nuevo",
    "confirmar aprobación",
    "confirmar la aprobacion",
    "reconfirmar",
    "re-aprobar con la base nueva",
  ]) {
    assert.equal(
      parseApprovalSuspendedDecision(text).intent,
      "reapprove",
      `"${text}" debe parsear como reapprove`
    );
  }

  // Revocación: variantes aceptadas.
  for (const text of ["revocar", "REVOCAR", "revoco", "retirar la aprobación", "retirar aprobacion"]) {
    assert.equal(
      parseApprovalSuspendedDecision(text).intent,
      "revoke",
      `"${text}" debe parsear como revoke`
    );
  }

  // No-colisión: "aprobar" simple pertenece al gate de precio.
  for (const text of ["aprobar", "aprobar precio", "apruebo", "ok", "sí"]) {
    assert.equal(
      parseApprovalSuspendedDecision(text).intent,
      "unclear",
      `"${text}" NO debe reclamarse como decisión de aprobación suspendida`
    );
  }

  // No-colisión inversa: los verbos explícitos no activan el approve de precio.
  for (const text of ["re-aprobar", "revocar", "retirar la aprobación"]) {
    const parsed = parsePriceApprovalDecision(text);
    assert.notEqual(
      parsed.intent,
      "approve",
      `"${text}" no debe aprobar precio`
    );
  }

  // Vacío y texto libre → unclear con guía.
  assert.equal(parseApprovalSuspendedDecision("").intent, "unclear");
  const unclear = parseApprovalSuspendedDecision("qué cambió exactamente?");
  assert.equal(unclear.intent, "unclear");
  assert.ok(unclear.reason && unclear.reason.includes("RE-APROBAR"));

  console.log("approval-suspended.selftest: OK");
}

run();
