import assert from "node:assert/strict";
import type { OperationalCase } from "@agents/types";
import {
  isInternalDocumentEventDrivenWait,
  isInternalUploadEventDrivenWait,
  shouldClearInternalDocumentWaitSchedule,
} from "./internal-document-wait-invariant";

function opCase(patch: Partial<OperationalCase> = {}): OperationalCase {
  return {
    id: "case-1",
    user_id: "user-1",
    case_type_id: "type-1",
    case_type: "property_optioning",
    status: "waiting_internal",
    current_step: "awaiting_documents",
    context_jsonb: { document_request_target: "internal_user" },
    next_action_at: "2026-07-13T16:00:00.000Z",
    version: 1,
    created_at: "2026-07-13T15:00:00.000Z",
    updated_at: "2026-07-13T15:00:00.000Z",
    ...patch,
  } as OperationalCase;
}

assert.equal(isInternalDocumentEventDrivenWait(opCase()), true);
assert.equal(isInternalUploadEventDrivenWait(opCase()), true);
assert.equal(shouldClearInternalDocumentWaitSchedule(opCase()), true);
assert.equal(
  shouldClearInternalDocumentWaitSchedule(opCase({ next_action_at: null })),
  false
);
assert.equal(
  isInternalDocumentEventDrivenWait(opCase({ status: "waiting_external" })),
  false
);
assert.equal(
  isInternalDocumentEventDrivenWait(
    opCase({ context_jsonb: { document_request_target: "external_contact" } })
  ),
  false
);
assert.equal(
  isInternalDocumentEventDrivenWait(
    opCase({ current_step: "documents_received" })
  ),
  false
);
const photosWait = opCase({
  current_step: "photos_requested",
  context_jsonb: { raw_photos: [{ document_id: "photo-1" }] },
});
assert.equal(isInternalDocumentEventDrivenWait(photosWait), false);
assert.equal(isInternalUploadEventDrivenWait(photosWait), true);
assert.equal(shouldClearInternalDocumentWaitSchedule(photosWait), true);
assert.equal(
  isInternalUploadEventDrivenWait(
    opCase({ current_step: "photos_requested", status: "active" })
  ),
  false
);

console.log("internal-document-wait-invariant.selftest: ok");
