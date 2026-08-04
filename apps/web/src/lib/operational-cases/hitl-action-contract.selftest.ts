import assert from "node:assert/strict";
import {
  buildHitlActionsForKind,
  buildTelegramInlineKeyboardForKind,
  hitlActionIdsForKind,
  HITL_MIRROR_KINDS,
  resolveHitlActionByTelegramCallback,
  resolveTelegramHitlCallback,
  TELEGRAM_CALLBACK_DATA_MAX_BYTES,
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

// Ids reales son UUID (36 chars): todo `prefix:uuid` debe caber en los 64
// bytes de callback_data de Telegram, o Telegram rechaza el mensaje entero
// (BUTTON_DATA_INVALID — hallazgo del walkthrough E2E con titularidad_review).
const UUID_LENGTH_ID = "123e4567-e89b-42d3-a456-426614174000";

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
    const callbackData = `${action.telegramCallbackPrefix}:${UUID_LENGTH_ID}`;
    assert.ok(
      Buffer.byteLength(callbackData, "utf8") <= TELEGRAM_CALLBACK_DATA_MAX_BYTES,
      `callback_data de ${kind}/${action.id} excede ${TELEGRAM_CALLBACK_DATA_MAX_BYTES} bytes con uuid: ${callbackData}`
    );
  }
  // Con ids largos reales el teclado debe conservar TODOS los botones.
  const uuidKeyboard = buildTelegramInlineKeyboardForKind({
    kind,
    notificationId: UUID_LENGTH_ID,
    caseId: UUID_LENGTH_ID,
  });
  assert.equal(
    uuidKeyboard!.inline_keyboard.length,
    actions.length,
    `botones omitidos por longitud en ${kind}`
  );
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
        btn.callback_data === "tit_req_ext:n-tit"
    )
  )
);
// Los prefijos largos previos siguen resolviendo como alias (webhooks in-flight).
const titularidadLegacyExternal = resolveTelegramHitlCallback({
  callbackAction: "titularidad_request_external",
});
assert.equal(titularidadLegacyExternal?.kind, "titularidad_review");
assert.equal(titularidadLegacyExternal?.action.id, "request_external_evidence");
const titularidadShortInternal = resolveTelegramHitlCallback({
  callbackAction: "tit_req_int",
});
assert.equal(titularidadShortInternal?.action.id, "request_internal_docs");
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

const fromPrefix = resolveTelegramHitlCallback({
  callbackAction: "comp_avaclick",
});
assert.equal(fromPrefix?.kind, "comparables_search_expansion_decision");
assert.equal(fromPrefix?.action.id, "use_avaclick_primary");
assert.equal(fromPrefix?.action.freeText, "2");

const titularidadFromAlias = resolveTelegramHitlCallback({
  callbackAction: "titularidad_approve",
});
assert.equal(titularidadFromAlias?.kind, "titularidad_review");
assert.equal(titularidadFromAlias?.action.id, "continue_override");

// Tool-confirm `approve` must NOT collide with HITL action ids.
assert.equal(resolveTelegramHitlCallback({ callbackAction: "approve" }), null);

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
