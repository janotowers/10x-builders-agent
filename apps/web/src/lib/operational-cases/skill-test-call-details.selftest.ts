import assert from "node:assert/strict";
import {
  classifySkillTestTelegramSends,
  skillTestTelegramNotice,
} from "./skill-test-call-details";

const simulatedCall = {
  tool_name: "telegram_send_message_to_contact",
  status: "executed",
  arguments_json: { purpose: "initial_request", chat_id: 900000000001, text: "hola" },
  result_json: { ok: true, settings_test_simulated: true },
};

const buckets = classifySkillTestTelegramSends([simulatedCall]);
assert.equal(buckets.realSends.length, 0);
assert.equal(buckets.labSimulated.length, 1);
assert.equal(buckets.backendDeduped.length, 0);

const notice = skillTestTelegramNotice([simulatedCall], "habilidad");
assert.ok(notice?.includes("simulado"));
assert.ok(notice?.includes("laboratorio"));
assert.ok(!notice?.includes("skipped_send"));
assert.ok(!notice?.includes("Confirma en Telegram"));

const realCall = {
  tool_name: "telegram_send_message_to_contact",
  status: "executed",
  arguments_json: { purpose: "request_documents", chat_id: 12345, text: "hola" },
  result_json: { ok: true, chat_id: 12345 },
};

const realNotice = skillTestTelegramNotice([realCall], "habilidad");
assert.ok(realNotice?.includes("real"));
assert.ok(realNotice?.includes("API Telegram"));

console.log("skill-test-call-details.selftest: ok");
