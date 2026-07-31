import assert from "node:assert/strict";
import {
  buildHitlActionsForKind,
  buildTelegramInlineKeyboardForKind,
  hitlActionIdsForKind,
  HITL_MIRROR_KINDS,
  resolveHitlActionByTelegramCallback,
} from "./hitl-action-contract";

const kinds = [
  "price_approval",
  "property_data_review",
  "contract_review",
  "listing_description_review",
  "easybroker_publish_approval",
  "ungga_publish_approval",
  "publication_review_required",
  "titularidad_review",
  "photos_upload_requested",
  "documents_upload_requested",
  "comparables_search_expansion_decision",
] as const;

for (const kind of kinds) {
  assert.ok(HITL_MIRROR_KINDS.has(kind), `mirror kind missing: ${kind}`);
  const actions = buildHitlActionsForKind(kind);
  assert.ok(actions.length > 0, `no actions for ${kind}`);
  const keyboard = buildTelegramInlineKeyboardForKind({
    kind,
    notificationId: "notif-1",
    caseId: "case-1",
  });
  assert.ok(keyboard, `no telegram keyboard for ${kind}`);
  assert.equal(keyboard!.inline_keyboard.length, actions.length);
  for (const action of actions) {
    assert.ok(
      action.telegramCallbackPrefix,
      `missing telegram prefix for ${kind}/${action.id}`
    );
  }
}

const titularidadIds = hitlActionIdsForKind("titularidad_review");
assert.deepEqual(titularidadIds, [
  "request_external_evidence",
  "request_internal_docs",
  "continue_override",
]);

const titularidadKb = buildTelegramInlineKeyboardForKind({
  kind: "titularidad_review",
  notificationId: "n-tit",
});
assert.ok(
  titularidadKb!.inline_keyboard.some((row) =>
    row.some(
      (btn) =>
        "callback_data" in btn &&
        btn.callback_data === "titularidad_request_external:n-tit"
    )
  )
);
assert.ok(
  titularidadKb!.inline_keyboard.some((row) =>
    row.some(
      (btn) =>
        "callback_data" in btn &&
        btn.callback_data === "titularidad_continue:n-tit"
    )
  )
);

const legacyApprove = resolveHitlActionByTelegramCallback({
  kind: "titularidad_review",
  callbackAction: "titularidad_approve",
});
assert.equal(legacyApprove?.id, "continue_override");

const comparablesKb = buildTelegramInlineKeyboardForKind({
  kind: "comparables_search_expansion_decision",
  notificationId: "n-comp",
});
assert.equal(comparablesKb!.inline_keyboard.length, 3);
assert.ok(
  comparablesKb!.inline_keyboard.some((row) =>
    row.some(
      (btn) =>
        "callback_data" in btn && btn.callback_data === "comp_current:n-comp"
    )
  )
);

const uploadKb = buildTelegramInlineKeyboardForKind({
  kind: "photos_upload_requested",
  notificationId: "n-up",
  caseId: "case-photos",
});
assert.equal(
  uploadKb!.inline_keyboard[0]?.[0] &&
    "callback_data" in uploadKb!.inline_keyboard[0][0]
    ? uploadKb!.inline_keyboard[0][0].callback_data
    : null,
  "upload_done:case-photos"
);

const pubrev = buildHitlActionsForKind("publication_review_required", {
  credential_failure: true,
});
assert.equal(pubrev[0]?.label, "Ya actualicé la API key — reintentar");

console.log("hitl-action-contract.selftest: ok");
