import assert from "node:assert/strict";
import {
  computePendingInboxVisibleCounts,
  findHitlLinkedNotifications,
  isHitlShadowNotification,
  listRenderableNotifications,
  buildPendingHitlIndex,
} from "./pending-inbox-dedupe";

function main() {
  const pendingToolConfirmations = [
    { toolCallId: "tc-1", caseId: "case-1" },
  ];
  const notifications = [
    {
      id: "n-hitl",
      kind: "tool_confirmation_pending",
      caseId: "case-1",
      pendingToolCallId: "tc-1",
      due_at: "2020-01-01T00:00:00.000Z",
    },
    {
      id: "n-other",
      kind: "price_approval",
      caseId: "case-2",
      due_at: null,
    },
    {
      id: "n-reminder",
      kind: "internal_notification_reminder",
      caseId: "case-1",
      sourceNotificationId: "n-hitl",
    },
  ];

  const index = buildPendingHitlIndex(pendingToolConfirmations);
  assert.equal(
    isHitlShadowNotification(notifications[0], index),
    true,
    "tool_confirmation_pending should hide when HITL card exists"
  );

  const rendered = listRenderableNotifications(
    notifications,
    pendingToolConfirmations,
    new Set()
  );
  assert.deepEqual(
    rendered.map((notification) => notification.id),
    ["n-other"],
    "only non-shadow actionable notifications render"
  );

  const linked = findHitlLinkedNotifications(
    pendingToolConfirmations[0],
    notifications
  );
  assert.deepEqual(
    linked.map((notification) => notification.id),
    ["n-hitl"]
  );

  const counts = computePendingInboxVisibleCounts(
    notifications,
    pendingToolConfirmations,
    { now: Date.parse("2026-06-16T12:00:00.000Z") }
  );
  assert.equal(counts.actionableNotificationsTotal, 1);
  assert.equal(counts.pendingToolConfirmationsTotal, 1);
  assert.equal(counts.uniquePendingTotal, 2);
  assert.equal(counts.flowRelatedTotal, 2);
  assert.equal(counts.overdueTotal, 1, "overdue HITL shadow counts once");

  const hitlOnlyCounts = computePendingInboxVisibleCounts(
    [notifications[0]],
    pendingToolConfirmations,
    { now: Date.parse("2026-06-16T12:00:00.000Z") }
  );
  assert.equal(hitlOnlyCounts.actionableNotificationsTotal, 0);
  assert.equal(hitlOnlyCounts.uniquePendingTotal, 1);
  assert.equal(hitlOnlyCounts.flowRelatedTotal, 1);

  console.log("pending-inbox-dedupe.selftest.ts: ok");
}

main();
