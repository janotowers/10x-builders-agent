/**
 * Matriz de paridad Web Real / Telegram Real / E2E lab para adjuntos + HITL.
 * Cubre contratos puros compartidos (sin DB): envelope, ack, policy.
 */
import assert from "node:assert/strict";
import { buildMediaGroupReceivedAck } from "./case-document-collection";
import {
  buildOperationalCaseToolApprovalPolicy,
  mergeToolApprovalPolicies,
} from "./conversational-case-orchestrator";
import { buildTelegramOperationalCaseToolApprovalPolicy } from "./telegram-operational-case-tool-policy";
import { looksLikeDocumentBatchComplete } from "./document-batch-completion";
import {
  buildPendingMessageEnvelope,
  parsePendingAttachments,
} from "./pending-attachment-envelope";
import { stripEmbeddedAttachmentOcr } from "@/lib/chat/attachment-message-display";

// Policy parity: web builder === telegram re-export.
const intake = { current_step: "intake" as const };
const awaiting = { current_step: "awaiting_documents" as const };
assert.deepEqual(
  buildOperationalCaseToolApprovalPolicy(intake),
  buildTelegramOperationalCaseToolApprovalPolicy(intake)
);
assert.deepEqual(
  buildOperationalCaseToolApprovalPolicy(awaiting),
  buildTelegramOperationalCaseToolApprovalPolicy(awaiting)
);

// Outside intake: bookkeeping auto_execute (no HITL fatigue).
const outside = buildOperationalCaseToolApprovalPolicy(awaiting)!;
assert.equal(outside.operational_case_update_state, "auto_execute");
assert.equal(outside.operational_case_add_event, "auto_execute");

// During intake: deny bookkeeping mutations.
const duringIntake = buildOperationalCaseToolApprovalPolicy(intake)!;
assert.equal(duringIntake.operational_case_update_state, "deny");
assert.equal(duringIntake.operational_case_add_event, "deny");

// Resume merge: ops + e2e (e2e wins on overlap).
const merged = mergeToolApprovalPolicies(
  outside,
  { generate_document: "auto_execute", operational_case_update_state: "deny" }
);
assert.equal(merged?.generate_document, "auto_execute");
assert.equal(merged?.operational_case_update_state, "deny");
assert.equal(merged?.operational_case_add_event, "auto_execute");
assert.equal(mergeToolApprovalPolicies(undefined, null), undefined);

const internalRoute = {
  current_step: "documents_received" as const,
  context_jsonb: { document_request_target: "internal_user" },
};
assert.equal(
  buildOperationalCaseToolApprovalPolicy(internalRoute)
    ?.telegram_send_message_to_contact,
  "deny"
);
assert.equal(
  buildTelegramOperationalCaseToolApprovalPolicy(internalRoute)
    ?.telegram_send_message_to_contact,
  "deny"
);

// Web clarify envelope: 5 PDFs survive selection "1".
const userId = "user-parity";
const five = Array.from({ length: 5 }, (_, i) => ({
  fileName: `doc-${i + 1}.pdf`,
  mimeType: "application/pdf",
  sizeBytes: 100 + i,
  storageBucket: "case-documents",
  storagePath: `${userId}/chat-staging/doc-${i + 1}.pdf`,
  sha256: `hash-${i + 1}`,
  suggestedKind: "unknown",
}));
const pending = buildPendingMessageEnvelope({
  text: "documentos adjuntos",
  attachments: five,
});
const restored = parsePendingAttachments(pending, { userId });
assert.equal(restored.length, 5);

// Deterministic ack (no LLM): same helper Telegram/web/cron share.
const ack = buildMediaGroupReceivedAck(
  restored.map((a) => ({ originalName: a.fileName, kind: a.suggestedKind }))
);
assert.match(ack, /Recibí 5 documentos/);
assert.match(ack, /doc-1\.pdf/);
assert.match(ack, /listo/);

// Upload + «listo» same turn (Telegram markReadyFromCaption parity):
// receive ack with expectMore=false + batch-complete detector on user text.
const sameTurn = `listo\n\n---\n### Archivo adjunto: doc-1.pdf\n-- 1 of 1 --`;
assert.equal(
  looksLikeDocumentBatchComplete(stripEmbeddedAttachmentOcr(sameTurn)),
  true
);
const closedAck = buildMediaGroupReceivedAck(
  restored.map((a) => ({ originalName: a.fileName, kind: a.suggestedKind })),
  { expectMore: false }
);
assert.match(closedAck, /Recibí 5 documentos/);
assert.match(closedAck, /Gracias por confirmar el cierre/);
assert.ok(!closedAck.includes('escribe «listo»'));

// E2E lab policy shape: same ops auto_execute outside intake (lab overlays
// publication policy separately at resume time).
assert.equal(
  buildOperationalCaseToolApprovalPolicy({
    current_step: "awaiting_documents",
  })?.operational_case_update_state,
  "auto_execute"
);

console.log("attachment-hitl-parity.selftest: ok");
