/**
 * POST /api/account-tool-secrets/[provider]/test
 *
 * Valida la credencial cifrada haciendo un ping de bajo costo a la API
 * externa del provider. Sólo se prueba lo que está guardado: no se acepta
 * un payload con credenciales en el body (eso debe pasar primero por PUT).
 *
 * Resultado:
 *   - `{ ok: true, status: "active" }` y la fila queda marcada
 *     `status='active'`, `last_checked_at=now`, `last_error=null`.
 *   - `{ ok: false, status: "invalid", error: "<msg>" }` y la fila queda
 *     `status='invalid'` con `last_error`.
 *
 * Esta API NO devuelve la credencial descifrada al cliente; el secreto
 * sólo se usa server-side dentro de este handler.
 */
import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { createClient } from "@/lib/supabase/server";
import {
  createServerClient,
  getAccountToolSecretForRuntime,
  shipGlobalToolRequestsForTools,
  updateAccountToolSecretStatus,
} from "@agents/db";
import { getAccountToolProvider } from "@/lib/account-tool-providers";

const execFileAsync = promisify(execFile);
const EASYBROKER_WEB_LOGIN_URL =
  "https://www.easybroker.com/mx/account/authentication/new";

function resolveUnggaCliPocDir() {
  const configured = process.env.UNGGA_CLI_DIR?.trim();
  if (configured) return configured;
  const cwd = process.cwd();
  const candidates = [
    path.resolve(cwd, "pocs", "ungga-cli"),
    path.resolve(cwd, "..", "pocs", "ungga-cli"),
    path.resolve(cwd, "..", "..", "pocs", "ungga-cli"),
  ];
  return (
    candidates.find((candidate) =>
      existsSync(path.join(candidate, "src", "login.mjs"))
    ) ?? candidates[0]
  );
}

function resolveEasyBrokerMlsPocDir() {
  const configured = process.env.EASYBROKER_MLS_CLI_DIR?.trim();
  if (configured) return configured;
  const cwd = process.cwd();
  const candidates = [
    path.resolve(cwd, "pocs", "easybroker-mls-cli"),
    path.resolve(cwd, "..", "pocs", "easybroker-mls-cli"),
    path.resolve(cwd, "..", "..", "pocs", "easybroker-mls-cli"),
  ];
  return (
    candidates.find((candidate) =>
      existsSync(path.join(candidate, "src", "login.mjs"))
    ) ?? candidates[0]
  );
}

