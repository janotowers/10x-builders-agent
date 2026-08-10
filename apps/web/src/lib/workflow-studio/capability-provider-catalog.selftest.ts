import assert from "node:assert/strict";
import type { AccountToolSecretPublic } from "@agents/types";
import {
  CAPABILITY_CATEGORIES,
  CAPABILITY_CATEGORY_IDS,
  CAPABILITY_PROVIDERS,
  PROVIDER_CAPABILITY_IDS,
  accountProviderIdsReferencedByCatalog,
  buildAuthoringCapabilityContext,
  configuredAccountProviderIds,
  detectCapabilityCategories,
  inferAuthoringInputRequirements,
  invocationChannelsFromSnapshot,
  isPerExecutionInputRequirement,
  resolveCapabilityCategory,
} from "./capability-provider-catalog";
import type { TenantProviderSnapshot } from "../tool-readiness/provider-readiness";

function snapshot(
  partial: Partial<TenantProviderSnapshot> = {}
): TenantProviderSnapshot {
  return {
    oauthIntegrations: [],
    accountSecretsByProvider: new Map<string, AccountToolSecretPublic>(),
    telegramLinked: false,
    ...partial,
  };
}

assert.equal(
  new Set(CAPABILITY_CATEGORIES.map((item) => item.id)).size,
  CAPABILITY_CATEGORIES.length,
  "category ids must be unique"
);
assert.deepEqual(
  new Set(CAPABILITY_CATEGORIES.map((item) => item.id)),
  new Set(CAPABILITY_CATEGORY_IDS),
  "every category id must have metadata"
);
assert.equal(
  new Set(CAPABILITY_PROVIDERS.map((item) => item.id)).size,
  CAPABILITY_PROVIDERS.length,
  "provider ids must be unique"
);

const capabilities = new Set(PROVIDER_CAPABILITY_IDS);
const categoryIds = new Set(CAPABILITY_CATEGORY_IDS);
for (const provider of CAPABILITY_PROVIDERS) {
  assert.ok(categoryIds.has(provider.categoryId));
  assert.ok(provider.capabilities.length > 0);
  assert.ok(
    provider.capabilities.every((capability) => capabilities.has(capability))
  );
  if (provider.maturity === "shipped") {
    assert.ok(
      provider.enablement !== "catalog_only",
      `${provider.id}: shipped provider must be enableable`
    );
    assert.ok(provider.readinessTest, `${provider.id}: readiness test required`);
  }
  if (provider.maturity === "candidate") {
    assert.ok(
      provider.officialDocsUrl,
      `${provider.id}: candidate requires an official reference`
    );
    assert.ok(
      provider.verifiedOn,
      `${provider.id}: candidate requires verification date`
    );
  }
}

const configuredProviders = configuredAccountProviderIds();
for (const id of accountProviderIdsReferencedByCatalog()) {
  assert.ok(
    configuredProviders.has(id),
    `${id}: account provider reference must exist`
  );
}

