import assert from "node:assert/strict";
import {
  formatAlreadyAppliedDestinationAck,
  formatPublishDestinationDecisionAck,
  isEasybrokerPublishedInContext,
  parsePublishDestinationApprovalDecision,
  prematurePublishDestinationNotificationKinds,
} from "./publish-destination-approval";

assert.equal(
  formatPublishDestinationDecisionAck({
    destination: "easybroker",
    decision: "approved",
  }),
  "Publicación en EasyBroker aprobada. Sigo con la publicación…"
);
assert.match(
  formatAlreadyAppliedDestinationAck({
    destination: "ungga",
    decision: "approved",
  }),
  /ya estaba aprobada[\s\S]*Reintentar publicación en Ungga/
);
assert.ok(
  formatPublishDestinationDecisionAck({
    destination: "ungga",
    decision: "skipped",
  }).includes("Ungga")
);

assert.equal(parsePublishDestinationApprovalDecision("APROBAR").intent, "approve");
assert.equal(parsePublishDestinationApprovalDecision("OMITIR").intent, "skip");
assert.equal(
  parsePublishDestinationApprovalDecision("No publicar aquí").intent,
  "skip"
);
assert.equal(
  parsePublishDestinationApprovalDecision("No publicar en EasyBroker").intent,
  "skip"
);
assert.equal(
  parsePublishDestinationApprovalDecision("Omitir EasyBroker").intent,
  "skip"
);
assert.equal(
  parsePublishDestinationApprovalDecision("Publicar en EasyBroker").intent,
  "approve"
);
assert.equal(
  parsePublishDestinationApprovalDecision("Detener y revisar").intent,
  "reject"
);
assert.equal(
  parsePublishDestinationApprovalDecision("Pausar publicación").intent,
  "reject"
);
assert.equal(parsePublishDestinationApprovalDecision("no").intent, "reject");

assert.equal(
  isEasybrokerPublishedInContext({
    published: { easybroker: { listing_id: "EB-1" } },
  }),
  true
);
assert.equal(
  isEasybrokerPublishedInContext({
    published: { easybroker: { ok: true } },
  }),
  true
);
assert.equal(isEasybrokerPublishedInContext({ published: null }), false);

assert.deepEqual(
  prematurePublishDestinationNotificationKinds({
    publish_approvals: { easybroker: "approved" },
  }),
  ["ungga_publish_approval"]
);
assert.deepEqual(
  prematurePublishDestinationNotificationKinds({
    publish_approvals: { easybroker: "approved" },
    published: { easybroker: { listing_id: "EB-1" } },
  }),
  ["ungga_publish_approval"],
  "draft listing_id alone is still premature for Ungga"
);
assert.deepEqual(
  prematurePublishDestinationNotificationKinds({
    publish_approvals: { easybroker: "approved" },
    published: {
      easybroker: { listing_id: "EB-1", status: "published" },
    },
  }),
  [],
  "publicly published EasyBroker clears premature Ungga"
);
assert.deepEqual(
  prematurePublishDestinationNotificationKinds({
    publish_approvals: { easybroker: "skipped" },
  }),
  []
);
assert.deepEqual(
  prematurePublishDestinationNotificationKinds({
    publish_approvals: { easybroker: "rejected" },
  }),
  []
);

console.log("publish-destination-approval.selftest: ok");
