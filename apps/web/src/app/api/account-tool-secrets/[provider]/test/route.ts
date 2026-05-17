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
import { createClient } from "@/lib/supabase/server";
import {
  createServerClient,
  getAccountToolSecretForRuntime,
  shipGlobalToolRequestsForTools,
  updateAccountToolSecretStatus,
} from "@agents/db";
import { getAccountToolProvider } from "@/lib/account-tool-providers";

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
    } else if (provider === "ungga_api") {
      result = await testUngga({
        apiBase: typeof stored.config.api_base === "string" ? stored.config.api_base : "",
        apiToken: (stored.secret as { api_token?: string }).api_token ?? "",
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

/**
 * Ungga API interna: convención del POC es exponer
 * `{apiBase}/v1/internal/listings`. No tenemos endpoint `/health` estable,
 * así que hacemos un GET ahí y aceptamos cualquier respuesta sub-500 que
 * NO sea 401/403 como evidencia de que el host está vivo y autenticado
 * (incluyendo 405 Method Not Allowed, que es lo esperable para un GET
 * sobre un endpoint POST).
 */
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
