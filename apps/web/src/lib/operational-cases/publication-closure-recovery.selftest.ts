import assert from "node:assert/strict";
import { shouldSendCorrectiveListingPublishedSummary } from "./publication-closure-recovery";

assert.equal(shouldSendCorrectiveListingPublishedSummary([]), false);

assert.equal(
  shouldSendCorrectiveListingPublishedSummary([
    { payload_jsonb: { kind: "listing_published_summary_sent" } },
  ]),
  false
);

assert.equal(
  shouldSendCorrectiveListingPublishedSummary([
    { payload_jsonb: { kind: "publication_closure_reopened" } },
  ]),
  true
);

assert.equal(
  shouldSendCorrectiveListingPublishedSummary([
    { payload_jsonb: { kind: "publication_closure_reopened" } },
    { payload_jsonb: { kind: "listing_published_summary_resent" } },
  ]),
  false
);

console.log("publication-closure-recovery.selftest: ok");