export async function POST(
  _request: Request,
  context: { params: Promise<{ provider: string }> }
) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { provider } = await context.params;
    const spec = getAccountToolProvider(provider);
    if (!spec) {
      return NextResponse.json(
        { error: `unknown provider: ${provider}` },
        { status: 404 }
      );
    }

    if (!process.env.ENCRYPTION_KEY) {
      return NextResponse.json(
        { error: "ENCRYPTION_KEY no configurado en el server" },
        { status: 500 }
      );
    }

    const db = createServerClient();
    const stored = await getAccountToolSecretForRuntime(db, {
      userId: user.id,
      provider,
    });
    if (!stored) {
      return NextResponse.json(
        { error: "No hay credenciales guardadas para este provider." },
        { status: 404 }
      );
    }

    let result: TestResult;
    if (provider === "easybroker") {
      result = await testEasyBroker(stored.secret as { api_key?: string });
    } else if (provider === "easybroker_web") {
      result = await testEasyBrokerWeb({
        loginUrl: EASYBROKER_WEB_LOGIN_URL,
        email: (stored.secret as { email?: string }).email ?? "",
        password: (stored.secret as { password?: string }).password ?? "",
      });
    } else if (provider === "ungga_api") {
      result = await testUngga({
        apiBase: typeof stored.config.api_base === "string" ? stored.config.api_base : "",
        apiToken: (stored.secret as { api_token?: string }).api_token ?? "",
      });
    } else if (provider === "ungga_cli") {
      const loginUrl =
        typeof stored.config.login_url === "string" && stored.config.login_url.trim()
          ? stored.config.login_url.trim()
          : "https://ungga.com/login";
      result = await testUnggaCli({
        loginUrl,
        email: (stored.secret as { email?: string }).email ?? "",
        password: (stored.secret as { password?: string }).password ?? "",
      });
    } else {
      // Provider declarado pero sin tester implementado todavía. Marca
      // pending_test y devuelve aviso explícito (no false positive).
      return NextResponse.json({
        ok: false,
        status: "pending_test",
        error: `Tester aún no implementado para provider "${provider}". Se guardaron las credenciales pero no se pueden validar automáticamente.`,
      });
    }

    const updated = await updateAccountToolSecretStatus(db, {
      userId: user.id,
      provider,
      status: result.ok ? "active" : "invalid",
      lastError: result.ok ? null : result.error,
      markChecked: true,
    });

    // Auto-ship: si la conexión es válida, las solicitudes abiertas para
    // las tools cubiertas por este provider quedan resueltas.
    let shippedCount = 0;
    if (result.ok && spec.appliesToTools.length) {
      try {
        shippedCount = await shipGlobalToolRequestsForTools(db, {
          userId: user.id,
          toolIds: spec.appliesToTools,
          adminNote: `Conexión per-cuenta para ${spec.displayName} validada por el usuario.`,
        });
      } catch (err) {
        // No bloqueamos la respuesta por esto; sólo logueamos.
        console.warn(
          "[POST /api/account-tool-secrets/:provider/test] ship requests failed:",
          err
        );
      }
    }

    return NextResponse.json({
      ok: result.ok,
      status: result.ok ? "active" : "invalid",
      error: result.ok ? null : result.error,
      secret: updated,
      shipped_requests: shippedCount,
    });
  } catch (err) {
    console.error("[POST /api/account-tool-secrets/:provider/test] failed:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

type TestResult = { ok: true } | { ok: false; error: string };

/**
 * EasyBroker usa el header `X-Authorization` con la API key. Probamos un
 * GET a `/v1/properties?limit=1` que es read-only y barato. La API
 * devuelve 401 si la key es inválida, 200 si está OK.
 *
 * Doc: https://www.easybroker.com/api/docs/index.html
 */
async function testEasyBroker(secret: { api_key?: string }): Promise<TestResult> {
  const apiKey = secret.api_key?.trim();
  if (!apiKey) return { ok: false, error: "api_key vacío" };
  try {
    const res = await fetch(
      "https://api.easybroker.com/v1/properties?limit=1",
      {
        method: "GET",
        headers: {
          accept: "application/json",
          "X-Authorization": apiKey,
        },
      }
    );
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: `EasyBroker rechazó la API key (HTTP ${res.status}).` };
    }
    return {
      ok: false,
      error: `EasyBroker respondió HTTP ${res.status} en /v1/properties.`,
    };
  } catch (e) {
    return {
      ok: false,
      error: `No se pudo contactar EasyBroker: ${(e as Error).message ?? String(e)}`,
    };
  }
}

async function testEasyBrokerWeb(input: {
  loginUrl: string;
  email: string;
  password: string;
}): Promise<TestResult> {
  const loginUrl = input.loginUrl.trim();
  const email = input.email.trim();
  const password = input.password.trim();
  if (!loginUrl) return { ok: false, error: "login_url vacío" };
  if (!email) return { ok: false, error: "email vacío" };
  if (!password) return { ok: false, error: "password vacío" };

  const pocDir = resolveEasyBrokerMlsPocDir();
  try {
    const { stdout } = await execFileAsync(process.execPath, ["src/login.mjs"], {
      cwd: pocDir,
      timeout: 90_000,
      maxBuffer: 2 * 1024 * 1024,
      env: {
        ...process.env,
        EASYBROKER_WEB_URL: loginUrl,
        EASYBROKER_WEB_EMAIL: email,
        EASYBROKER_WEB_PASSWORD: password,
        EASYBROKER_MLS_HEADLESS: process.env.EASYBROKER_MLS_HEADLESS ?? "false",
      },
    });
    const parsed = JSON.parse(stdout) as { ok?: boolean; error?: string };
    if (parsed.ok === true) return { ok: true };
    return {
      ok: false,
      error: parsed.error ?? "EasyBroker MLS login falló sin detalle.",
    };
  } catch (e) {
    const err = e as { stdout?: string; message?: string };
    if (err.stdout) {
      try {
        const parsed = JSON.parse(err.stdout) as { error?: string };
        if (parsed.error) return { ok: false, error: parsed.error };
      } catch {
        /* ignore */
      }
    }
    return {
      ok: false,
      error: `No se pudo validar EasyBroker MLS: ${err.message ?? String(e)}`,
    };
  }
}

