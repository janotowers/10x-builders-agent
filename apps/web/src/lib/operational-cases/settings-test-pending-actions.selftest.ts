import assert from "node:assert/strict";
import {
  partitionSettingsTestPendingActions,
  type SettingsTestPendingAction,
} from "./settings-test-pending-actions";

const NOW = "2026-06-16T09:47:00.000Z";

function pendingToolAction(
  overrides: Partial<Extract<SettingsTestPendingAction, { kind: "tool_confirmation" }>> = {}
): Extract<SettingsTestPendingAction, { kind: "tool_confirmation" }> {
  return {
    id: "tool:tc-1",
    kind: "tool_confirmation",
    label: "telegram_send_message_to_contact",
    status: "pending_confirmation",
    created_at: NOW,
    tool_call_id: "tc-1",
    tool_name: "telegram_send_message_to_contact",
    session_id: "session-1",
    case_id: "case-1",
    channel: "chat_or_telegram",
    recommended_channel: "chat_or_telegram",
    blocking: false,
    args_preview: {},
    ...overrides,
  };
}

function pendingNotificationAction(
  overrides: Partial<Extract<SettingsTestPendingAction, { kind: "internal_notification" }>> = {}
): Extract<SettingsTestPendingAction, { kind: "internal_notification" }> {
  return {
    id: "notification:n-1",
    kind: "internal_notification",
    label: "Aprobación del agente pendiente",
    status: "unread",
    created_at: NOW,
    notification_id: "n-1",
    notification_kind: "tool_confirmation_pending",
    case_id: "case-1",
    channel: "pending_inbox",
    recommended_channel: "pending_inbox",
    blocking: false,
    body: "Tienes 1 aprobación del agente pendiente para continuar este caso.",
    action_url: "/chat/pending?case=case-1",
    pending_tool_call_id: "tc-1",
    ...overrides,
  };
}

function main() {
  const realCaseResult = partitionSettingsTestPendingActions({
    actions: [pendingNotificationAction(), pendingToolAction()],
    lastTransitionAt: null,
    caseRunnerSessionIds: new Set(["session-1"]),
  });
  assert.equal(realCaseResult.blockingActions.length, 1);
  assert.equal(realCaseResult.blockingActions[0]?.kind, "tool_confirmation");
  assert.equal(realCaseResult.historicalActions.length, 1);
  assert.equal(realCaseResult.historicalActions[0]?.kind, "internal_notification");

  const withTransition = partitionSettingsTestPendingActions({
    actions: [
      pendingNotificationAction({
        id: "notification:n-2",
        notification_id: "n-2",
        notification_kind: "price_approval",
        created_at: "2026-06-16T10:30:00.000Z",
      }),
    ],
    lastTransitionAt: "2026-06-16T10:00:00.000Z",
    caseRunnerSessionIds: new Set(["session-1"]),
  });
  assert.equal(withTransition.blockingActions.length, 1);
  assert.equal(withTransition.blockingActions[0]?.kind, "internal_notification");
  assert.equal(withTransition.blockingActions[0]?.blocking, true);

  const informationalNotification = partitionSettingsTestPendingActions({
    actions: [
      pendingNotificationAction({
        id: "notification:n-3",
        notification_id: "n-3",
        notification_kind: "comparables_insufficient_data",
        created_at: "2026-06-16T10:30:00.000Z",
      }),
    ],
    lastTransitionAt: "2026-06-16T10:00:00.000Z",
    caseRunnerSessionIds: new Set(["session-1"]),
  });
  assert.equal(informationalNotification.blockingActions.length, 0);
  assert.equal(informationalNotification.historicalActions.length, 1);
  assert.equal(informationalNotification.historicalActions[0]?.blocking, false);

  const photosUploadRequested = partitionSettingsTestPendingActions({
    actions: [
      pendingNotificationAction({
        id: "notification:n-photos",
        notification_id: "n-photos",
        notification_kind: "photos_upload_requested",
        created_at: "2026-06-16T10:30:00.000Z",
      }),
    ],
    lastTransitionAt: "2026-06-16T10:00:00.000Z",
    caseRunnerSessionIds: new Set(["session-1"]),
  });
  assert.equal(photosUploadRequested.blockingActions.length, 0);
  assert.equal(photosUploadRequested.historicalActions.length, 1);

  const expansionDecisionNotification = partitionSettingsTestPendingActions({
    actions: [
      pendingNotificationAction({
        id: "notification:n-4",
        notification_id: "n-4",
        notification_kind: "comparables_search_expansion_decision",
        created_at: "2026-06-16T10:30:00.000Z",
      }),
    ],
    lastTransitionAt: "2026-06-16T10:00:00.000Z",
    caseRunnerSessionIds: new Set(["session-1"]),
  });
  assert.equal(expansionDecisionNotification.blockingActions.length, 1);
  assert.equal(expansionDecisionNotification.blockingActions[0]?.blocking, true);
  const expansionBlockingAction = expansionDecisionNotification.blockingActions[0] as
    | Extract<SettingsTestPendingAction, { kind: "internal_notification" }>
    | undefined;
  assert.equal(
    expansionBlockingAction?.notification_kind,
    "comparables_search_expansion_decision"
  );

  console.log("settings-test-pending-actions.selftest.ts: ok");
}

main();
