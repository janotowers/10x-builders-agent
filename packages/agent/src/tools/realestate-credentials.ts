/**
 * Resolución de credenciales para tools inmobiliarias (EasyBroker, Ungga).
 *
 * Política V1:
 *   1. Si la cuenta del usuario tiene un secret per-account guardado en
 *      `account_tool_secrets` con `status='active'` o `status='pending_test'`,
 *      se usa ese (Phase 2b). El `pending_test` cuenta porque el adapter
 *      sirve también como validador implícito: si la API contesta OK, el
 *      endpoint de test actualizará el status a `active`.
 *   2. Fallback: variables de entorno globales (EASYBROKER_API_KEY,
 *      UNGGA_INTERNAL_API_BASE / UNGGA_INTERNAL_API_TOKEN). Esto mantiene
 *      compat con la instalación legacy y permite que el equipo de Ungga
 *      siga usando credenciales globales mientras la mayoría de usuarios
 *      migran a per-account.
 *
 * Nota: estas funciones NUNCA se exportan al cliente. Sólo viajan dentro
 * del runtime de tools, que corre server-side.
 */
import { getAccountToolSecretForRuntime } from "@agents/db";
import type { ToolContext } from "./tool-context";

const EASYBROKER_PROVIDER = "easybroker";
const EASYBROKER_WEB_PROVIDER = "easybroker_web";
const UNGGA_API_PROVIDER = "ungga_api";
const UNGGA_CLI_PROVIDER = "ungga_cli";
const EASYBROKER_WEB_LOGIN_URL =
  "https://www.easybroker.com/mx/account/authentication/new";

export interface EasyBrokerCredentials {
  apiKey: string;
  /** Origen para diagnóstico/logs. */
  source: "account" | "env";
}

export interface EasyBrokerWebCredentials {
  loginUrl: string;
  email: string;
  password: string;
  source: "account" | "env";
}

export interface UnggaCredentials {
  apiBase: string;
  apiToken: string;
  source: "account" | "env";
}

export interface UnggaCliCredentials {
  loginUrl: string;
  email: string;
  password: string;
  source: "account" | "env";
}

/**
 * Devuelve la API key de EasyBroker resolviendo per-account → env.
 * Devuelve `null` cuando no hay credencial disponible.
 */
export async function resolveEasyBrokerCredentials(
  ctx: ToolContext
): Promise<EasyBrokerCredentials | null> {
  try {
    const accountSecret = await getAccountToolSecretForRuntime<{
      api_key?: string;
    }>(ctx.db, { userId: ctx.userId, provider: EASYBROKER_PROVIDER });
    const apiKeyFromAccount = accountSecret?.secret?.api_key?.trim();
    if (apiKeyFromAccount) {
      return { apiKey: apiKeyFromAccount, source: "account" };
    }
  } catch (err) {
    // El fallback a env igualmente cubre operación legacy; loguear y seguir.
    console.warn(
      "[realestate-credentials] EasyBroker per-account lookup failed:",
      err
    );
  }

  const envKey = process.env.EASYBROKER_API_KEY?.trim();
  if (envKey) return { apiKey: envKey, source: "env" };
  return null;
}

/**
 * Credenciales de login web para buscar en EasyBroker MLS/bolsa inmobiliaria.
 * Se mantienen separadas de la API key porque la API sirve para inventario
 * propio/write, mientras MLS requiere sesión web.
 */
export async function resolveEasyBrokerWebCredentials(
  ctx: ToolContext
): Promise<EasyBrokerWebCredentials | null> {
  try {
    const accountSecret = await getAccountToolSecretForRuntime<{
      email?: string;
      password?: string;
    }>(ctx.db, { userId: ctx.userId, provider: EASYBROKER_WEB_PROVIDER });
    const email = accountSecret?.secret?.email?.trim();
    const password = accountSecret?.secret?.password?.trim();
    if (email && password) {
      return {
        loginUrl: EASYBROKER_WEB_LOGIN_URL,
        email,
        password,
        source: "account",
      };
    }
  } catch (err) {
    console.warn(
      "[realestate-credentials] EasyBroker web per-account lookup failed:",
      err
    );
  }

  const loginUrl =
    process.env.EASYBROKER_WEB_URL?.trim() ||
    EASYBROKER_WEB_LOGIN_URL;
  const email = process.env.EASYBROKER_WEB_EMAIL?.trim();
  const password = process.env.EASYBROKER_WEB_PASSWORD?.trim();
  if (email && password) {
    return { loginUrl, email, password, source: "env" };
  }
  return null;
}

/**
 * Devuelve `api_base` + `api_token` para la API interna de Ungga,
 * resolviendo per-account → env. Devuelve `null` si falta alguno.
 */
