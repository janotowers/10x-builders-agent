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
    snapshot: snapshot({ telegramLinked: false }),
  });
  assert.deepEqual(
    context.availableCategories.map((category) => category.categoryId),
    CAPABILITY_CATEGORY_IDS,
    "el contexto expone catálogo/tenant sin interpretar el transcript"
  );
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
    snapshot: snapshot({
      oauthIntegrations: [{ provider: "gmail", status: "active" }],
    }),
  });
  const email = context.availableCategories.find(
    (category) => category.categoryId === "user_email"
  );
  assert.equal(
    email?.recommendedProviderId,
    "gmail"
  );
  assert.deepEqual(
    context.invocationChannels.map((channel) => channel.channel),
    ["web_chat"]
  );
}

{
  const context = buildAuthoringCapabilityContext({
    snapshot: snapshot({
      oauthIntegrations: [{ provider: "gmail", status: "active" }],
      telegramLinked: true,
    }),
  });
  assert.equal(
    context.availableCategories.find(
      (category) => category.categoryId === "user_email"
    )?.providers.find((provider) => provider.id === "gmail")?.state,
    "connected"
  );
  assert.deepEqual(
    context.invocationChannels.map((channel) => channel.channel),
    ["web_chat", "telegram"],
    "available invocation channels come only from the tenant snapshot"
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
    snapshot: snapshot({ telegramLinked: true }),
  });
  const messaging = context.availableCategories.find(
    (category) => category.categoryId === "messaging"
  );
  assert.equal(
    messaging?.recommendedProviderId,
    "telegram_bot"
  );
  assert.equal(messaging?.providers[0]?.state, "connected");
}

console.log("capability-provider-catalog.selftest: ok");
