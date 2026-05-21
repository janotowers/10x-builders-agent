import { NextResponse } from "next/server";
import {
  createOperationalCase,
  createServerClient,
  getGlobalOperationalCaseTypeBySlug,
  getOperationalCase,
  getOperationalCaseTypeById,
  getRecentOperationalCaseEvents,
  insertOperationalCaseEvent,
} from "@agents/db";
import type {
  OperationalCase,
  OperationalCaseEvent,
  OperationalCaseFlowStep,
  OperationalCaseIntakeField,
  ToolCall,
} from "@agents/types";
import { createClient } from "@/lib/supabase/server";
import { buildTestContext } from "./test-context-samples";

async function findLatestSettingsTestCase(
  db: ReturnType<typeof createServerClient>,
  userId: string,
  caseTypeId: string
): Promise<OperationalCase | null> {
  const { data, error } = await db
    .from("operational_cases")
    .select("*")
    .eq("user_id", userId)
    .eq("case_type_id", caseTypeId)
    .eq("context_jsonb->>created_from", "case_type_settings_test")
    .eq("context_jsonb->>test_mode", "true")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as OperationalCase | null) ?? null;
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
  opCase: OperationalCase,
  flow: OperationalCaseFlowStep[] = []
): Promise<{
  ok: true;
  case: OperationalCase;
  events: OperationalCaseEvent[];
  toolCalls: ToolCall[];
  flowProgress: Array<{
    step_key: string;
    step_label: string;
    status: "pending" | "in_progress" | "completed" | "blocked";
    evidence: string[];
  }>;
}> {
  const fresh = (await getOperationalCase(db, opCase.id)) ?? opCase;
  const events = await getRecentOperationalCaseEvents(db, fresh.id, 80);
  const toolCalls = await listToolCallsForCase(db, fresh.id);
  const flowProgress = flow.map((step) => {
    const stepToolIds = new Set<string>();
    for (const tool of step.step_tools ?? []) stepToolIds.add(tool.tool_id);
    for (const skill of step.step_skills ?? []) {
      for (const tool of skill.skill_tools ?? []) stepToolIds.add(tool.tool_id);
    }
    const toolEvidence = toolCalls.filter((call) => stepToolIds.has(call.tool_name));
    const eventEvidence = events.filter((event) => {
      const payload = event.payload_jsonb as Record<string, unknown> | null;
      return (
        payload?.current_step === step.step_key ||
        payload?.step === step.step_key ||
        payload?.step_key === step.step_key
      );
    });
    const evidence = [
      ...eventEvidence.map((event) => `event:${event.event_type}`),
      ...toolEvidence.map((call) => `tool:${call.tool_name}:${call.status}`),
    ];
    const status: "pending" | "in_progress" | "completed" | "blocked" =
      fresh.current_step === step.step_key
        ? "in_progress"
        : evidence.length > 0
          ? "completed"
          : "pending";
    return {
      step_key: step.step_key,
      step_label: step.step_label,
      status,
      evidence,
    };
  });
  return { ok: true, case: fresh, events, toolCalls, flowProgress };
}

