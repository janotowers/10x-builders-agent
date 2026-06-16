import assert from "node:assert/strict";
import {
  pendingActionLinkLabel,
  shouldShowAssociatedActionLink,
} from "./pending-action-display";

function main() {
  assert.equal(
    pendingActionLinkLabel({
      kind: "internal_notification",
      action_url: "/chat/pending?case=abc",
    }),
    "Ir a Pendientes"
  );
  assert.equal(
    pendingActionLinkLabel({
      kind: "internal_notification",
      action_url: "/chat/pending?case=abc&focus=tool-1",
    }),
    "Ir a este pendiente"
  );

  assert.equal(
    shouldShowAssociatedActionLink({
      kind: "internal_notification",
      action_url: "/chat/pending?case=abc",
      caseId: "abc",
      suppressGenericPendingCaseLink: true,
    }),
    false
  );
  assert.equal(
    shouldShowAssociatedActionLink({
      kind: "internal_notification",
      action_url: "/chat/pending?case=abc&focus=tool-1",
      caseId: "abc",
      suppressGenericPendingCaseLink: true,
    }),
    true
  );

  console.log("pending-action-display.selftest.ts: ok");
}

main();
