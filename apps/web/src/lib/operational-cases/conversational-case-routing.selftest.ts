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

// Regresión 2026-08-09 (2): "dame los leads de junio" no tiene palabra de
// conteo pero es claramente una petición de métricas — no debe caer en el
// aclarador del caso, ni siquiera sin contexto de mensajes recientes.
const analyticsImperative = resolveTelegramConversationRoute({
  message: "dame los leads de junio",
  bindings: [binding],
  candidateCasesById: new Map([["case-1", operationalCase]]),
  explicitIntent: false,
});
assert.equal(analyticsImperative.route, "general");
if (analyticsImperative.route === "general") {
  assert.equal(analyticsImperative.reason, "analytics_query");
}
assert.equal(
  shouldBindTelegramMessageToConversationalCase({
    message: "dame los leads de junio",
    opCase: intakeCase,
  }),
  false
);

// Sustantivo inequívoco + mes, sin verbo ni conteo ("los leads de junio").
const analyticsNounPeriod = resolveTelegramConversationRoute({
  message: "los leads de junio",
  bindings: [binding],
  candidateCasesById: new Map([["case-1", operationalCase]]),
  explicitIntent: false,
});
assert.equal(analyticsNounPeriod.route, "general");

// «venta» + mes NO debe tratarse como analítica: es vocabulario inmobiliario
// («disponible para venta en junio» puede ser respuesta del caso).
const reviewCaseForAnalyticsGuard = {
  ...operationalCase,
  status: "waiting_internal",
  current_step: "documents_received",
} as OperationalCase;
const propertySaleWithMonth = resolveTelegramConversationRoute({
  message: "la operacion es venta, disponible en junio",
  bindings: [binding],
  candidateCasesById: new Map([["case-1", reviewCaseForAnalyticsGuard]]),
  explicitIntent: false,
});
assert.equal(propertySaleWithMonth.route, "case");

// Contexto conversacional: hilo reciente de métricas + mensaje ambiguo sin
// datos de propiedad → general (no aclarar contra el caso).
const analyticsContextMessages = [
  {
    id: "message-analytics-ctx",
    session_id: "session-1",
    role: "assistant" as const,
    content: "En julio tuvimos 0 leads creados. Lo medimos en horario de México CDMX.",
    created_at: new Date().toISOString(),
  },
];
const ambiguousWithAnalyticsContext = resolveTelegramConversationRoute({
  message: "y esas cifras de donde salen?",
  bindings: [binding],
  candidateCasesById: new Map([["case-1", operationalCase]]),
  explicitIntent: false,
  recentMessages: analyticsContextMessages,
});
assert.equal(ambiguousWithAnalyticsContext.route, "general");
if (ambiguousWithAnalyticsContext.route === "general") {
  assert.equal(
    ambiguousWithAnalyticsContext.reason,
    "analytics_context_continuation"
  );
}

// El mismo mensaje SIN contexto analítico conserva el aclarador (no regresión
// del flujo operativo).
const ambiguousWithoutContext = resolveTelegramConversationRoute({
  message: "y esas cifras de donde salen?",
  bindings: [binding],
  candidateCasesById: new Map([["case-1", operationalCase]]),
  explicitIntent: false,
});
assert.equal(ambiguousWithoutContext.route, "clarify");

// Con adjuntos, el contexto analítico NO desvía: un archivo es señal fuerte
// de que el mensaje pertenece al caso.
const attachmentDespiteAnalyticsContext = resolveTelegramConversationRoute({
  message: "aqui esta lo que me pediste",
  bindings: [binding],
  candidateCasesById: new Map([["case-1", operationalCase]]),
  explicitIntent: false,
  recentMessages: analyticsContextMessages,
  hasAttachments: true,
});
assert.equal(attachmentDespiteAnalyticsContext.route, "clarify");

// Regresión 2026-08-09: una continuación mensual breve conserva el contexto
// analítico y no debe disparar la asociación con un caso inmobiliario activo.
const analyticsMonthFollowUp = resolveTelegramConversationRoute({
  message: "y en julio?",
  bindings: [binding],
  candidateCasesById: new Map([["case-1", operationalCase]]),
  explicitIntent: false,
  recentMessages: [
    {
      id: "message-analytics",
      session_id: "session-1",
      role: "assistant",
      content:
        "En abril tuvimos 510 leads creados. Lo medimos en horario de México CDMX y considerando la inmobiliaria Alebrixe.",
      created_at: new Date().toISOString(),
    },
  ],
});
assert.equal(analyticsMonthFollowUp.route, "general");
if (analyticsMonthFollowUp.route === "general") {
  assert.equal(analyticsMonthFollowUp.reason, "analytics_period_followup");
}

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
