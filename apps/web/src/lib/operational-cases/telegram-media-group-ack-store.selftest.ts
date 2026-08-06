import assert from "node:assert/strict";
import { __testOnly } from "./telegram-media-group-ack-store";

const nowIso = "2026-06-20T22:28:00.000Z";

const seeded = __testOnly.appendInMap({
  map: {},
  caseId: "case-1",
  chatId: 123,
  mediaGroupId: "grp-1",
  file: { originalName: "A.pdf", kind: "ine" },
  markReady: false,
  nowIso,
});

const appended = __testOnly.appendInMap({
  map: seeded,
  caseId: "case-1",
  chatId: 123,
  mediaGroupId: "grp-1",
  file: { originalName: "B.pdf", kind: "predial" },
  markReady: true,
  nowIso: "2026-06-20T22:28:03.000Z",
});

const key = __testOnly.groupKey(123, "grp-1");
const group = appended[key]!;
assert.equal(group.files.length, 2);
assert.equal(group.mark_ready, true);

assert.equal(
  __testOnly.isFlushable({
    group,
    caseId: "case-1",
    chatId: 123,
    nowMs: Date.parse("2026-06-20T22:28:05.000Z"),
    windowMs: 4_000,
    force: false,
  }),
  false
);
assert.equal(
  __testOnly.isFlushable({
    group,
    caseId: "case-1",
    chatId: 123,
    nowMs: Date.parse("2026-06-20T22:28:08.000Z"),
    windowMs: 4_000,
    force: false,
  }),
  true
);
assert.equal(
  __testOnly.isFlushable({
    group,
    caseId: "case-1",
    chatId: 123,
    nowMs: Date.parse("2026-06-20T22:28:08.000Z"),
    windowMs: 4_000,
    force: false,
    mediaGroupId: "a-different-album",
  }),
  false,
  "a new album webhook must not flush an older unrelated group"
);

const sent = __testOnly.markSentInMap(appended, [key], "2026-06-20T22:28:09.000Z");
assert.equal(typeof sent[key]?.ack_sent_at, "string");
assert.deepEqual(__testOnly.pendingAckKeys(appended), [key]);
assert.deepEqual(__testOnly.pendingAckKeys(sent), []);
assert.equal(
  __testOnly.nextPendingAckDueAt(appended, 4_000),
  "2026-06-20T22:28:07.000Z"
);
assert.equal(__testOnly.nextPendingAckDueAt(sent, 4_000), null);

const pendingWhileSettling = __testOnly.inspectPendingMediaGroupAcks({
  context: { telegram_media_group_acks: appended },
  caseId: "case-1",
  chatId: 123,
  windowMs: 4_000,
  nowMs: Date.parse("2026-06-20T22:28:04.000Z"),
});
assert.equal(pendingWhileSettling.settling, true);
assert.equal(pendingWhileSettling.pendingFileCount, 2);
assert.ok(
  pendingWhileSettling.msSinceLastFile != null &&
    pendingWhileSettling.msSinceLastFile < 4_000
);

const pendingAfterQuiet = __testOnly.inspectPendingMediaGroupAcks({
  context: { telegram_media_group_acks: appended },
  caseId: "case-1",
  chatId: 123,
  windowMs: 4_000,
  nowMs: Date.parse("2026-06-20T22:28:10.000Z"),
});
assert.equal(pendingAfterQuiet.settling, false);
assert.equal(pendingAfterQuiet.pendingFileCount, 2);

const pendingAfterAck = __testOnly.inspectPendingMediaGroupAcks({
  context: { telegram_media_group_acks: sent },
  caseId: "case-1",
  chatId: 123,
  windowMs: 4_000,
  nowMs: Date.parse("2026-06-20T22:28:10.000Z"),
});
assert.equal(pendingAfterAck.settling, false);
assert.equal(pendingAfterAck.pendingFileCount, 0);

console.log("telegram-media-group-ack-store.selftest: ok");
