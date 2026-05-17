import { NextResponse } from "next/server";
import {
  createOperationalCase,
  createServerClient,
  getOperationalCase,
  getOperationalCaseTypeById,
  getRecentOperationalCaseEvents,
  insertOperationalCaseEvent,
} from "@agents/db";
import type {
  OperationalCase,
  OperationalCaseEvent,
  OperationalCaseIntakeField,
  ToolCall,
} from "@agents/types";
import { createClient } from "@/lib/supabase/server";

function sampleValue(field: OperationalCaseIntakeField) {
  if (field.type === "number") return "1234567890";
  if (field.type === "select") return field.options?.[0] ?? "prueba";
  if (field.name.includes("telegram_chat_id")) return "1234567890";
  if (field.name.includes("owner")) return "Contacto de prueba";
  if (field.name.includes("lead")) return "Lead de prueba";
  if (field.name.includes("property") || field.name.includes("title")) {
    return "Propiedad de prueba";
  }
  return field.placeholder?.replace(/^Ej\.\s*/i, "") || `${field.label} de prueba`;
}

function buildTestContext(fields: OperationalCaseIntakeField[]) {
  const context: Record<string, unknown> = {};
  for (const field of fields) {
    context[field.name] = sampleValue(field);
  }
  return context;
}

async function listToolCallsForCase(
  db: ReturnType<typeof createServerClient>,
  caseId: string
): Promise<ToolCall[]> {
  const { data, error } = await db
    .from("tool_calls")
    .select("*")
    .contains("arguments_json", { case_id: caseId })
    .order("created_at", { ascending: true })
    .limit(100);
  if (error) {
    console.warn("[operational-case-tests] tool_calls lookup failed:", error);
    return [];
  }
  return (data ?? []) as ToolCall[];
}

async function responseForCase(
  db: ReturnType<typeof createServerClient>,
  opCase: OperationalCase
): Promise<{
  ok: true;
  case: OperationalCase;
  events: OperationalCaseEvent[];
  toolCalls: ToolCall[];
}> {
  const fresh = (await getOperationalCase(db, opCase.id)) ?? opCase;
  const events = await getRecentOperationalCaseEvents(db, fresh.id, 80);
  const toolCalls = await listToolCallsForCase(db, fresh.id);
  return { ok: true, case: fresh, events, toolCalls };
}

export async function GET(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const caseId = searchParams.get("case_id")?.trim();
    const caseTypeId = searchParams.get("case_type_id")?.trim();
    const db = createServerClient();

    let opCase: OperationalCase | null = null;
    if (caseId) {
      opCase = await getOperationalCase(db, caseId);
    } else if (caseTypeId) {
      const { data, error } = await db
        .from("operational_cases")
        .select("*")
        .eq("user_id", user.id)
        .eq("case_type_id", caseTypeId)
        .eq("context_jsonb->>created_from", "case_type_settings_test")
        .eq("context_jsonb->>test_mode", "true")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      opCase = (data as OperationalCase | null) ?? null;
    }

    if (!opCase || opCase.user_id !== user.id) {
      return NextResponse.json({ ok: true, case: null, events: [], toolCalls: [] });
    }

    return NextResponse.json(await responseForCase(db, opCase));
  } catch (err) {
    console.error("[GET /api/operational-case-tests] failed:", err);
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

    const body = (await request.json()) as { case_type_id?: string };
    const caseTypeId = body.case_type_id?.trim();
    if (!caseTypeId) {
      return NextResponse.json({ error: "case_type_id required" }, { status: 400 });
    }

    const db = createServerClient();
    const caseType = await getOperationalCaseTypeById(db, caseTypeId);
    if (
      !caseType ||
      caseType.user_id !== user.id ||
      caseType.visibility !== "private" ||
      caseType.status !== "active"
    ) {
      return NextResponse.json({ error: "private_active_case_type_required" }, { status: 400 });
    }

    const fields = Array.isArray(caseType.intake_schema_jsonb)
      ? (caseType.intake_schema_jsonb as OperationalCaseIntakeField[])
      : [];
    const context: Record<string, unknown> = {
      ...buildTestContext(fields),
      title: `${caseType.display_name} - prueba`,
      created_from: "case_type_settings_test",
      test_mode: true,
      case_type_id: caseType.id,
    };
    const externalName =
      String(context.owner_name ?? "").trim() ||
      String(context.lead_name ?? "").trim() ||
      "Contacto de prueba";
    const telegramChatId = Number(context.telegram_chat_id);

    const opCase = await createOperationalCase(db, {
      userId: user.id,
      caseTypeId: caseType.id,
      caseType: caseType.case_type,
      status: "active",
      currentStep: "intake",
      nextActionAt: null,
      externalContact: {
        display_name: externalName,
        channel: Number.isFinite(telegramChatId) ? "telegram" : undefined,
        chat_id: Number.isFinite(telegramChatId) ? telegramChatId : undefined,
      },
      context,
    });

    await insertOperationalCaseEvent(db, {
      caseId: opCase.id,
      eventType: "state_changed",
      actor: "user",
      payload: {
        source: "case_type_settings_test",
        status: opCase.status,
        current_step: opCase.current_step,
        test_mode: true,
      },
    });

    return NextResponse.json(await responseForCase(db, opCase));
  } catch (err) {
    console.error("[POST /api/operational-case-tests] failed:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
