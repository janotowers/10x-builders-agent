/**
 * GET    /api/account-tool-secrets/[provider]
 *   Devuelve el registro del usuario para este provider (sin secretos).
 *
 * PUT    /api/account-tool-secrets/[provider]
 *   Upsert. Body:
 *     {
 *       config: Record<string,string>,   // campos no sensibles
 *       secret: Record<string,string>,   // campos sensibles (planos; el server cifra)
 *     }
 *   Tras guardar, el status queda `pending_test`. La validación contra la
 *   API real vive en `/api/account-tool-secrets/[provider]/test` (Phase 2b/2c).
 *
 * DELETE /api/account-tool-secrets/[provider]
 *   Soft-delete: marca el registro como `disconnected` y borra el secret
 *   cifrado para no quedar con material sensible sin uso. Pasa `?hard=1`
 *   para borrar el registro completo.
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  createServerClient,
  deleteAccountToolSecret,
  getAccountToolSecretPublic,
  softDisconnectAccountToolSecret,
  upsertAccountToolSecret,
} from "@agents/db";
import {
  getAccountToolProvider,
  validateAccountToolPayload,
} from "@/lib/account-tool-providers";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export async function GET(
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
    const db = createServerClient();
    const secret = await getAccountToolSecretPublic(db, {
      userId: user.id,
      provider,
    });
    return NextResponse.json({ ok: true, secret, provider: spec });
  } catch (err) {
    console.error("[GET /api/account-tool-secrets/:provider] failed:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function PUT(
  request: Request,
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
    const body = (await request.json().catch(() => ({}))) as unknown;
    if (!isRecord(body)) {
      return NextResponse.json({ error: "Invalid body" }, { status: 400 });
    }
    const validation = validateAccountToolPayload(spec, body);
    if (!validation.ok) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    if (!process.env.ENCRYPTION_KEY) {
      // Falla limpia: sin clave de cifrado no podemos persistir secretos.
      // Mejor error explícito que guardar plaintext.
      return NextResponse.json(
        { error: "ENCRYPTION_KEY no configurado en el server" },
        { status: 500 }
      );
    }

    const db = createServerClient();
    const saved = await upsertAccountToolSecret(db, {
      userId: user.id,
      provider,
      config: validation.config,
      secret: validation.secret,
      status: "pending_test",
    });
    return NextResponse.json({ ok: true, secret: saved });
  } catch (err) {
    console.error("[PUT /api/account-tool-secrets/:provider] failed:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
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

    const { searchParams } = new URL(request.url);
    const hard = searchParams.get("hard") === "1";

    const db = createServerClient();

    if (hard) {
      await deleteAccountToolSecret(db, { userId: user.id, provider });
      return NextResponse.json({ ok: true, deleted: true });
    }

    const existing = await getAccountToolSecretPublic(db, {
      userId: user.id,
      provider,
    });
    if (!existing) {
      return NextResponse.json({ ok: true, secret: null });
    }
    const updated = await softDisconnectAccountToolSecret(db, {
      userId: user.id,
      provider,
    });
    return NextResponse.json({ ok: true, secret: updated });
  } catch (err) {
    console.error("[DELETE /api/account-tool-secrets/:provider] failed:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
