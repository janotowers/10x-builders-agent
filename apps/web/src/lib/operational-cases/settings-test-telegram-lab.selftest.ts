import assert from "node:assert/strict";
import { SETTINGS_TEST_TELEGRAM_LAB_CHAT_ID } from "@agents/types";
import {
  shouldSimulateSettingsTestTelegram,
  settingsTestTelegramChatIdForAgent,
  telegramChatIdFromCase,
} from "./settings-test-telegram-lab";

assert.equal(
  shouldSimulateSettingsTestTelegram({
    chatId: 0,
    toolCallSource: "skill_test",
  }),
  true
);
assert.equal(
  shouldSimulateSettingsTestTelegram({
    chatId: SETTINGS_TEST_TELEGRAM_LAB_CHAT_ID,
    toolCallSource: "step_test",
  }),
  true
);
assert.equal(
  shouldSimulateSettingsTestTelegram({
    chatId: 12345,
    toolCallSource: "skill_test",
  }),
  false
);
assert.equal(
  shouldSimulateSettingsTestTelegram({
    chatId: 0,
    toolCallSource: "chat",
  }),
  false
);

const opCase = {
  external_contact_jsonb: {},
  context_jsonb: { telegram_chat_id: "" },
} as Parameters<typeof telegramChatIdFromCase>[0];

assert.equal(telegramChatIdFromCase(opCase, {}), null);
assert.equal(
  settingsTestTelegramChatIdForAgent(opCase, {}),
  SETTINGS_TEST_TELEGRAM_LAB_CHAT_ID
);

console.log("settings-test-telegram-lab.selftest: ok");
