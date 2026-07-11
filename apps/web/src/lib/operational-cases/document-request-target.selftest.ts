import assert from "node:assert/strict";
import {
  hasOperationalCaseVerifiedExternalContact,
  resolveOperationalCaseDocumentRequestTarget,
} from "@agents/types";
import type { OperationalCase } from "@agents/types";
import {
  buildCaseDocumentRequestTargetPrompt,
  buildDocumentRouteConfirmationAck,
  buildOperationalCaseContinuationReprompt,
  isInternalMediaCollectionCase,
  isInternalPhotosCollectionCase,
  messageLooksLikeDocumentTargetChoice,
  parseCaseDocumentRequestTargetChoice,
  shouldPromptCaseDocumentRequestTarget,
} from "./document-request-target";

assert.equal(
  resolveOperationalCaseDocumentRequestTarget({
    externalContact: {},
    context: {},
  }),
  "internal_user"
);

assert.equal(
  hasOperationalCaseVerifiedExternalContact({
    externalContact: {
      channel: "telegram",
      chat_id: 1213727697,
    },
    context: {},
  }),
  true
);

assert.equal(
  resolveOperationalCaseDocumentRequestTarget({
    externalContact: {
      channel: "telegram",
      chat_id: 1213727697,
    },
    context: {},
  }),
  "external_contact"
);

assert.equal(
  resolveOperationalCaseDocumentRequestTarget({
    externalContact: {
      channel: "telegram",
      chat_id: 1213727697,
    },
    context: {
      document_request_target: "internal_user",
    },
  }),
  "internal_user"
);

const conversationalAwaitingDocs = (
  context: Record<string, unknown>,
  external_contact_jsonb: Record<string, unknown> = {}
) =>
  ({
    id: "c1",
    user_id: "u1",
    case_type: "property_optioning",
    current_step: "awaiting_documents",
    context_jsonb: {
      created_from: "agent_conversation",
      ...context,
    },
    external_contact_jsonb,
    version: 1,
    status: "active",
  }) as unknown as OperationalCase;

assert.equal(
  shouldPromptCaseDocumentRequestTarget(
    conversationalAwaitingDocs({}, { channel: "telegram", chat_id: 12345 })
  ),
  true
);
assert.equal(
  shouldPromptCaseDocumentRequestTarget(
    conversationalAwaitingDocs(
      { document_request_target: "internal_user" },
      { channel: "telegram", chat_id: 12345 }
    )
  ),
  false
);

assert.equal(
  parseCaseDocumentRequestTargetChoice({
    opCase: conversationalAwaitingDocs({}, { channel: "telegram", chat_id: 12345 }),
    message: "interno",
  }).target,
  "internal_user"
);
assert.equal(
  parseCaseDocumentRequestTargetChoice({
    opCase: conversationalAwaitingDocs({}, { channel: "telegram", chat_id: 12345 }),
    message: "externo",
  }).target,
  "external_contact"
);
assert.equal(
  parseCaseDocumentRequestTargetChoice({
    opCase: conversationalAwaitingDocs({}, { channel: "telegram", chat_id: 12345 }),
    message: "ambos",
  }).reason,
  "both_not_supported"
);

// messageLooksLikeDocumentTargetChoice: gate barato para enrutar la respuesta
// interno/externo al caso correcto antes del routing genérico.
for (const positive of [
  "interno",
  "Interno",
  "INTERNO",
  "externo",
  "ambos",
  "los dos",
  "que lo suba el dueño",
  "se lo pido al propietario",
  "que suba el equipo interno",
]) {
  assert.equal(
    messageLooksLikeDocumentTargetChoice(positive),
    true,
    `esperaba choice para: ${positive}`
  );
}
for (const negative of [
  "",
  "1",
  "Casa en venta en Las Fuentes",
  "quiero opcionar otra propiedad",
  "listo",
  "¿cuántos leads tuvimos?",
]) {
  assert.equal(
    messageLooksLikeDocumentTargetChoice(negative),
    false,
    `no esperaba choice para: ${negative}`
  );
}

// El prompt post-intake explica los documentos ANTES de preguntar quién los
// aporta, y ofrece interno/externo cuando hay contacto externo verificado.
const promptWithExternal = buildCaseDocumentRequestTargetPrompt(
  conversationalAwaitingDocs({}, { channel: "telegram", chat_id: 12345 })
);
assert.ok(promptWithExternal.includes("Sobre [Real]"));
assert.ok(promptWithExternal.includes("necesito estos documentos"));
assert.ok(/escritura/i.test(promptWithExternal));
assert.ok(promptWithExternal.includes("indispensable"));
assert.ok(promptWithExternal.includes("«interno»"));
assert.ok(promptWithExternal.includes("«externo»"));

