import assert from "node:assert/strict";
import type { OperationalCase } from "@agents/types";
import {
  buildClarificationContinueNewTelegramMarkup,
  buildClarificationContinueNewWebPayload,
  buildClarificationContinueResponse,
  CLARIFICATION_CONTINUE_NEW_ACTIONS,
  CLARIFY_CONTINUE_FREE_TEXT,
  CLARIFY_NEW_FREE_TEXT,
  freeTextForClarificationCallback,
  isBarePropertyStartIntent,
} from "./conversation-clarification-actions";

assert.equal(
  freeTextForClarificationCallback("clarify_continue"),
  CLARIFY_CONTINUE_FREE_TEXT
);
assert.equal(
  freeTextForClarificationCallback("clarify_new"),
  CLARIFY_NEW_FREE_TEXT
);
assert.equal(freeTextForClarificationCallback("approve"), null);

const markup = buildClarificationContinueNewTelegramMarkup({
  bindingId: "binding-1",
});
assert.equal(markup.inline_keyboard.length, 1);
assert.equal(markup.inline_keyboard[0]?.length, 2);
const continueBtn = markup.inline_keyboard[0]?.[0];
const newBtn = markup.inline_keyboard[0]?.[1];
assert.ok(continueBtn && "callback_data" in continueBtn);
assert.ok(newBtn && "callback_data" in newBtn);
assert.equal(
  "callback_data" in continueBtn! ? continueBtn.callback_data : null,
  "clarify_continue:binding-1"
);
assert.equal(
  "callback_data" in newBtn! ? newBtn.callback_data : null,
  "clarify_new:binding-1"
);

const webPayload = buildClarificationContinueNewWebPayload({
  bindingId: "binding-1",
  caseId: "case-1",
});
assert.equal(webPayload.kind, "conversation_clarification");
assert.ok(Array.isArray(webPayload.actions));
assert.equal(
  (webPayload.actions as Array<{ freeText: string }>)[0]?.freeText,
  CLARIFY_CONTINUE_FREE_TEXT
);
assert.equal(CLARIFICATION_CONTINUE_NEW_ACTIONS.length, 2);

assert.equal(isBarePropertyStartIntent("Quiero opcionar una propiedad"), true);
assert.equal(
  isBarePropertyStartIntent(
    "Quiero opcionar una propiedad. Casa en venta en Las Fuentes, Zapopan"
  ),
  false
);
assert.equal(
  isBarePropertyStartIntent("quiero opcionar una casa"),
  false,
  "«casa» se extrae como property_type → no es arranque vacío"
);
assert.equal(isBarePropertyStartIntent("La zona es Sendas"), false);

const awaitingDocsCase = {
  id: "case-docs",
  case_type: "property_optioning",
  status: "waiting_internal",
  current_step: "awaiting_documents",
  context_jsonb: {
    property_title: "Propiedad en Zapopan",
    intake_status: "complete",
    document_request_target: "internal_user",
  },
} as unknown as OperationalCase;
const continueAck = buildClarificationContinueResponse(awaitingDocsCase);
assert.ok(continueAck.includes("ya está registrado"));
assert.ok(/documento/i.test(continueAck));
assert.ok(
  !/en qué te ayudo/i.test(continueAck),
  "continuar no debe abrir chat genérico"
);

console.log("conversation-clarification-actions.selftest: ok");