async function effectiveFlowForCaseType(
  db: ReturnType<typeof createServerClient>,
  caseType: Awaited<ReturnType<typeof getOperationalCaseTypeById>>
): Promise<OperationalCaseFlowStep[]> {
  const ownFlow = Array.isArray(caseType?.operational_flow_jsonb)
    ? caseType.operational_flow_jsonb
    : [];
  if (ownFlow.length > 0 || !caseType?.user_id) return ownFlow;
  const globalCaseType = await getGlobalOperationalCaseTypeBySlug(
    db,
    caseType.case_type
  );
  return Array.isArray(globalCaseType?.operational_flow_jsonb)
    ? globalCaseType.operational_flow_jsonb
    : [];
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

    const caseType = await getOperationalCaseTypeById(db, opCase.case_type_id);
    const flow = await effectiveFlowForCaseType(db, caseType);
    return NextResponse.json(await responseForCase(db, opCase, flow));
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
      ...buildTestContext(fields, caseType.case_type),
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

    const existing = await findLatestSettingsTestCase(db, user.id, caseType.id);
    let opCase: OperationalCase;
    let reusedExisting = false;

    if (existing) {
      reusedExisting = true;
      const { data, error } = await db
        .from("operational_cases")
        .update({
          context_jsonb: {
            ...context,
            controlled_test_status: undefined,
            controlled_test_last_run_at: undefined,
            controlled_test_e2e_last_run_at: undefined,
          },
          external_contact_jsonb: {
            ...(existing.external_contact_jsonb ?? {}),
            display_name: externalName,
            channel: Number.isFinite(telegramChatId) ? "telegram" : undefined,
            chat_id: Number.isFinite(telegramChatId)
              ? telegramChatId
              : undefined,
          },
          status: "active",
          current_step: "intake",
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id)
        .select()
        .single();
      if (error) throw error;
      opCase = data as OperationalCase;
      await insertOperationalCaseEvent(db, {
        caseId: opCase.id,
        eventType: "human_decision",
        actor: "user",
        payload: {
          source: "case_type_settings_test_regenerate",
          test_mode: true,
          note: "Datos sintéticos regenerados en el mismo caso de prueba (sin crear fila nueva).",
        },
      });
    } else {
      opCase = await createOperationalCase(db, {
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
    }

    const flow = await effectiveFlowForCaseType(db, caseType);
    return NextResponse.json({
      ...(await responseForCase(db, opCase, flow)),
      reused_existing: reusedExisting,
    });
  } catch (err) {
    console.error("[POST /api/operational-case-tests] failed:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await request.json().catch(() => ({}))) as {
      case_id?: string;
      context?: Record<string, unknown>;
    };
    const caseId = body.case_id?.trim();
    if (!caseId || !body.context || typeof body.context !== "object") {
      return NextResponse.json(
        { error: "case_id and context required" },
        { status: 400 }
      );
    }
    const requestedContext = body.context;

    const db = createServerClient();
    const opCase = await getOperationalCase(db, caseId);
    if (!opCase || opCase.user_id !== user.id) {
      return NextResponse.json({ error: "case_not_found" }, { status: 404 });
    }
    if (
      opCase.context_jsonb?.created_from !== "case_type_settings_test" ||
      opCase.context_jsonb?.test_mode !== true
    ) {
      return NextResponse.json({ error: "test_case_required" }, { status: 400 });
    }

    const caseType = await getOperationalCaseTypeById(db, opCase.case_type_id);
    if (!caseType || caseType.user_id !== user.id) {
      return NextResponse.json({ error: "case_type_not_found" }, { status: 404 });
    }

    const fields = Array.isArray(caseType.intake_schema_jsonb)
      ? (caseType.intake_schema_jsonb as OperationalCaseIntakeField[])
      : [];
    const allowedNames = new Set(fields.map((field) => field.name));
    const nextContext: Record<string, unknown> = {
      ...(opCase.context_jsonb ?? {}),
      created_from: "case_type_settings_test",
      test_mode: true,
      case_type_id: caseType.id,
    };
    for (const field of fields) {
      if (field.name in requestedContext) {
        const value = requestedContext[field.name];
        nextContext[field.name] =
          field.type === "number" && typeof value === "string" && value.trim()
            ? Number(value)
            : value;
      }
    }
    const extraContextKeys = new Set([
      "condition",
      "age_range",
      "current_status",
      "address",
      "currency",
      "location",
    ]);
    for (const [key, value] of Object.entries(requestedContext)) {
      if (allowedNames.has(key)) continue;
      if (key === "title") nextContext.title = String(value ?? "").trim();
      if (extraContextKeys.has(key)) nextContext[key] = value;
    }
    nextContext.title =
      String(nextContext.title ?? "").trim() ||
      `${caseType.display_name} - prueba`;

    const externalName =
      String(nextContext.owner_name ?? "").trim() ||
      String(nextContext.lead_name ?? "").trim() ||
      "Contacto de prueba";
    const telegramChatId = Number(nextContext.telegram_chat_id);
    const externalContact = {
      ...opCase.external_contact_jsonb,
      display_name: externalName,
      channel: Number.isFinite(telegramChatId) ? "telegram" : undefined,
      chat_id: Number.isFinite(telegramChatId) ? telegramChatId : undefined,
    };

    const { data, error } = await db
      .from("operational_cases")
      .update({
        context_jsonb: nextContext,
        external_contact_jsonb: externalContact,
        updated_at: new Date().toISOString(),
      })
      .eq("id", opCase.id)
      .select()
      .single();
    if (error) throw error;

    await insertOperationalCaseEvent(db, {
      caseId: opCase.id,
      eventType: "human_decision",
      actor: "user",
      payload: {
        source: "case_type_settings_test_context_update",
        updated_fields: fields
          .map((field) => field.name)
          .filter((name) => name in requestedContext),
      },
    });

    const flow = await effectiveFlowForCaseType(db, caseType);
    return NextResponse.json(
      await responseForCase(db, data as OperationalCase, flow)
    );
  } catch (err) {
    console.error("[PATCH /api/operational-case-tests] failed:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
