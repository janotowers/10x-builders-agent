import assert from "node:assert/strict";
import {
  buildPendingMessageEnvelope,
  parsePendingAttachments,
  serializePendingAttachments,
} from "./pending-attachment-envelope";

const userId = "user-aaa-111";
const attachments = [
  {
    fileName: "predial.pdf",
    mimeType: "application/pdf",
    sizeBytes: 1200,
    storageBucket: "case-documents",
    storagePath: `${userId}/chat-staging/predial.pdf`,
    sha256: "abc123",
    suggestedKind: "predial",
  },
  {
    fileName: "id.pdf",
    mimeType: "application/pdf",
    sizeBytes: 800,
    storageBucket: "case-documents",
    storagePath: `${userId}/chat-staging/id.pdf`,
    sha256: "def456",
  },
];

const envelope = buildPendingMessageEnvelope({
  text: "documentos adjuntos",
  attachments,
});
assert.equal(envelope.text, "documentos adjuntos");
assert.ok(Array.isArray(envelope.attachments));
assert.equal((envelope.attachments as unknown[]).length, 2);

const serialized = serializePendingAttachments(attachments);
assert.equal(serialized[0]?.suggestedKind, "predial");
assert.equal(serialized[1]?.suggestedKind, undefined);

const parsed = parsePendingAttachments(envelope, { userId });
assert.equal(parsed.length, 2);
assert.equal(parsed[0]?.fileName, "predial.pdf");
assert.equal(parsed[1]?.storagePath, `${userId}/chat-staging/id.pdf`);

// Ownership: foreign staging paths are dropped.
const foreign = buildPendingMessageEnvelope({
  text: "x",
  attachments: [
    {
      ...attachments[0]!,
      storagePath: "other-user/chat-staging/predial.pdf",
    },
  ],
});
assert.deepEqual(parsePendingAttachments(foreign, { userId }), []);

// Round-trip: clarify reply must restore refs for deterministic ingest.
const restored = parsePendingAttachments(
  buildPendingMessageEnvelope({
    text: "cinco pdfs",
    attachments: serializePendingAttachments(attachments),
  }),
  { userId }
);
assert.equal(restored.length, 2);
assert.ok(restored.every((a) => a.storagePath.startsWith(`${userId}/`)));

console.log("pending-attachment-envelope.selftest: ok");