assert.deepEqual(
  detectCapabilityCategories([
    "Envía por correo un documento Word y después espera la respuesta.",
  ]),
  ["user_email"]
);
assert.deepEqual(detectCapabilityCategories(["Publica la propiedad en Ungga."]), [
  "listing_publication",
]);
assert.deepEqual(
  detectCapabilityCategories(["Consulta EasyBroker y avisa por Telegram."]),
  ["messaging", "real_estate_crm"]
);
assert.deepEqual(
  detectCapabilityCategories(["Prepara un mensaje cordial para el propietario."]),
  [],
  "mensaje genérico no implica ejecución por Telegram"
);
assert.deepEqual(
  detectCapabilityCategories([
    "El usuario inicia el trabajo desde Telegram y aprueba la propuesta por Telegram.",
  ]),
  [],
  "invocación y aprobación por Telegram no implican ejecución saliente"
);
assert.deepEqual(
  detectCapabilityCategories([
    "Cuando el usuario apruebe, notifica por Telegram al propietario.",
  ]),
  ["messaging"],
  "un envío saliente explícito por Telegram sí requiere mensajería"
);
assert.deepEqual(
  detectCapabilityCategories(["Consulta Gmail para encontrar el acuerdo vigente."]),
  [],
  "mencionar Gmail como fuente no implica la capacidad de envío"
);
assert.deepEqual(
  detectCapabilityCategories(["Gu envía un email al propietario."]),
  ["user_email"],
  "un email saliente explícito sí requiere un proveedor de correo"
);
assert.deepEqual(
  detectCapabilityCategories([
    "Envía el resultado por Telegram.",
    "Corrección: no uses Telegram; envíalo por email.",
  ]),
  ["user_email"],
  "la corrección más reciente elimina un canal de ejecución anterior"
);
assert.deepEqual(
  detectCapabilityCategories([
    "Gu envía el resultado por email y notifica por Telegram al propietario.",
    "Corrección: ya no envíes por email ni por Telegram; entrega solo un borrador.",
  ]),
  [],
  "la negación posterior recomputa y elimina ambos proveedores salientes"
);
assert.deepEqual(
  inferAuthoringInputRequirements([
    "Cada vez, el asesor adjunta un documento Word o TXT en el chat.",
  ]).map((requirement) => ({
    kind: requirement.kind,
    source_hint: requirement.source_hint,
  })),
  [{ kind: "runtime_input", source_hint: "chat_attachment" }]
);
assert.deepEqual(
  inferAuthoringInputRequirements([
    "Usa la plantilla reusable y la marca de agua de la cuenta.",
  ]).map((requirement) => requirement.kind),
  ["account_asset"]
);
assert.deepEqual(
  inferAuthoringInputRequirements([
    "Usa una plantilla Word.",
    "Corrección: el Word se adjunta en cada ejecución; no es una plantilla permanente.",
  ]).map((requirement) => requirement.kind),
  ["runtime_input"]
);
assert.equal(
  isPerExecutionInputRequirement({
    kind: "human_input",
  }),
  true
);
for (const kind of ["generated_artifact", "integration", "tool"] as const) {
  assert.equal(
    isPerExecutionInputRequirement({ kind }),
    false,
    `${kind} no debe renderizarse como entrada por ejecución`
  );
}
assert.deepEqual(
  invocationChannelsFromSnapshot(snapshot()).map((channel) => channel.channel),
  ["web_chat"]
);
const linkedChannels = invocationChannelsFromSnapshot(
  snapshot({ telegramLinked: true })
);
assert.deepEqual(
  linkedChannels.map((channel) => channel.channel),
  ["web_chat", "telegram"]
);
assert.equal(linkedChannels[1]?.supports_text, true);
assert.equal(linkedChannels[1]?.supports_generic_attachments, true);
assert.ok(
  (linkedChannels[1]?.limitations ?? []).some((limitation) =>
    /\.xls.*\.xlsx/i.test(limitation)
  ),
  "Telegram channel metadata must disclose the legacy .xls exception"
);

{
  const context = buildAuthoringCapabilityContext({
    values: ["El usuario inicia y aprueba el trabajo desde Telegram."],
    snapshot: snapshot({ telegramLinked: false }),
  });
  assert.deepEqual(context.detectedCategories, []);
  assert.deepEqual(
    context.invocationChannels.map((channel) => channel.channel),
    ["web_chat"],
    "el transcript no puede declarar disponible un canal ausente del snapshot"
  );
}

{
  const resolution = resolveCapabilityCategory(
    "user_email",
    snapshot({
      oauthIntegrations: [{ provider: "gmail", status: "active" }],
    }),
    { authoringSessionId: "session 1" }
  );
  assert.equal(resolution.policy, "confirm_single_connected");
  assert.equal(resolution.recommendedProviderId, "gmail");
  assert.equal(resolution.providers[0]?.state, "connected");
}

