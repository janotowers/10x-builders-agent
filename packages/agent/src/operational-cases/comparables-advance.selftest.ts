import assert from "node:assert/strict";
import {
  priceApprovalEventHasDeliveredNotificationForTest,
  subjectAreaFromCaseContext,
} from "./comparables-advance";

assert.equal(
  priceApprovalEventHasDeliveredNotificationForTest({
    kind: "price_approval_requested",
    notify_delivered: [],
  }),
  false
);

assert.equal(
  priceApprovalEventHasDeliveredNotificationForTest({
    kind: "price_approval_requested",
    notify_delivered: [{ channel: "web", ok: true }],
  }),
  true
);

assert.deepEqual(
  subjectAreaFromCaseContext({
    property_data: {
      area_construida_m2: "146",
      area_total_m2: 138,
    },
  }),
  { area: 146, basis: "construction" }
);

assert.deepEqual(
  subjectAreaFromCaseContext({
    property_data: {
      area_total_m2: "138",
    },
  }),
  { area: 138, basis: "total" }
);

console.log("comparables-advance.selftest: ok");
