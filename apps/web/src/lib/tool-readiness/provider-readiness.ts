/**
 * Resolver puro de readiness de providers/integraciones.
 *
 * Compartido entre el lab (`/api/tool-readiness`) y Studio
 * (`buildCapabilityCatalogsForUser`). No importa routes ni componentes.
 *
 * Seguridad: solo metadatos públicos de secretos + flags booleanos de env.
 */

import type {
  AccountToolSecretPublic,
  AccountToolSecretStatus,
  ToolDefinition,
} from "@agents/types";
import {
  TOOL_TO_ACCOUNT_PROVIDER,
  UNGGA_PUBLISH_ACCOUNT_PROVIDERS,
  alternativeAccountProvidersForCatalogIntegration,
  catalogIntegrationsForAccountProvider,
  accountProviderForTool,
} from "@/lib/account-tool-providers";

export type ProviderSatisfactionSource =
  | "oauth_active"
  | "telegram_linked"
  | "account_secret_active"
  | "account_secret_operational_invalid"
  | "deployment_env";

export type TenantOAuthIntegration = {
  provider: string;
  status: string;
};

export type TenantProviderSnapshot = {
  oauthIntegrations: ReadonlyArray<TenantOAuthIntegration>;
  accountSecretsByProvider: ReadonlyMap<string, AccountToolSecretPublic>;
  telegramLinked: boolean;
  /** Flags booleanos inyectados por el loader; nunca valores de secretos. */
  deploymentEnv?: Readonly<Record<string, boolean>>;
};

export type ProviderResolution = {
  catalogProvider: string;
  satisfied: boolean;
  source?: ProviderSatisfactionSource;
  accountProviderId?: string;
  secretStatus?: AccountToolSecretStatus;
};

export function isEasyBrokerWebOperationalFailure(
  lastError: string | null | undefined
): boolean {
  if (!lastError) return false;
  return /command failed|playwright|browser|timeout|storage-state|sesión|session|selector|formulario|captcha|mfa/i.test(
    lastError
  );
}

export function unggaPublishAccountState(
  accountSecretsByProvider: ReadonlyMap<string, AccountToolSecretPublic>
): {
  providerId: (typeof UNGGA_PUBLISH_ACCOUNT_PROVIDERS)[number];
  secret: AccountToolSecretPublic | null;
  satisfied: boolean;
} {
  for (const providerId of UNGGA_PUBLISH_ACCOUNT_PROVIDERS) {
    const secret = accountSecretsByProvider.get(providerId) ?? null;
    if (secret?.status === "active") {
      return { providerId, secret, satisfied: true };
    }
  }
  for (const providerId of UNGGA_PUBLISH_ACCOUNT_PROVIDERS) {
    const secret = accountSecretsByProvider.get(providerId) ?? null;
    if (secret) {
      return { providerId, secret, satisfied: false };
    }
  }
  return {
    providerId: "ungga_cli",
    secret: null,
    satisfied: false,
  };
}

export function isCatalogIntegrationSatisfied(
  catalogProvider: string,
  snapshot: TenantProviderSnapshot,
  options?: { includeDeploymentEnv?: boolean }
): ProviderResolution {
  if (
    catalogProvider === "telegram_bot" &&
    snapshot.telegramLinked
  ) {
    return {
      catalogProvider,
      satisfied: true,
      source: "telegram_linked",
    };
  }

  const oauthHit = snapshot.oauthIntegrations.find(
    (item) => item.provider === catalogProvider && item.status === "active"
  );
  if (oauthHit) {
    return {
      catalogProvider,
      satisfied: true,
      source: "oauth_active",
    };
  }

  const accountProviders =
    alternativeAccountProvidersForCatalogIntegration(catalogProvider);
  if (catalogProvider === "ungga" || accountProviders.length > 1) {
    const ungga = unggaPublishAccountState(snapshot.accountSecretsByProvider);
    if (ungga.satisfied && ungga.secret) {
      return {
        catalogProvider,
        satisfied: true,
        source: "account_secret_active",
        accountProviderId: ungga.providerId,
        secretStatus: ungga.secret.status,
      };
    }
  }

  for (const providerId of accountProviders.length > 0
    ? accountProviders
    : [catalogProvider]) {
    const secret = snapshot.accountSecretsByProvider.get(providerId);
    if (!secret) continue;
    if (secret.status === "active") {
      return {
        catalogProvider,
        satisfied: true,
        source: "account_secret_active",
        accountProviderId: providerId,
        secretStatus: secret.status,
      };
    }
    if (
      providerId === "easybroker_web" &&
      secret.status === "invalid" &&
      isEasyBrokerWebOperationalFailure(secret.last_error)
    ) {
      return {
        catalogProvider,
        satisfied: true,
        source: "account_secret_operational_invalid",
        accountProviderId: providerId,
        secretStatus: secret.status,
      };
    }
  }

  if (options?.includeDeploymentEnv && snapshot.deploymentEnv) {
    const envKey = `catalog:${catalogProvider}`;
    const toolKeys = Object.keys(snapshot.deploymentEnv).filter((key) =>
      key.startsWith("tool:")
    );
    if (snapshot.deploymentEnv[envKey]) {
      return {
        catalogProvider,
        satisfied: true,
        source: "deployment_env",
      };
    }
    // También aceptar flags por tool que mapean a este catalog provider.
    for (const toolKey of toolKeys) {
      if (!snapshot.deploymentEnv[toolKey]) continue;
      const toolId = toolKey.slice("tool:".length);
      const accountProvider = accountProviderForTool(toolId);
      const catalogs = accountProvider
        ? catalogIntegrationsForAccountProvider(accountProvider)
        : [];
      if (
        catalogs.includes(catalogProvider) ||
        toolRequiresCatalogIntegration(toolId, catalogProvider)
      ) {
        return {
          catalogProvider,
          satisfied: true,
          source: "deployment_env",
          accountProviderId: accountProvider ?? undefined,
        };
      }
    }
  }

  return { catalogProvider, satisfied: false };
}

