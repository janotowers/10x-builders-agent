import { NextResponse } from "next/server";
import {
  createOperationalCase,
  createServerClient,
  getOperationalCase,
  getOperationalCaseTypeById,
  insertOperationalCaseEvent,
} from "@agents/db";
import type {
  OperationalCase,
  OperationalCaseIntakeField,
} from "@agents/types";
import { createClient } from "@/lib/supabase/server";
import { buildTestContext } from "./test-context-samples";
import {
  buildSettingsTestCaseResponse,
  effectiveFlowForCaseType,
} from "@/lib/operational-cases/settings-test-case-response";
import { runSettingsTestSafeCheck } from "@/lib/operational-cases/settings-test-safe-check";

async function findLatestSettingsTestCase(
  db: ReturnType<typeof createServerClient>,
  userId: string,
  caseTypeId: string,
  caseTypeSlug?: string
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
  const exact = (data as OperationalCase | null) ?? null;
  if (exact || !caseTypeSlug) return exact;

  const fallback = await db
    .from("operational_cases")
    .select("*")
    .eq("user_id", userId)
    .eq("case_type", caseTypeSlug)
    .eq("context_jsonb->>created_from", "case_type_settings_test")
    .eq("context_jsonb->>test_mode", "true")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (fallback.error) throw fallback.error;
  return (fallback.data as OperationalCase | null) ?? null;
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
      const caseType = await getOperationalCaseTypeById(db, caseTypeId);
      opCase = await findLatestSettingsTestCase(
        db,
        user.id,
        caseTypeId,
        caseType?.case_type
      );
    }

    if (!opCase || opCase.user_id !== user.id) {
      return NextResponse.json({
        ok: true,
        case: null,
        events: [],
        toolCalls: [],
        pendingActions: [],
        blockingActions: [],
        historicalActions: [],
        transitionCount: 0,
      });
    }

    const caseType = await getOperationalCaseTypeById(db, opCase.case_type_id);
    const flow = await effectiveFlowForCaseType(db, caseType);
    return NextResponse.json(await buildSettingsTestCaseResponse(db, opCase, user.id, flow));
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

    const body = (await request.json()) as {
      case_type_id?: string;
      validate_registration?: boolean;
    };
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

    const existing = await findLatestSettingsTestCase(
      db,
      user.id,
      caseType.id,
      caseType.case_type
    );
    let opCase: OperationalCase;
    let reusedExisting = false;

    if (existing) {
      reusedExisting = true;
      const playthroughAnchorAt = new Date().toISOString();
      const { data, error } = await db
        .from("operational_cases")
        .update({
          context_jsonb: {
            ...context,
            controlled_test_playthrough_anchor_at: playthroughAnchorAt,
            controlled_test_cycle_reset_at: undefined,
            controlled_test_status: undefined,
            controlled_test_last_run_at: undefined,
            controlled_test_e2e_last_run_at: undefined,
            controlled_test_e2e_pending_confirmation: undefined,
            controlled_test_owner_response_processed_at: undefined,
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
      const playthroughAnchorAt = new Date().toISOString();
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
        context: {
          ...context,
          controlled_test_playthrough_anchor_at: playthroughAnchorAt,
        },
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
    if (body.validate_registration) {
      const safe = await runSettingsTestSafeCheck(db, opCase, {
        activationPolicy: caseType.activation_policy_jsonb,
        flow,
      });
      if ("error" in safe) {
        return NextResponse.json({ error: safe.error }, { status: safe.status });
      }
      opCase = safe.case;
    }

    return NextResponse.json({
      ...(await buildSettingsTestCaseResponse(db, opCase, user.id, flow)),
      reused_existing: reusedExisting,
      mode: body.validate_registration ? "safe_check" : undefined,
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
      await buildSettingsTestCaseResponse(db, data as OperationalCase, user.id, flow)
    );
  } catch (err) {
    console.error("[PATCH /api/operational-case-tests] failed:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
