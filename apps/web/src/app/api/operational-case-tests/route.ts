import { NextResponse } from "next/server";
import {
  createOperationalCase,
  createServerClient,
  findLatestConversationalOperationalCase,
  getActiveE2ELabSession,
  getOperationalCase,
  getOperationalCaseTypeById,
  insertOperationalCaseEvent,
  updateOperationalCase,
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
import { settingsTestPropertyDataSeed } from "@/lib/operational-cases/property-search-zone";
import { syncLabFormIntoPropertyData } from "@/lib/operational-cases/lab-form-property-data-sync";

/**
 * Construye `property_data` canónico del caso de prueba a partir del formulario.
 * Arranca de la property_data existente (o del seed de piloto si está vacía) y
 * aplica los valores del formulario con precedencia por fuente (documentos > lab_form).
 */
function buildCanonicalPropertyData(
  context: Record<string, unknown>
): Record<string, unknown> {
  const existingPd =
    context.property_data &&
    typeof context.property_data === "object" &&
    !Array.isArray(context.property_data)
      ? (context.property_data as Record<string, unknown>)
      : {};
  const basePd =
    Object.keys(existingPd).length > 0
      ? existingPd
      : settingsTestPropertyDataSeed(context);
  return syncLabFormIntoPropertyData({
    formContext: context,
    propertyData: basePd,
  }).propertyData;
}

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

function normalizeIntakeFieldValue(
  field: OperationalCaseIntakeField,
  value: unknown
): unknown {
  if (value == null) return undefined;
  if (field.type === "number") {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
  }
  if (field.type === "multi_select") {
    if (Array.isArray(value)) {
      const options = value
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean);
      return options.length > 0 ? options : undefined;
    }
    if (typeof value === "string" && value.trim()) {
      return [value.trim()];
    }
    return undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return value;
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
    const source = searchParams.get("source")?.trim();
    const db = createServerClient();

    let opCase: OperationalCase | null = null;
    if (caseId) {
      opCase = await getOperationalCase(db, caseId);
    } else if (caseTypeId) {
      const caseType = await getOperationalCaseTypeById(db, caseTypeId);
      if (source === "conversational" && caseType?.case_type) {
        opCase = await findLatestConversationalOperationalCase(db, {
          userId: user.id,
          caseType: caseType.case_type,
          statuses: ["active", "waiting_internal", "waiting_external"],
        });
      } else {
        opCase = await findLatestSettingsTestCase(
          db,
          user.id,
          caseTypeId,
          caseType?.case_type
        );
      }
    }

    if (!opCase || opCase.user_id !== user.id) {
      const caseTypeForLabMode = caseTypeId
        ? await getOperationalCaseTypeById(db, caseTypeId)
        : null;
      const e2eLabSession = caseTypeForLabMode?.case_type
        ? await getActiveE2ELabSession(db, {
            userId: user.id,
            caseType: caseTypeForLabMode.case_type,
          })
        : null;
      return NextResponse.json({
        ok: true,
        case: null,
        e2eLabSession,
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
    const payload = await buildSettingsTestCaseResponse(db, opCase, user.id, flow);
    const e2eLabSession = await getActiveE2ELabSession(db, {
      userId: user.id,
      caseType: opCase.case_type,
    });
    return NextResponse.json({
      ...payload,
      e2eLabSession,
    });
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
    context.property_data = buildCanonicalPropertyData(context);
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

export async function DELETE(request: Request) {
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
    const source = searchParams.get("source")?.trim();
    if (!caseId || source !== "conversational") {
      return NextResponse.json(
        { error: "case_id and source=conversational required" },
        { status: 400 }
      );
    }

    const db = createServerClient();
    const opCase = await getOperationalCase(db, caseId);
    if (
      !opCase ||
      opCase.user_id !== user.id ||
      opCase.context_jsonb?.created_from !== "agent_conversation"
    ) {
      return NextResponse.json({ error: "case_not_found" }, { status: 404 });
    }

    const now = new Date().toISOString();
    let current = opCase;
    let updated: OperationalCase | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      updated = await updateOperationalCase(db, current.id, current.version, {
        status: "paused",
        nextActionAt: null,
        context: {
          ...current.context_jsonb,
          e2e_control_status: "abandoned",
          e2e_control_abandoned_at: now,
          e2e_control_abandoned_by: "settings_lab",
        },
      });
      if (updated) break;
      const latest = await getOperationalCase(db, current.id);
      if (!latest || latest.user_id !== user.id) break;
      current = latest;
    }
    if (!updated) {
      return NextResponse.json(
        { error: "case_update_conflict_retry" },
        { status: 409 }
      );
    }

    const { data: rejectedToolCalls, error: rejectedError } = await db
      .from("tool_calls")
      .update({
        status: "rejected",
        finished_at: now,
        result_json: {
          reason: "conversational_e2e_abandoned",
          case_id: opCase.id,
        },
      })
      .eq("status", "pending_confirmation")
      .contains("arguments_json", { case_id: opCase.id })
      .select("id");
    if (rejectedError) throw rejectedError;

    const { data: dismissedNotifications, error: dismissedError } = await db
      .from("internal_user_notifications")
      .update({
        status: "dismissed",
        read_at: now,
        updated_at: now,
      })
      .eq("user_id", user.id)
      .eq("case_id", opCase.id)
      .eq("status", "unread")
      .select("id");
    if (dismissedError) throw dismissedError;

    const { error: bindingsError } = await db
      .from("operational_case_conversation_bindings")
      .update({
        status: "cancelled",
        updated_at: now,
        metadata_jsonb: {
          source: "settings_lab_abandon",
          abandoned_at: now,
        },
      })
      .eq("user_id", user.id)
      .eq("case_id", opCase.id)
      .in("status", ["awaiting_user", "clarification_needed"]);
    if (bindingsError) throw bindingsError;

    await insertOperationalCaseEvent(db, {
      caseId: opCase.id,
      eventType: "human_decision",
      actor: "user",
      payload: {
        kind: "conversational_e2e_abandoned",
        source: "settings_lab",
        rejected_pending_tool_calls: rejectedToolCalls?.length ?? 0,
        dismissed_notifications: dismissedNotifications?.length ?? 0,
      },
    });

    return NextResponse.json({
      ok: true,
      case: updated,
      rejected_tool_calls: rejectedToolCalls?.length ?? 0,
      dismissed_notifications: dismissedNotifications?.length ?? 0,
    });
  } catch (err) {
    console.error("[DELETE /api/operational-case-tests] failed:", err);
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
      delete nextContext[field.name];
    }
    const staleDerivedKeys = [
      "min_price",
      "max_price",
      "price_min",
      "price_max",
      "min_area_m2",
      "max_area_m2",
      "area_min_m2",
      "area_max_m2",
      "expected_price",
      "asking_price",
      "price",
      "precio",
    ] as const;
    for (const key of staleDerivedKeys) {
      delete nextContext[key];
    }
    for (const field of fields) {
      const normalized = normalizeIntakeFieldValue(field, requestedContext[field.name]);
      if (normalized !== undefined) {
        nextContext[field.name] = normalized;
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

    nextContext.property_data = buildCanonicalPropertyData(nextContext);

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
