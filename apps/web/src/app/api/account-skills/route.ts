/**
 * GET    /api/account-skills            → lista las account_skills del usuario.
 * POST   /api/account-skills            → upsert (crea o actualiza por slug).
 *                                         body: { slug, body_md, status?: 'draft'|'active'|'archived' }
 *                                         valida frontmatter del body_md vía
 *                                         parseAccountSkillSource antes de
 *                                         persistir; rechaza si está mal.
 *
 * DELETE handler está en /api/account-skills/[slug]/route.ts.
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  createServerClient,
  listAccountSkillsForUser,
  upsertAccountSkill,
} from "@agents/db";
import { parseAccountSkillSource, SkillParseError } from "@agents/agent";
import type { AccountSkillStatus } from "@agents/types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

const STATUS_VALUES: AccountSkillStatus[] = ["draft", "active", "archived"];

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
    const skills = await listAccountSkillsForUser(db, user.id, {
      statuses: ["draft", "active", "archived"],
    });
    return NextResponse.json({ ok: true, skills });
  } catch (err) {
    console.error("[GET /api/account-skills] failed:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const body = (await request.json().catch(() => ({}))) as unknown;
    if (!isRecord(body)) {
      return NextResponse.json({ error: "Invalid body" }, { status: 400 });
    }
    const slug = cleanText(body.slug);
    const bodyMd = typeof body.body_md === "string" ? body.body_md : "";
    const statusRaw = cleanText(body.status) || "draft";
    const status = STATUS_VALUES.includes(statusRaw as AccountSkillStatus)
      ? (statusRaw as AccountSkillStatus)
      : "draft";

    if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
      return NextResponse.json(
        { error: "slug must match ^[a-z0-9][a-z0-9-]*$" },
        { status: 400 }
      );
    }
    if (!bodyMd.trim()) {
      return NextResponse.json({ error: "body_md required" }, { status: 400 });
    }

    let parsedMetadata: Record<string, unknown>;
    try {
      const record = parseAccountSkillSource(bodyMd, slug, user.id);
      parsedMetadata = {
        name: record.metadata.name,
        description: record.metadata.description,
        scope: record.metadata.scope,
        allowed_tools: [...record.metadata.allowedTools],
        includes: [...record.metadata.includes],
        requires_tenant_context: record.metadata.requiresTenantContext,
        memory_extraction: record.metadata.memoryExtraction,
        heartbeat_mode: record.metadata.heartbeatMode,
      };
    } catch (e) {
      if (e instanceof SkillParseError) {
        return NextResponse.json(
          { error: "frontmatter_invalid", details: e.message },
          { status: 422 }
        );
      }
      throw e;
    }

    const db = createServerClient();
    const skill = await upsertAccountSkill(db, {
      userId: user.id,
      slug,
      bodyMd,
      metadata: parsedMetadata,
      status,
    });
    return NextResponse.json({ ok: true, skill });
  } catch (err) {
    console.error("[POST /api/account-skills] failed:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
