import assert from "node:assert/strict";
import {
  buildHitlApprovalTelegramMarkup,
  isTelegramUrlButtonHref,
  resolveHitlDetailUrlForTelegram,
} from "./hitl-telegram-markup";

assert.equal(isTelegramUrlButtonHref("https://example.com/pending"), true);
assert.equal(isTelegramUrlButtonHref("http://localhost:3000/chat/pending"), true);
assert.equal(isTelegramUrlButtonHref("/chat/pending?case=x"), false);
assert.equal(isTelegramUrlButtonHref(""), false);
assert.equal(isTelegramUrlButtonHref(null), false);

assert.equal(
  resolveHitlDetailUrlForTelegram(
    "/chat/pending?case=abc",
    "https://example.com"
  ),
  "https://example.com/chat/pending?case=abc"
);
assert.equal(
  resolveHitlDetailUrlForTelegram("https://example.com/x", "https://ignored"),
  "https://example.com/x"
);
assert.equal(resolveHitlDetailUrlForTelegram("/x", ""), null);

const withUrl = buildHitlApprovalTelegramMarkup({
  toolCallId: "tc-1",
  detailUrl: "https://example.com/chat/pending?case=abc",
});
assert.equal(withUrl.inline_keyboard.length, 2);
assert.deepEqual(withUrl.inline_keyboard[0], [
  { text: "✅ Aprobar", callback_data: "approve:tc-1" },
  { text: "❌ Cancelar", callback_data: "reject:tc-1" },
]);
assert.deepEqual(withUrl.inline_keyboard[1], [
  { text: "Ver detalle", url: "https://example.com/chat/pending?case=abc" },
]);

const withoutUrl = buildHitlApprovalTelegramMarkup({
  toolCallId: "tc-2",
  detailUrl: "/chat/pending?case=abc",
});
// Relative path without resolvable APP_URL in this process → approve/reject only.
assert.equal(withoutUrl.inline_keyboard.length, 1);
const approveButton = withoutUrl.inline_keyboard[0]?.[0];
assert.ok(approveButton && "callback_data" in approveButton);
assert.equal(approveButton.callback_data, "approve:tc-2");

console.log("hitl-telegram-markup.selftest: ok");