// Sin contacto externo verificado, el prompt sigue ofreciendo interno/externo:
// si el asesor elige externo, el subflujo posterior vincula al contacto.
const promptInternalOnly = buildCaseDocumentRequestTargetPrompt(
  conversationalAwaitingDocs({})
);
assert.ok(/escritura/i.test(promptInternalOnly));
assert.ok(promptInternalOnly.includes("«interno»"));
assert.ok(promptInternalOnly.includes("«externo»"));
assert.ok(/enlace/i.test(promptInternalOnly));

// Acuse de confirmación de ruta: copy base no menciona un canal concreto; la
// variante por canal aclara dónde subir; siempre recuerda "listo".
const internalWebAck = buildDocumentRouteConfirmationAck({
  target: "internal_user",
  channel: "web",
});
assert.ok(internalWebAck.startsWith("Perfecto."));
assert.ok(internalWebAck.includes("«listo»"));
assert.ok(internalWebAck.includes("este chat"));
assert.ok(!/telegram/i.test(internalWebAck));
assert.ok(!/equipo interno/i.test(internalWebAck));

const internalTelegramAck = buildDocumentRouteConfirmationAck({
  target: "internal_user",
  channel: "telegram",
});
assert.ok(internalTelegramAck.includes("«listo»"));
assert.ok(internalTelegramAck.includes("aquí mismo"));

const externalAck = buildDocumentRouteConfirmationAck({
  target: "external_contact",
  channel: "telegram",
});
assert.ok(/due[nñ]o|contacto/i.test(externalAck));

// buildOperationalCaseContinuationReprompt: re-expresar intención de inicio
// sobre un caso ya pasado de intake NO debe pedir datos de intake; debe
// reconfirmar el estado del caso y la acción esperada del paso actual.
const continuationInternal = buildOperationalCaseContinuationReprompt(
  conversationalAwaitingDocs({ document_request_target: "internal_user" })
);
assert.ok(continuationInternal.includes("ya está registrado"));
assert.ok(/escritura/i.test(continuationInternal));
assert.ok(continuationInternal.includes("«listo»"));
// Nunca debe pedir los campos de intake (título/zona/operación/tipo).
assert.ok(
  !/Título \/ propiedad:|Zona \/ colonia:|Operación aplicable:|Tipo de propiedad:/.test(
    continuationInternal
  ),
  "no debe re-pedir campos de intake en un caso ya registrado"
);

const continuationExternal = buildOperationalCaseContinuationReprompt(
  conversationalAwaitingDocs(
    { document_request_target: "external_contact" },
    { channel: "telegram", chat_id: 12345 }
  )
);
assert.ok(continuationExternal.includes("ya está registrado"));
assert.ok(/contacto externo/i.test(continuationExternal));

// Sin destino elegido todavía: re-pregunta interno/externo (no campos intake).
const continuationNoTarget = buildOperationalCaseContinuationReprompt(
  conversationalAwaitingDocs({}, { channel: "telegram", chat_id: 12345 })
);
assert.ok(continuationNoTarget.includes("«interno»"));
assert.ok(continuationNoTarget.includes("«externo»"));

const photosCase = {
  id: "photos-1",
  user_id: "u1",
  case_type: "property_optioning",
  current_step: "photos_requested",
  status: "waiting_internal",
  context_jsonb: {
    created_from: "agent_conversation",
    e2e_controlled: true,
  },
  version: 1,
} as unknown as OperationalCase;

assert.equal(isInternalPhotosCollectionCase(photosCase), true);
assert.equal(isInternalMediaCollectionCase(photosCase), true);
assert.equal(
  isInternalPhotosCollectionCase(
    conversationalAwaitingDocs({ document_request_target: "internal_user" })
  ),
  false
);
assert.equal(
  isInternalMediaCollectionCase(
    conversationalAwaitingDocs({ document_request_target: "internal_user" })
  ),
  true
);
assert.equal(
  isInternalMediaCollectionCase(
    conversationalAwaitingDocs({ document_request_target: "external_contact" })
  ),
  false
);
assert.equal(
  isInternalPhotosCollectionCase({
    ...photosCase,
    status: "paused",
  } as unknown as OperationalCase),
  false
);

console.log("document-request-target.selftest: ok");
