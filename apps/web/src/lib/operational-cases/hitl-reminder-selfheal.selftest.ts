import assert from "node:assert/strict";
import {
  buildToolConfirmationEscalationText,
  hasCaseContextLine,
  notificationMetadataPendingToolCallId,
  shouldRefreshToolConfirmationNotification,
} from "./hitl-reminder-selfheal";

assert.equal(notificationMetadataPendingToolCallId({ pending_tool_call_id: "tc-1" }), "tc-1");
assert.equal(notificationMetadataPendingToolCallId({ pending_tool_call_id: "   " }), null);
assert.equal(notificationMetadataPendingToolCallId({}), null);
assert.equal(notificationMetadataPendingToolCallId(null), null);

assert.equal(
  hasCaseContextLine("Tienes 1 aprobación pendiente.\nCaso: Propiedad en Zapopan"),
  true
);
assert.equal(hasCaseContextLine("Tienes 1 aprobación pendiente."), false);

assert.equal(
  shouldRefreshToolConfirmationNotification({
    kind: "tool_confirmation_pending",
    body: "Tienes 1 aprobación pendiente.",
    metadata: { pending_tool_call_id: "tc-1" },
    pendingToolCallId: "tc-1",
  }),
  true,
  "generic body without case context should refresh"
);

assert.equal(
  shouldRefreshToolConfirmationNotification({
    kind: "tool_confirmation_pending",
    body: "Tienes 1 aprobación pendiente.\nCaso: Propiedad en Zapopan",
    metadata: { pending_tool_call_id: "tc-old" },
    pendingToolCallId: "tc-new",
  }),
  true,
  "mismatched tool call id should refresh"
);

assert.equal(
  shouldRefreshToolConfirmationNotification({
    kind: "tool_confirmation_pending",
    body: "Tienes 1 aprobación pendiente.\nCaso: Propiedad en Zapopan",
    metadata: { pending_tool_call_id: "tc-1" },
    pendingToolCallId: "tc-1",
  }),
  false,
  "already contextualized notification should not refresh"
);

assert.equal(
  shouldRefreshToolConfirmationNotification({
    kind: "price_approval",
    body: "Aprobación de precio",
    metadata: { pending_tool_call_id: "tc-1" },
    pendingToolCallId: "tc-1",
  }),
  false,
  "only tool_confirmation_pending should self-heal"
);

assert.equal(
  buildToolConfirmationEscalationText({
    title: "Aprobación del agente pendiente",
    body: "Caso: Propiedad en Zapopan",
  }),
  "Escalación: sigue pendiente «Aprobación del agente pendiente».\n\nCaso: Propiedad en Zapopan"
);

console.log("hitl-reminder-selfheal.selftest.ts: ok");
