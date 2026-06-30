import assert from "node:assert/strict";
import { shouldSendTelegramAgentResponse } from "./telegram-agent-response-policy";

assert.equal(
  shouldSendTelegramAgentResponse({
    response: "",
    toolCalls: [],
    hasConversationalCase: true,
  }),
  false
);

assert.equal(
  shouldSendTelegramAgentResponse({
    response: "Listo",
    toolCalls: [],
    hasConversationalCase: false,
  }),
  true
);

assert.equal(
  shouldSendTelegramAgentResponse({
    response: "He notificado al equipo interno.",
    toolCalls: ["notify_user"],
    hasConversationalCase: true,
  }),
  false
);

assert.equal(
  shouldSendTelegramAgentResponse({
    response: "Hecho.",
    toolCalls: ["operational_case_update_state"],
    hasConversationalCase: true,
  }),
  true
);

assert.equal(
  shouldSendTelegramAgentResponse({
    response: "Notificado.",
    toolCalls: [" Notify_User "],
    hasConversationalCase: true,
  }),
  false
);

console.log("telegram-agent-response-policy.selftest: ok");
