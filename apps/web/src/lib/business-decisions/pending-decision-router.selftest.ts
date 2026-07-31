import assert from "node:assert/strict";
import { isActionableContractReviewNotification } from "./pending-decision-router";
import { parseContractReviewDecision } from "./contract-review";
import { parseTitularidadReviewDecision } from "./titularidad-review";
import { computeComparablesExpansionResidual } from "./comparables-expansion-decision";
import {
  appendResidualAcknowledgment,
  cleanResidualRemainder,
  removeConsumedSegments,
  residualFromRemainder,
} from "./residual-intent";

// contract_review is always actionable.
assert.equal(
  isActionableContractReviewNotification({ kind: "contract_review" }),
  true
);

// contract_pending only counts when no required fields are missing.
assert.equal(
  isActionableContractReviewNotification({
    kind: "contract_pending",
    metadata_jsonb: { missing_required_fields: [] },
  }),
  true
);
assert.equal(
  isActionableContractReviewNotification({
    kind: "contract_pending",
    metadata_jsonb: {},
  }),
  true
);
assert.equal(
  isActionableContractReviewNotification({
    kind: "contract_pending",
    metadata_jsonb: { missing_required_fields: ["owner_email"] },
  }),
  false
);

// Other kinds never claim the contract gate.
assert.equal(
  isActionableContractReviewNotification({ kind: "price_approval" }),
  false
);
assert.equal(
  isActionableContractReviewNotification({
    kind: "contract_data_review",
    metadata_jsonb: { missing_required_fields: [] },
  }),
  false
);

// ── Slice 0.1: residual-intent preservation ─────────────────────────────────

// Remainder cleaning: connectors/punctuation-only remainders vanish.
assert.equal(cleanResidualRemainder("  y, "), "");
assert.equal(cleanResidualRemainder(" y además llama al notario."), "llama al notario");
assert.equal(residualFromRemainder(null), null);
assert.equal(residualFromRemainder("   .  "), null);

// Segment removal keeps unconsumed text in order.
assert.equal(
  removeConsumedSegments("abc def ghi", [{ index: 4, length: 4 }]).trim().replace(/\s+/g, " "),
  "abc ghi"
);

// Fixed-format acknowledgment line.
assert.equal(
  appendResidualAcknowledgment("Listo.", { text: "agenda una visita", reason: "unparsed_remainder" }),
  "Listo.\n\nNo actué sobre: “agenda una visita”"
);
assert.equal(appendResidualAcknowledgment("Listo.", null), "Listo.");

// Contract review: mixed intent yields residual; single intent does not.
{
  const mixed = parseContractReviewDecision(
    "Enviar por email y además baja el precio de salida"
  );
  assert.equal(mixed.intent, "approve_send");
  const residual = residualFromRemainder(mixed.residual);
  assert.ok(residual, "mixed contract decision must yield residual");
  assert.equal(residual.text, "baja el precio de salida");

  const single = parseContractReviewDecision("enviar por email");
  assert.equal(single.intent, "approve_send");
  assert.equal(residualFromRemainder(single.residual), null);

  // request_changes consumes the whole text as change notes.
  const changes = parseContractReviewDecision(
    "necesita cambios en la comisión y en la vigencia"
  );
  assert.equal(changes.intent, "request_changes");
  assert.equal(changes.residual, null);
}

// Titularidad review: decision phrase consumed, remainder preserved.
{
  const mixed = parseTitularidadReviewDecision(
    "aprobar titularidad y avísame cuando esté el contrato"
  );
  assert.equal(mixed.intent, "approve_override");
  const residual = residualFromRemainder(mixed.residual);
  assert.ok(residual, "mixed titularidad decision must yield residual");
  assert.equal(residual.text, "avísame cuando esté el contrato");

  const single = parseTitularidadReviewDecision("aprobar titularidad");
  assert.equal(single.intent, "approve_override");
  assert.equal(residualFromRemainder(single.residual), null);
}

// Comparables expansion: numeric prefix consumed, remainder preserved.
assert.equal(
  residualFromRemainder(
    computeComparablesExpansionResidual("3 y avísame cuando tengas los nuevos")
  )?.text,
  "avísame cuando tengas los nuevos"
);
assert.equal(computeComparablesExpansionResidual("ampliar"), null);
assert.equal(computeComparablesExpansionResidual("no entiendo"), null);
assert.equal(
  computeComparablesExpansionResidual("2, avanza usando Avaclick"),
  null,
  "restating the same Avaclick decision must not yield residual"
);

// Scenario-B style fixture: composed message carries the acknowledgment.
{
  const parsed = parseContractReviewDecision(
    "Mándalo al dueño y agenda una llamada con él el viernes"
  );
  const residual = residualFromRemainder(parsed.residual);
  const message = appendResidualAcknowledgment(
    "Listo: envié el contrato por email al propietario.",
    residual
  );
  assert.ok(message.includes("No actué sobre: “"));
  assert.ok(message.includes("agenda una llamada con él el viernes"));
}

console.log("pending-decision-router.selftest: ok");
