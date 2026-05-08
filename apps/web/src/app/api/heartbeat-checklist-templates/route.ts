import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  createHeartbeatChecklistTemplate,
  createServerClient,
  listHeartbeatChecklistTemplates,
} from "@agents/db";
import { validateHeartbeatChecklist } from "@agents/agent/src/heartbeat/checklist";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

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
    const templates = await listHeartbeatChecklistTemplates(db, user.id);
    return NextResponse.json({ ok: true, templates });
  } catch (err) {
    console.error("[GET /api/heartbeat-checklist-templates] failed:", err);
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

    const name = cleanText(body.name);
    const markdown = cleanText(body.markdown);
    if (!name) {
      return NextResponse.json({ error: "name required" }, { status: 400 });
    }
    if (!markdown) {
      return NextResponse.json({ error: "markdown required" }, { status: 400 });
    }

    const validation = validateHeartbeatChecklist(markdown);
    if (validation.warnings.length > 0) {
      return NextResponse.json(
        { error: "Checklist has validation warnings", warnings: validation.warnings },
        { status: 422 }
      );
    }

    const db = createServerClient();
    const template = await createHeartbeatChecklistTemplate(db, {
      userId: user.id,
      name,
      description: cleanText(body.description),
      markdown,
      status: "validated",
      validationWarnings: [],
      detectedSkills: validation.items.flatMap((item) => item.candidateSkills),
      sourceTemplateId: cleanText(body.source_template_id) || null,
    });

    return NextResponse.json({ ok: true, template });
  } catch (err) {
    console.error("[POST /api/heartbeat-checklist-templates] failed:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