export async function resolveUnggaCredentials(
  ctx: ToolContext
): Promise<UnggaCredentials | null> {
  try {
    const accountSecret = await getAccountToolSecretForRuntime<{
      api_token?: string;
    }>(ctx.db, { userId: ctx.userId, provider: UNGGA_API_PROVIDER });
    const apiBaseFromAccount =
      typeof accountSecret?.config?.api_base === "string"
        ? accountSecret.config.api_base.trim()
        : "";
    const apiTokenFromAccount = accountSecret?.secret?.api_token?.trim();
    if (apiBaseFromAccount && apiTokenFromAccount) {
      return {
        apiBase: apiBaseFromAccount,
        apiToken: apiTokenFromAccount,
        source: "account",
      };
    }
  } catch (err) {
    console.warn(
      "[realestate-credentials] Ungga per-account lookup failed:",
      err
    );
  }

  const envBase = process.env.UNGGA_INTERNAL_API_BASE?.trim();
  const envToken = process.env.UNGGA_INTERNAL_API_TOKEN?.trim();
  if (envBase && envToken) {
    return { apiBase: envBase, apiToken: envToken, source: "env" };
  }
  return null;
}

/**
 * Credenciales de login web para el fallback Playwright (ungga_cli).
 * Resuelve per-account → env (UNGGA_STAGING_*).
 */
export async function resolveUnggaCliCredentials(
  ctx: ToolContext
): Promise<UnggaCliCredentials | null> {
  try {
    const accountSecret = await getAccountToolSecretForRuntime<{
      email?: string;
      password?: string;
    }>(ctx.db, { userId: ctx.userId, provider: UNGGA_CLI_PROVIDER });
    const loginUrl =
      typeof accountSecret?.config?.login_url === "string" &&
      accountSecret.config.login_url.trim()
        ? accountSecret.config.login_url.trim()
        : "https://ungga.com/login";
    const email = accountSecret?.secret?.email?.trim();
    const password = accountSecret?.secret?.password?.trim();
    if (email && password) {
      return { loginUrl, email, password, source: "account" };
    }
  } catch (err) {
    console.warn(
      "[realestate-credentials] Ungga CLI per-account lookup failed:",
      err
    );
  }

  const loginUrl = process.env.UNGGA_STAGING_URL?.trim();
  const email = process.env.UNGGA_STAGING_EMAIL?.trim();
  const password = process.env.UNGGA_STAGING_PASSWORD?.trim();
  if (loginUrl && email && password) {
    return { loginUrl, email, password, source: "env" };
  }
  return null;
}

/**
 * Marca el secret per-account como usado y, opcionalmente, lo promueve a
 * `active` si estaba `pending_test`. Llamar **después** de una request
 * exitosa contra la API externa. Si la credencial venía de env (no
 * per-account) o si no hay registro, esta función es no-op.
 *
 * Toleramos errores en silencio: actualizar metadata de uso no debe
 * romper el adapter aunque la DB esté lenta.
 */
export async function markAccountSecretSuccess(
  ctx: ToolContext,
  provider: string
): Promise<void> {
  try {
    const current = await ctx.db
      .from("account_tool_secrets")
      .select("status")
      .eq("user_id", ctx.userId)
      .eq("provider", provider)
      .maybeSingle();
    if (current.error) return;
    if (!current.data) return;
    const update: Record<string, unknown> = {
      last_used_at: new Date().toISOString(),
    };
    if (current.data.status === "pending_test") {
      update.status = "active";
      update.last_checked_at = new Date().toISOString();
      update.last_error = null;
    }
    await ctx.db
      .from("account_tool_secrets")
      .update(update)
      .eq("user_id", ctx.userId)
      .eq("provider", provider);
  } catch (err) {
    console.warn(
      "[realestate-credentials] markAccountSecretSuccess failed:",
      err
    );
  }
}

/** Idem `markAccountSecretSuccess` pero marca status=invalid con el error. */
export async function markAccountSecretFailure(
  ctx: ToolContext,
  provider: string,
  errorMessage: string
): Promise<void> {
  try {
    await ctx.db
      .from("account_tool_secrets")
      .update({
        status: "invalid",
        last_error: errorMessage.slice(0, 500),
        last_checked_at: new Date().toISOString(),
      })
      .eq("user_id", ctx.userId)
      .eq("provider", provider);
  } catch (err) {
    console.warn(
      "[realestate-credentials] markAccountSecretFailure failed:",
      err
    );
  }
}

export const ACCOUNT_TOOL_PROVIDERS_REALESTATE = {
  easybroker: EASYBROKER_PROVIDER,
  easybroker_web: EASYBROKER_WEB_PROVIDER,
  ungga_api: UNGGA_API_PROVIDER,
  ungga_cli: UNGGA_CLI_PROVIDER,
  /** @deprecated alias */
  ungga: UNGGA_API_PROVIDER,
} as const;
