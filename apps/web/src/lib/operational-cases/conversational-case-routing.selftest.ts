import assert from "node:assert/strict";
import {
  resolveTelegramConversationRoute,
  shouldBindTelegramMessageToConversationalCase,
} from "./conversational-case-routing";
import type { OperationalCaseConversationBinding } from "@agents/types";
import type { OperationalCase } from "@agents/types";

const intakeCase = {
  current_step: "intake",
  context_jsonb: {
    created_from: "agent_conversation",
    intake_status: "incomplete",
  },
} as unknown as OperationalCase;

assert.equal(
  shouldBindTelegramMessageToConversationalCase({
    message: "Es una casa en Reforma 123",
    opCase: intakeCase,
  }),
  true
);

assert.equal(
  shouldBindTelegramMessageToConversationalCase({
    message: "Cuántos leads tuvimos en marzo?",
    opCase: intakeCase,
  }),
  false
);

assert.equal(
  shouldBindTelegramMessageToConversationalCase({
    message: "Ana Pérez, precio ideal 5 millones",
    opCase: intakeCase,
  }),
  true
);

const operationalCase = {
  status: "waiting_external",
  current_step: "awaiting_documents",
  context_jsonb: {
    created_from: "agent_conversation",
    intake_status: "complete",
  },
} as unknown as OperationalCase;

assert.equal(
  shouldBindTelegramMessageToConversationalCase({
    message: "hola",
    opCase: operationalCase,
  }),
  false
);

console.log("conversational-case-routing.selftest: ok");

const binding = {
  id: "binding-1",
  user_id: "u1",
  case_id: "case-1",
  case_type: "property_optioning",
  channel: "telegram",
  chat_id: 1,
  session_id: null,
  status: "awaiting_user",
  awaiting_fields_jsonb: [],
  last_agent_prompt: null,
  last_prompt_at: null,
  last_user_message_at: null,
  pending_message_jsonb: {},
  candidate_routes_jsonb: [],
  metadata_jsonb: {},
  expires_at: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
} as OperationalCaseConversationBinding;

const decisionCase = resolveTelegramConversationRoute({
  message: "Es un terreno en Sendas",
  bindings: [binding],
  candidateCasesById: new Map([["case-1", intakeCase]]),
  explicitIntent: false,
});
assert.equal(decisionCase.route, "case");

const decisionGeneral = resolveTelegramConversationRoute({
  message: "¿Cuántos leads tuvimos ayer?",
  bindings: [binding],
  candidateCasesById: new Map([["case-1", intakeCase]]),
  explicitIntent: false,
});
assert.equal(decisionGeneral.route, "general");

const duplicateBinding = {
  ...binding,
  id: "binding-duplicate",
  status: "clarification_needed",
} as OperationalCaseConversationBinding;
const decisionDeduped = resolveTelegramConversationRoute({
  message: "Terreno en venta en Sendas Residencial",
  bindings: [duplicateBinding, binding],
  candidateCasesById: new Map([["case-1", intakeCase]]),
  explicitIntent: false,
});
assert.equal(decisionDeduped.route, "case");

const propertyDataReviewCase = {
  ...operationalCase,
  status: "waiting_internal",
  current_step: "documents_received",
} as OperationalCase;
assert.equal(
  shouldBindTelegramMessageToConversationalCase({
    message: "La operación es Venta",
    opCase: propertyDataReviewCase,
  }),
  true
);
const decisionReviewCorrection = resolveTelegramConversationRoute({
  message: "La operación es Venta",
  bindings: [binding],
  candidateCasesById: new Map([["case-1", propertyDataReviewCase]]),
  explicitIntent: false,
});
assert.equal(decisionReviewCorrection.route, "case");

const pausedCase = {
  ...intakeCase,
  status: "paused",
} as OperationalCase;
const decisionPausedIgnored = resolveTelegramConversationRoute({
  message: "Terreno en venta en Sendas Residencial",
  bindings: [binding],
  candidateCasesById: new Map([["case-1", pausedCase]]),
  explicitIntent: false,
});
assert.equal(decisionPausedIgnored.route, "general");

console.log("conversational-case-routing.route-selftest: ok");
