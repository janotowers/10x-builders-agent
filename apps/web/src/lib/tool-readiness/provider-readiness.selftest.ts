import assert from "node:assert/strict";
import type { AccountToolSecretPublic } from "@agents/types";
import {
  buildConnectedCatalogIntegrations,
  isCatalogIntegrationSatisfied,
  resolveProviderForTool,
  type TenantProviderSnapshot,
} from "./provider-readiness";

function secret(
  provider: string,
  status: AccountToolSecretPublic["status"]
): AccountToolSecretPublic {
  return {
    id: `sec-${provider}`,
    user_id: "u1",
    provider,
    config_jsonb: {},
    status,
    last_checked_at: null,
    last_used_at: null,
    last_error: null,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
  };
}

function snapshot(
  partial: Partial<TenantProviderSnapshot> &
    Pick<TenantProviderSnapshot, "accountSecretsByProvider" | "telegramLinked">
): TenantProviderSnapshot {
  return {
    oauthIntegrations: [],
    ...partial,
  };
}

// Telegram
{
  const linked = snapshot({
    telegramLinked: true,
    accountSecretsByProvider: new Map(),
  });
  const unlinked = snapshot({
    telegramLinked: false,
    accountSecretsByProvider: new Map(),
  });
  assert.equal(
    isCatalogIntegrationSatisfied("telegram_bot", linked).satisfied,
    true
  );
  assert.equal(
    isCatalogIntegrationSatisfied("telegram_bot", unlinked).satisfied,
    false
  );
  assert.ok(
    buildConnectedCatalogIntegrations(linked).has("telegram_bot")
  );
}

// Ungga aliases
{
  for (const provider of ["ungga_cli", "ungga_api"] as const) {
    const snap = snapshot({
      telegramLinked: false,
      accountSecretsByProvider: new Map([
        [provider, secret(provider, "active")],
      ]),
    });
    const connected = buildConnectedCatalogIntegrations(snap);
    assert.ok(connected.has("ungga"), `${provider} must satisfy catalog ungga`);
    assert.ok(connected.has(provider));
    assert.equal(
      resolveProviderForTool(
        "ungga_publish_listing",
        { requires_integration: "ungga" },
        snap
      )?.satisfied,
      true
    );
  }

  const pending = snapshot({
    telegramLinked: false,
    accountSecretsByProvider: new Map([
      ["ungga_cli", secret("ungga_cli", "pending_test")],
    ]),
  });
  assert.equal(
    buildConnectedCatalogIntegrations(pending).has("ungga"),
    false,
    "pending_test no cuenta como conectado en Studio"
  );
}

// OAuth
{
  const snap = snapshot({
    telegramLinked: false,
    oauthIntegrations: [
      { provider: "google_calendar", status: "active" },
      { provider: "gmail", status: "active" },
      { provider: "github", status: "revoked" },
    ],
    accountSecretsByProvider: new Map(),
  });
  const connected = buildConnectedCatalogIntegrations(snap);
  assert.ok(connected.has("google_calendar"));
  assert.ok(connected.has("gmail"));
  assert.equal(connected.has("github"), false);
  assert.equal(
    resolveProviderForTool(
      "gmail_send_email",
      { requires_integration: "gmail" },
      snap
    )?.satisfied,
    true
  );
}

// Env solo cuando se pide
{
  const snap = snapshot({
    telegramLinked: false,
    accountSecretsByProvider: new Map(),
    deploymentEnv: { "catalog:ungga": true },
  });
  assert.equal(
    buildConnectedCatalogIntegrations(snap, { includeDeploymentEnv: false }).has(
      "ungga"
    ),
    false
  );
  assert.ok(
    buildConnectedCatalogIntegrations(snap, { includeDeploymentEnv: true }).has(
      "ungga"
    )
  );
}

console.log("provider-readiness.selftest: ok");