/**
 * Ungga API interna: convención del POC es exponer
 * `{apiBase}/v1/internal/listings`. No tenemos endpoint `/health` estable,
 * así que hacemos un GET ahí y aceptamos cualquier respuesta sub-500 que
 * NO sea 401/403 como evidencia de que el host está vivo y autenticado
 * (incluyendo 405 Method Not Allowed, que es lo esperable para un GET
 * sobre un endpoint POST).
 */
/**
 * Valida credenciales web ejecutando el POC de login (Playwright headless).
 */
async function testUnggaCli(input: {
  loginUrl: string;
  email: string;
  password: string;
}): Promise<TestResult> {
  const loginUrl = input.loginUrl.trim();
  const email = input.email.trim();
  const password = input.password.trim();
  if (!loginUrl) return { ok: false, error: "login_url vacío" };
  if (!email) return { ok: false, error: "email vacío" };
  if (!password) return { ok: false, error: "password vacío" };

  const pocDir = resolveUnggaCliPocDir();
  if (!existsSync(path.join(pocDir, "src", "login.mjs"))) {
    return {
      ok: false,
      error: `POC Ungga CLI no encontrado en ${pocDir}.`,
    };
  }

  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["src/login.mjs"],
      {
        cwd: pocDir,
        timeout: 90_000,
        maxBuffer: 2 * 1024 * 1024,
        env: {
          ...process.env,
          UNGGA_CLI_HEADLESS: "true",
          UNGGA_STAGING_URL: loginUrl,
          UNGGA_STAGING_EMAIL: email,
          UNGGA_STAGING_PASSWORD: password,
        },
      }
    );
    const parsed = parseLoginMetrics(stdout);
    if (parsed.loginOk) return { ok: true };
    return {
      ok: false,
      error:
        parsed.error ??
        (stderr.trim().slice(0, 300) || "Login en Ungga falló (revisa correo/contraseña)."),
    };
  } catch (e) {
    const err = e as { message?: string; stderr?: string };
    return {
      ok: false,
      error: `No se pudo validar login Ungga: ${err.message ?? String(e)}${err.stderr ? ` — ${err.stderr.slice(0, 200)}` : ""}`,
    };
  }
}

function parseLoginMetrics(stdout: string): { loginOk: boolean; error?: string } {
  try {
    const start = stdout.indexOf("{");
    const end = stdout.lastIndexOf("}");
    if (start < 0 || end <= start) {
      return { loginOk: false, error: "Salida del POC sin JSON" };
    }
    const payload = JSON.parse(stdout.slice(start, end + 1)) as {
      metrics?: Array<{ step?: string; ok?: boolean; error?: string }>;
    };
    const loginStep = payload.metrics?.find((m) => m.step === "login");
    if (loginStep?.ok) return { loginOk: true };
    return {
      loginOk: false,
      error: loginStep?.error ?? "Paso login no reportó éxito",
    };
  } catch {
    return { loginOk: false, error: "No se pudo interpretar la salida del POC" };
  }
}

async function testUngga(input: {
  apiBase: string;
  apiToken: string;
}): Promise<TestResult> {
  const apiBase = input.apiBase.trim();
  const apiToken = input.apiToken.trim();
  if (!apiBase) return { ok: false, error: "api_base vacío" };
  if (!apiToken) return { ok: false, error: "api_token vacío" };
  try {
    const url = `${apiBase.replace(/\/$/, "")}/v1/internal/listings`;
    const res = await fetch(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        Authorization: `Bearer ${apiToken}`,
      },
    });
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        error: `Ungga rechazó el token (HTTP ${res.status}).`,
      };
    }
    if (res.status >= 500) {
      return {
        ok: false,
        error: `Ungga respondió ${res.status} en ${url}. Reintenta más tarde.`,
      };
    }
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      error: `No se pudo contactar Ungga: ${(e as Error).message ?? String(e)}`,
    };
  }
}
