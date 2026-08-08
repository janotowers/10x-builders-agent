/**
 * Loader server-only del snapshot de providers del tenant.
 * No importar desde client components.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import {
  getUserIntegrations,
  listAccountToolSecretsPublic,
  type DbClient,
} from "@agents/db";
import type { AccountToolSecretPublic } from "@agents/types";
import type { TenantProviderSnapshot } from "@/lib/tool-readiness/provider-readiness";

function resolveLocalUnggaCliDir(): string | undefined {
  const configured = process.env.UNGGA_CLI_DIR?.trim();
  if (configured) return configured;
  const cwd = process.cwd();
  const candidates = [
    path.resolve(cwd, "pocs", "ungga-cli"),
    path.resolve(cwd, "..", "pocs", "ungga-cli"),
    path.resolve(cwd, "..", "..", "pocs", "ungga-cli"),
  ];
  return candidates.find((candidate) =>
    existsSync(path.join(candidate, "src", "publish-listing.mjs"))
  );
}

function localUnggaCliEnvAvailable(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  const pocDir = resolveLocalUnggaCliDir();
  return Boolean(pocDir && existsSync(path.join(pocDir, ".env")));
}

/** Flags booleanos derivados de process.env (nunca valores secretos). */
export function deploymentEnvFlagsFromProcessEnv(): Record<string, boolean> {
  const easybrokerWeb = Boolean(
    process.env.EASYBROKER_WEB_EMAIL?.trim() &&
      process.env.EASYBROKER_WEB_PASSWORD?.trim()
  );
  const easybrokerApi = Boolean(process.env.EASYBROKER_API_KEY?.trim());
  const ungga = Boolean(
    (process.env.UNGGA_INTERNAL_API_BASE?.trim() &&
      process.env.UNGGA_INTERNAL_API_TOKEN?.trim()) ||
      (process.env.UNGGA_CLI_ENABLED?.trim().toLowerCase() === "true" &&
        ((process.env.UNGGA_STAGING_URL?.trim() &&
          process.env.UNGGA_STAGING_EMAIL?.trim() &&
          process.env.UNGGA_STAGING_PASSWORD?.trim()) ||
          localUnggaCliEnvAvailable())) ||
      localUnggaCliEnvAvailable()
  );
  const avaclick = Boolean(
    process.env.AVACLICK_COMPANY_NAME?.trim() &&
      process.env.AVACLICK_EMAIL?.trim() &&
      process.env.AVACLICK_PASSWORD?.trim()
  );
  const maps = Boolean(process.env.GOOGLE_MAPS_API_KEY?.trim());
  const openrouter = Boolean(process.env.OPENROUTER_API_KEY?.trim());

  return {
    "catalog:easybroker_web": easybrokerWeb,
    "catalog:easybroker": easybrokerApi,
    "catalog:ungga": ungga,
    "catalog:avaclick": avaclick,
    "tool:easybroker_search_listings": easybrokerWeb,
    "tool:easybroker_search_closed_deals": easybrokerWeb,
    "tool:easybroker_create_listing": easybrokerApi,
    "tool:easybroker_upload_images": easybrokerApi,
    "tool:ungga_publish_listing": ungga,
    "tool:get_avaclick_valuation": avaclick,
    "tool:geocode_property_address": maps,
    "tool:lookup_property_surroundings": maps,
    "tool:analyze_property_images": openrouter,
    "tool:prepare_listing_description_draft": openrouter,
  };
}

async function loadTelegramLinked(
  db: DbClient,
  userId: string
): Promise<boolean> {
  const { data, error } = await db
    .from("telegram_accounts")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) return false;
  return Boolean(data);
}

export async function loadTenantProviderSnapshot(
  db: DbClient,
  userId: string,
  options?: { includeDeploymentEnv?: boolean }
): Promise<TenantProviderSnapshot> {
  const [integrations, toolSecrets, telegramLinked] = await Promise.all([
    getUserIntegrations(db, userId).catch(() => []),
    listAccountToolSecretsPublic(db, userId).catch(
      () => [] as AccountToolSecretPublic[]
    ),
    loadTelegramLinked(db, userId),
  ]);

  const accountSecretsByProvider = new Map<string, AccountToolSecretPublic>();
  for (const secret of toolSecrets) {
    accountSecretsByProvider.set(secret.provider, secret);
  }

  return {
    oauthIntegrations: integrations.map((integration) => ({
      provider: integration.provider,
      status: integration.status,
    })),
    accountSecretsByProvider,
    telegramLinked,
    deploymentEnv: options?.includeDeploymentEnv
      ? deploymentEnvFlagsFromProcessEnv()
      : undefined,
  };
}
