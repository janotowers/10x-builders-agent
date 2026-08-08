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
  ["user_email", "document_storage"]
);
assert.deepEqual(detectCapabilityCategories(["Publica la propiedad en Ungga."]), [
  "listing_publication",
]);
assert.deepEqual(
  detectCapabilityCategories(["Consulta EasyBroker y avisa por Telegram."]),
  ["messaging", "real_estate_crm"]
);

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
    ["user_email", "document_storage"]
  );
  assert.equal(
    context.detectedCategories[0]?.recommendedProviderId,
    "gmail"
  );
}

console.log("capability-provider-catalog.selftest: ok");