{
  const resolution = resolveCapabilityCategory(
    "user_email",
    snapshot(),
    { authoringSessionId: "session-1" }
  );
  const gmail = resolution.providers.find((provider) => provider.id === "gmail");
  assert.equal(resolution.policy, "offer_connection");
  assert.equal(gmail?.state, "supported_not_connected");
  assert.match(gmail?.connectHref ?? "", /view=integrations/);
  assert.match(gmail?.connectHref ?? "", /return_to=/);
}

{
  const resolution = resolveCapabilityCategory(
    "real_estate_crm",
    snapshot()
  );
  assert.equal(resolution.policy, "offer_connection");
  assert.equal(resolution.recommendedProviderId, "easybroker");
  assert.ok(
    ["inmoapp", "tokko_broker", "alterestate", "wiggot"].every((id) =>
      resolution.providers.some(
        (provider) => provider.id === id && provider.state === "catalog_only"
      )
    )
  );
}

{
  const context = buildAuthoringCapabilityContext({
    values: ["Enviar un email al propietario usando el Word que suba."],
    snapshot: snapshot({
      oauthIntegrations: [{ provider: "gmail", status: "active" }],
    }),
  });
  assert.deepEqual(
    context.detectedCategories.map((category) => category.categoryId),
    ["user_email"]
  );
  assert.equal(
    context.detectedCategories[0]?.recommendedProviderId,
    "gmail"
  );
  assert.equal(context.inputRequirements[0]?.kind, "runtime_input");
  assert.equal(
    context.inputRequirements[0]?.source_hint,
    "chat_attachment"
  );
  assert.deepEqual(
    context.invocationChannels.map((channel) => channel.channel),
    ["web_chat"]
  );
}

{
  const ownerTranscript = [
    "Cada vez que prepares un mensaje de seguimiento para un propietario, resume el último acuerdo.",
    "El usuario inicia desde Telegram. El acuerdo está en un documento Word que adjunta en cada ejecución.",
    "Gu entrega un borrador para aprobación por Telegram y, si se aprueba, envía un email al propietario.",
  ];
  const context = buildAuthoringCapabilityContext({
    values: ownerTranscript,
    snapshot: snapshot({
      oauthIntegrations: [{ provider: "gmail", status: "active" }],
      telegramLinked: true,
    }),
  });
  assert.deepEqual(
    context.detectedCategories.map((category) => category.categoryId),
    ["user_email"],
    "owner transcript separates Telegram invocation/approval from Gmail execution"
  );
  assert.deepEqual(
    context.invocationChannels.map((channel) => channel.channel),
    ["web_chat", "telegram"],
    "available invocation channels come only from the tenant snapshot"
  );
  assert.deepEqual(
    context.inputRequirements.map((requirement) => requirement.kind),
    ["runtime_input"],
    "the owner document remains source evidence supplied per execution"
  );
  assert.ok(
    context.inputRequirements.every(
      (requirement) =>
        requirement.kind !== "tool" &&
        requirement.kind !== "integration" &&
        !/gmail/i.test(requirement.key) &&
        !/gmail/i.test(requirement.label)
    ),
    "Gmail execution must not appear as a runtime/input requirement"
  );
  assert.equal(
    context.invocationChannels.find((channel) => channel.channel === "telegram")
      ?.supports_generic_attachments,
    true
  );
  assert.match(
    context.invocationChannels.find((channel) => channel.channel === "telegram")
      ?.limitations.join(" ") ?? "",
    /\.xls.*\.xlsx/i
  );
}

{
  const context = buildAuthoringCapabilityContext({
    values: ["Gu notifica por Telegram al propietario."],
    snapshot: snapshot({ telegramLinked: true }),
  });
  assert.deepEqual(
    context.detectedCategories.map((category) => category.categoryId),
    ["messaging"]
  );
  assert.equal(
    context.detectedCategories[0]?.recommendedProviderId,
    "telegram_bot"
  );
  assert.equal(context.detectedCategories[0]?.providers[0]?.state, "connected");
}

console.log("capability-provider-catalog.selftest: ok");