function toolRequiresCatalogIntegration(
  toolId: string,
  catalogProvider: string
): boolean {
  // Sin TOOL_CATALOG aquí: el loader puede precomputar flags `catalog:`.
  void toolId;
  void catalogProvider;
  return false;
}

export function resolveProviderForTool(
  toolId: string,
  def: Pick<ToolDefinition, "requires_integration"> | undefined,
  snapshot: TenantProviderSnapshot,
  options?: { includeDeploymentEnv?: boolean }
): ProviderResolution | null {
  const catalogProvider = def?.requires_integration ?? null;
  if (!catalogProvider) {
    // Tools con account provider implícito (p. ej. ungga) siguen resolviendo.
    const accountProvider = TOOL_TO_ACCOUNT_PROVIDER[toolId];
    if (!accountProvider) return null;
    const catalogs = catalogIntegrationsForAccountProvider(accountProvider);
    return isCatalogIntegrationSatisfied(catalogs[0] ?? accountProvider, snapshot, options);
  }
  return isCatalogIntegrationSatisfied(catalogProvider, snapshot, options);
}

/**
 * Set que consume `resolveCapabilityMap` / Studio.
 * Normaliza aliases (`ungga_cli` → también `ungga`) y Telegram.
 */
export function buildConnectedCatalogIntegrations(
  snapshot: TenantProviderSnapshot,
  options?: { includeDeploymentEnv?: boolean }
): Set<string> {
  const connected = new Set<string>();

  for (const integration of snapshot.oauthIntegrations) {
    if (integration.status === "active") {
      connected.add(integration.provider);
    }
  }

  if (snapshot.telegramLinked) {
    connected.add("telegram_bot");
  }

  for (const [providerId, secret] of snapshot.accountSecretsByProvider) {
    if (secret.status !== "active") {
      if (
        providerId === "easybroker_web" &&
        secret.status === "invalid" &&
        isEasyBrokerWebOperationalFailure(secret.last_error)
      ) {
        for (const key of catalogIntegrationsForAccountProvider(providerId)) {
          connected.add(key);
        }
      }
      continue;
    }
    for (const key of catalogIntegrationsForAccountProvider(providerId)) {
      connected.add(key);
    }
  }

  if (options?.includeDeploymentEnv && snapshot.deploymentEnv) {
    for (const [key, ok] of Object.entries(snapshot.deploymentEnv)) {
      if (!ok) continue;
      if (key.startsWith("catalog:")) {
        connected.add(key.slice("catalog:".length));
      }
    }
  }

  return connected;
}

export function providerSatisfactionLabel(
  resolution: ProviderResolution
): string | null {
  if (!resolution.satisfied || !resolution.source) return null;
  switch (resolution.source) {
    case "telegram_linked":
      return "Disponible vía Telegram vinculado";
    case "oauth_active":
      return `Disponible vía OAuth (${resolution.catalogProvider})`;
    case "account_secret_active":
      return resolution.accountProviderId
        ? `Disponible vía credencial ${resolution.accountProviderId}`
        : "Disponible vía credencial de cuenta";
    case "account_secret_operational_invalid":
      return "Disponible (credencial con fallo operativo recuperable)";
    case "deployment_env":
      return "Disponible vía configuración del entorno";
  }
}

export {
  TOOL_TO_ACCOUNT_PROVIDER,
  UNGGA_PUBLISH_ACCOUNT_PROVIDERS,
  accountProviderForTool,
};
