import assert from "node:assert/strict";
import type { OperationalCaseConversationBinding } from "@agents/types";
import {
  resolveActiveCaseInternalChannel,
  resolveWebChatSessionIdForMirror,
} from "./mirror-case-message-to-web-chat";

assert.equal(
  resolveWebChatSessionIdForMirror({
    bindingSessionId: "sess-web",
    fallbackSessionId: "sess-fallback",
  }),
  "sess-web"
);
assert.equal(
  resolveWebChatSessionIdForMirror({
    bindingSessionId: "  ",
    fallbackSessionId: "sess-fallback",
  }),
  "sess-fallback"
);
assert.equal(
  resolveWebChatSessionIdForMirror({
    bindingSessionId: null,
    fallbackSessionId: null,
  }),
  null
);

const binding = (
  channel: "web" | "telegram",
  lastUserMessageAt: string
) =>
  ({
    channel,
    last_user_message_at: lastUserMessageAt,
    updated_at: lastUserMessageAt,
  }) as OperationalCaseConversationBinding;

assert.equal(
  resolveActiveCaseInternalChannel({
    webBinding: binding("web", "2026-07-30T20:26:00.000Z"),
    telegramBinding: binding("telegram", "2026-07-30T18:00:00.000Z"),
  }),
  "web"
);
assert.equal(
  resolveActiveCaseInternalChannel({
    webBinding: binding("web", "2026-07-30T18:00:00.000Z"),
    telegramBinding: binding("telegram", "2026-07-30T20:27:00.000Z"),
  }),
  "telegram"
);
assert.equal(
  resolveActiveCaseInternalChannel({
    webBinding: null,
    telegramBinding: null,
  }),
  null
);

console.log("mirror-case-message-to-web-chat.selftest: ok");
