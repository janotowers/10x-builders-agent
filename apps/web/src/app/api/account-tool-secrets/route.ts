/**
 * GET /api/account-tool-secrets
 *   Devuelve los registros del usuario autenticado (sin secretos).
 *   Útil para que Ajustes y la pantalla de Casos de uso muestren qué
 *   conexiones por cuenta están activas.
 *
 *   También devuelve el catálogo de providers configurables para que la UI
 *   sepa qué formularios renderizar sin tener que duplicar la spec.
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServerClient, listAccountToolSecretsPublic } from "@agents/db";
import { ACCOUNT_TOOL_PROVIDERS } from "@/lib/account-tool-providers";

export async function GET() {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const db = createServerClient();
    const secrets = await listAccountToolSecretsPublic(db, user.id);
    return NextResponse.json({
      ok: true,
      secrets,
      providers: ACCOUNT_TOOL_PROVIDERS,
    });
  } catch (err) {
    console.error("[GET /api/account-tool-secrets] failed:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
