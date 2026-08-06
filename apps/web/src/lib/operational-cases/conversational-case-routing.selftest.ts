import assert from "node:assert/strict";
import {
  looksLikeNewCaseIntent,
  resolveTelegramConversationRoute,
  shouldBindTelegramMessageToConversationalCase,
  shouldForceNewConversationalCaseOnExplicitStartIntent,
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

// «interno»/«externo» sobre un caso que espera esa decisión: continuar el caso
// (no caer en single_binding_ambiguous_followup).
assert.equal(
  shouldBindTelegramMessageToConversationalCase({
    message: "interno",
    opCase: operationalCase,
  }),
  true
);
assert.equal(
  shouldBindTelegramMessageToConversationalCase({
    message: "externo",
    opCase: operationalCase,
  }),
  true
);

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

const decisionInterno = resolveTelegramConversationRoute({
  message: "interno",
  bindings: [binding],
  candidateCasesById: new Map([["case-1", operationalCase]]),
  explicitIntent: false,
});
assert.equal(decisionInterno.route, "case");

const decisionCase = resolveTelegramConversationRoute({
  message: "Es un terreno en Sendas",
  bindings: [binding],
  candidateCasesById: new Map([["case-1", intakeCase]]),
  explicitIntent: false,
});
assert.equal(decisionCase.route, "case");

const explicitStartSingle = resolveTelegramConversationRoute({
  message: "Quiero opcionar",
  bindings: [binding],
  candidateCasesById: new Map([["case-1", intakeCase]]),
  explicitIntent: true,
});
assert.equal(explicitStartSingle.route, "clarify");

// Regresión 2026-08-06: "Quiero opcionar una propiedad" contiene la palabra
// "propiedad" y pasaba el heurístico de datos de intake, adoptando en
// silencio un draft viejo. Una frase de ARRANQUE nunca es continuación.
const explicitStartWithPropertyWord = resolveTelegramConversationRoute({
  message: "Quiero opcionar una propiedad",
  bindings: [binding],
  candidateCasesById: new Map([["case-1", intakeCase]]),
  explicitIntent: true,
});
assert.equal(explicitStartWithPropertyWord.route, "clarify");
if (explicitStartWithPropertyWord.route === "clarify") {
  assert.equal(
    explicitStartWithPropertyWord.reason,
    "explicit_intent_with_active_bindings"
  );
}

// Start intent con caso YA pasado de intake: aclarar continuar vs nueva
// (no adoptar en silencio ni forzar case nuevo sin preguntar).
const explicitStartPastIntake = resolveTelegramConversationRoute({
  message: "quiero opcionar una propiedad",
  bindings: [binding],
  candidateCasesById: new Map([["case-1", operationalCase]]),
  explicitIntent: true,
});
assert.equal(explicitStartPastIntake.route, "clarify");
if (explicitStartPastIntake.route === "clarify") {
  assert.equal(
    explicitStartPastIntake.reason,
    "explicit_intent_with_active_bindings"
  );
}

// Precedencia de intake: responder con DATOS de propiedad al único caso en
// intake incompleto debe continuar ese caso, aunque el clasificador marque
// intención explícita (no debe pedir aclaración «continuar vs nueva»).
const intakeDataReply = resolveTelegramConversationRoute({
  message: "Casa en venta en Las Fuentes, Zapopan, Jalisco",
  bindings: [binding],
  candidateCasesById: new Map([["case-1", intakeCase]]),
  explicitIntent: true,
});
assert.equal(intakeDataReply.route, "case");
if (intakeDataReply.route === "case") {
  assert.equal(intakeDataReply.reason, "single_binding_intake_continuation");
}

// Pero pedir explícitamente OTRA propiedad sí debe aclarar, incluso en intake.
const explicitNewWhileIntake = resolveTelegramConversationRoute({
  message: "Quiero opcionar otra propiedad",
  bindings: [binding],
  candidateCasesById: new Map([["case-1", intakeCase]]),
  explicitIntent: true,
});
assert.equal(explicitNewWhileIntake.route, "clarify");

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

// Multiple active cases of the same type → clarify with several candidates so
// the webhook can present a numbered list.
const intakeCaseWithId = {
  ...intakeCase,
  id: "case-1",
} as unknown as OperationalCase;
const intakeCaseB = {
  ...intakeCase,
  id: "case-2",
  context_jsonb: {
    created_from: "agent_conversation",
    intake_status: "incomplete",
    title: "Casa Sendas",
  },
} as unknown as OperationalCase;
const bindingB = {
  ...binding,
  id: "binding-2",
  case_id: "case-2",
} as OperationalCaseConversationBinding;
const decisionMultiple = resolveTelegramConversationRoute({
  message: "Quiero seguir con el caso",
  bindings: [binding, bindingB],
  candidateCasesById: new Map([
    ["case-1", intakeCaseWithId],
    ["case-2", intakeCaseB],
  ]),
  explicitIntent: false,
});
assert.equal(decisionMultiple.route, "clarify");
if (decisionMultiple.route === "clarify") {
  assert.equal(decisionMultiple.candidates.length, 2);
  assert.deepEqual(
    decisionMultiple.candidates.map((c) => c.caseId).sort(),
    ["case-1", "case-2"]
  );
}

const staleAdvancedCase = {
  ...operationalCase,
  id: "case-3",
  context_jsonb: {
    created_from: "agent_conversation",
    intake_status: "complete",
    property_title: "Casa vieja",
  },
} as unknown as OperationalCase;
const staleBinding = {
  ...binding,
  id: "binding-3",
  case_id: "case-3",
} as OperationalCaseConversationBinding;
const decisionSingleIntakeAmongStale = resolveTelegramConversationRoute({
  message: "Casa en venta en Las Fuentes. La zona es Las Fuentes, Zapopan, Jalisco",
  bindings: [binding, staleBinding],
  candidateCasesById: new Map([
    ["case-1", intakeCaseWithId],
    ["case-3", staleAdvancedCase],
  ]),
  explicitIntent: false,
});
assert.equal(decisionSingleIntakeAmongStale.route, "case");
if (decisionSingleIntakeAmongStale.route === "case") {
  assert.equal(decisionSingleIntakeAmongStale.caseId, "case-1");
  assert.equal(
    decisionSingleIntakeAmongStale.reason,
    "single_matching_binding_continuation"
  );
}

const explicitStartMultiple = resolveTelegramConversationRoute({
  message: "Quiero opcionar",
  bindings: [binding, bindingB],
  candidateCasesById: new Map([
    ["case-1", intakeCaseWithId],
    ["case-2", intakeCaseB],
  ]),
  explicitIntent: true,
});
assert.equal(explicitStartMultiple.route, "clarify");

// New-case intent detection (deterministic gate for forcing a fresh case).
assert.equal(looksLikeNewCaseIntent("Quiero opcionar otra propiedad"), true);
assert.equal(looksLikeNewCaseIntent("Es para un nuevo caso"), true);
assert.equal(looksLikeNewCaseIntent("otra casa en venta"), true);
assert.equal(looksLikeNewCaseIntent("La zona es Sendas"), false);
assert.equal(looksLikeNewCaseIntent("Ana Pérez, 5 millones"), false);

assert.equal(
  shouldForceNewConversationalCaseOnExplicitStartIntent(
    "quiero opcionar una propiedad",
    { current_step: "awaiting_documents" }
  ),
  true
);
assert.equal(
  shouldForceNewConversationalCaseOnExplicitStartIntent(
    "quiero opcionar una propiedad",
    { current_step: "intake" }
  ),
  false
);
assert.equal(
  shouldForceNewConversationalCaseOnExplicitStartIntent(
    "La zona es Las Fuentes, Zapopan",
    { current_step: "awaiting_documents" }
  ),
  false
);

const photosRequestedCase = {
  current_step: "photos_requested",
  status: "waiting_internal",
  context_jsonb: {
    created_from: "agent_conversation",
    e2e_controlled: true,
  },
} as unknown as OperationalCase;

assert.equal(
  shouldBindTelegramMessageToConversationalCase({
    message: "listo",
    opCase: photosRequestedCase,
  }),
  true
);
assert.equal(
  shouldBindTelegramMessageToConversationalCase({
    message: "ahí te van las fotos",
    opCase: photosRequestedCase,
  }),
  true
);
assert.equal(
  shouldBindTelegramMessageToConversationalCase({
    message: "Cuántos leads tuvimos en marzo?",
    opCase: photosRequestedCase,
  }),
  false
);

const photosBinding = {
  ...binding,
  id: "binding-photos",
  case_id: "case-photos",
} as OperationalCaseConversationBinding;
const photosCaseWithId = {
  ...photosRequestedCase,
  id: "case-photos",
} as unknown as OperationalCase;
const decisionPhotosListo = resolveTelegramConversationRoute({
  message: "listo",
  bindings: [photosBinding],
  candidateCasesById: new Map([["case-photos", photosCaseWithId]]),
  explicitIntent: false,
});
assert.equal(decisionPhotosListo.route, "case");
if (decisionPhotosListo.route === "case") {
  assert.equal(decisionPhotosListo.caseId, "case-photos");
}

console.log("conversational-case-routing.route-selftest: ok");
