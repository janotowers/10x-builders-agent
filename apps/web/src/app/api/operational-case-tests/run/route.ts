import { NextResponse } from "next/server";
import {
  createServerClient,
  associateExternalResponseWithCase,
  getGlobalOperationalCaseTypeBySlug,
  getOperationalCase,
  getOperationalCaseTypeById,
  insertOperationalCaseEvent,
  listOperationalCaseDocuments,
  markCaseProcessing,
  updateOperationalCase,
  expireExternalContactNotificationsForCase,
} from "@agents/db";
import type {
  OperationalCase,
  OperationalCaseEvent,
  OperationalCaseFlowStep,
  ToolCall,
} from "@agents/types";
import { createClient } from "@/lib/supabase/server";
import { evaluateOwnerResponseBusinessOutcome } from "@/lib/operational-cases/evaluate-owner-response-outcome";
import {
  buildPropertyDataReviewMessage,
  missingOwnerResponseCriticalFields,
  parseOwnerCharacteristics,
  syncIntakeFieldsFromPropertyData,
} from "@/lib/operational-cases/parse-owner-characteristics";
import { runSettingsTestCaseAgentTick } from "@/lib/operational-cases/run-settings-test-case-tick";
import { notify } from "@/lib/notify";
type RunMode = "safe_check" | "agent_e2e";

type RunBody = {
  case_id?: string;
  mode?: RunMode;
  owner_response_text?: string;
  readiness_skill_slug?: string;
  readiness_flow_step_key?: string;
};

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function firstString(ctx: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = ctx[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function mergeDocumentExtractionsIntoPropertyData(
  propertyData: Record<string, unknown>,
  documents: Awaited<ReturnType<typeof listOperationalCaseDocuments>>
) {
  const merged = { ...propertyData };
  for (const doc of documents) {
    const extraction = doc.extraction_jsonb;
    if (!isRecord(extraction) || doc.extraction_status !== "ok") continue;
    for (const key of [
      "address",
      "warnings",
      "confidence",
      "folio_real",
      "owner_names",
      "area_total_m2",
      "area_construida_m2",
      "document_kind",
      "extraction_source",
      "property_description",
    ]) {
      if (merged[key] == null && extraction[key] != null) {
        merged[key] = extraction[key];
      }
    }
  }
  return merged;
}

function isCharacteristicsOwnerResponseSimulation(body: RunBody) {
  return (
    body.readiness_skill_slug === "extract-property-characteristics" ||
    body.readiness_flow_step_key === "documents_received"
  );
}

async function effectiveFlowForCase(
  db: ReturnType<typeof createServerClient>,
  opCase: OperationalCase
): Promise<OperationalCaseFlowStep[]> {
  const caseType = await getOperationalCaseTypeById(db, opCase.case_type_id);
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
    console.warn("[operational-case-tests/run] tool_calls lookup failed:", error);
    return [];
  }
  return (data ?? []) as ToolCall[];
}

function buildFlowProgress(params: {
  opCase: OperationalCase;
  events: OperationalCaseEvent[];
  flow: OperationalCaseFlowStep[];
  toolCalls?: ToolCall[];
}) {
  return params.flow.map((step, index) => {
    const stepToolIds = new Set<string>();
    for (const tool of step.step_tools ?? []) stepToolIds.add(tool.tool_id);
    for (const skill of step.step_skills ?? []) {
      for (const tool of skill.skill_tools ?? []) stepToolIds.add(tool.tool_id);
    }
    const toolEvidence = (params.toolCalls ?? []).filter((call) =>
      stepToolIds.has(call.tool_name)
    );
    const eventEvidence = params.events
      .filter((event) => {
        const payload = event.payload_jsonb as Record<string, unknown> | null;
        return (
          payload?.current_step === step.step_key ||
          payload?.step === step.step_key ||
          payload?.step_key === step.step_key ||
          (index === 0 &&
            (payload?.kind === "controlled_test_started" ||
              payload?.kind === "controlled_test_e2e_started"))
        );
      })
      .map((event) => `event:${event.event_type}`);
    const evidence = [
      ...eventEvidence,
      ...toolEvidence.map((call) => `tool:${call.tool_name}:${call.status}`),
    ];
    const status =
      params.opCase.current_step === step.step_key
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
}

async function runSafeCheck(
  db: ReturnType<typeof createServerClient>,
  fresh: OperationalCase
) {
  await insertOperationalCaseEvent(db, {
    caseId: fresh.id,
    eventType: "step_completed",
    actor: "system",
    payload: {
      kind: "controlled_test_started",
      source: "case_type_settings",
      safe_mode: true,
      note: "Prueba segura inicial (fase 1): valida intake y avance mínimo sin invocar el agente ni tools externas.",
    },
  });

  const updated = await updateOperationalCase(db, fresh.id, fresh.version, {
    status: "paused",
    currentStep:
      fresh.current_step === "intake" ? "awaiting_documents" : fresh.current_step,
    nextActionAt: null,
    context: {
      ...fresh.context_jsonb,
      test_mode: true,
      controlled_test_last_run_at: new Date().toISOString(),
      controlled_test_status: "passed_safe_checks",
    },
  });

  if (!updated) {
    return { error: "concurrent_update" as const, status: 409 };
  }

  await insertOperationalCaseEvent(db, {
    caseId: updated.id,
    eventType: "state_changed",
    actor: "system",
    payload: {
      source: "case_type_settings_test",
      status: updated.status,
      current_step: updated.current_step,
      result: "safe_readiness_passed",
      next_action:
        "Opcional: ejecutar prueba E2E con agente para simular un tick operacional real.",
    },
  });

  return { case: updated };
}

async function runAgentE2E(
  db: ReturnType<typeof createServerClient>,
  fresh: OperationalCase,
  userId: string,
  ownerResponseText?: string
) {
  const tick = await runSettingsTestCaseAgentTick(db, fresh, userId, {
    source: "case_type_settings",
    skipLock: true,
    ownerResponseText,
  });
  return {
    case: tick.case,
    agent: {
      pending_confirmation: tick.pending_confirmation,
      response_preview: tick.response_preview,
    },
  };
}

async function processCharacteristicsOwnerResponseDeterministically(
  db: ReturnType<typeof createServerClient>,
  fresh: OperationalCase,
  ownerResponseText: string
) {
  const currentContext = isRecord(fresh.context_jsonb) ? fresh.context_jsonb : {};
  const currentPropertyData = isRecord(currentContext.property_data)
    ? currentContext.property_data
    : {};
  const documents = await listOperationalCaseDocuments(db, { caseId: fresh.id });
  const propertyDataFromDocuments = mergeDocumentExtractionsIntoPropertyData(
    currentPropertyData,
    documents
  );
  const parsed = parseOwnerCharacteristics(ownerResponseText);
  const propertyData = {
    ...propertyDataFromDocuments,
    ...parsed,
  };
  const criticalMissing = missingOwnerResponseCriticalFields(propertyData);
  const mergedContext = syncIntakeFieldsFromPropertyData(currentContext, propertyData);
  const updated = await updateOperationalCase(db, fresh.id, fresh.version, {
    currentStep: "documents_received",
    status: criticalMissing.length === 0 ? "waiting_internal" : "waiting_external",
    nextActionAt: null,
    context: {
      ...mergedContext,
      controlled_test_status:
        criticalMissing.length === 0
          ? "owner_response_processed_waiting_internal"
          : "owner_response_processed_missing_fields",
      controlled_test_owner_response_processed_at: new Date().toISOString(),
      controlled_test_owner_response_parsed_fields: Object.keys(parsed),
    },
  });

  if (!updated) {
    throw new Error("owner_response_deterministic_update_failed");
  }

  let internalReviewSent = false;
  if (criticalMissing.length === 0) {
    const propertyTitle =
      firstString(currentContext, ["title", "property_title"]) ?? "la propiedad";
    const reviewText = buildPropertyDataReviewMessage({
      propertyTitle,
      propertyData,
    });
    const notifyResult = await notify(
      db,
      fresh.user_id,
      {
        text: reviewText,
        kind: "property_data_review",
        data: {
          case_id: updated.id,
          title: "Revisión de datos de propiedad",
          source: "readiness_owner_simulation",
        },
      },
      "normal"
    );
    internalReviewSent = notifyResult.delivered.length > 0;
    await insertOperationalCaseEvent(db, {
      caseId: updated.id,
      eventType: "human_decision",
      actor: "system",
      payload: {
        kind: "property_data_review_requested",
        source: "readiness_owner_simulation",
        notify_delivered: notifyResult.delivered,
      },
    });
  }

  await insertOperationalCaseEvent(db, {
    caseId: updated.id,
    eventType: "state_changed",
    actor: "system",
    payload: {
      source: "readiness_owner_simulation",
      kind: "owner_response_deterministic_merge",
      parsed_fields: Object.keys(parsed),
      critical_missing: criticalMissing,
      status: updated.status,
      current_step: updated.current_step,
      internal_review_sent: internalReviewSent,
      note:
        criticalMissing.length === 0
          ? "Respuesta simulada mergeada; queda en revisión interna del asesor (paso 3)."
          : "Respuesta simulada mergeada parcialmente; aún faltan campos críticos.",
    },
  });

  return {
    case: updated,
    criticalMissing,
    parsedFields: Object.keys(parsed),
    internalReviewSent,
  };
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

    const body = (await request.json()) as RunBody;
    const caseId = body.case_id?.trim();
    const mode: RunMode =
      body.mode === "agent_e2e" ? "agent_e2e" : "safe_check";
    const ownerResponseText = cleanText(body.owner_response_text);
    if (!caseId) {
      return NextResponse.json({ error: "case_id required" }, { status: 400 });
    }

    const db = createServerClient();
    const opCase = await getOperationalCase(db, caseId);
    if (!opCase || opCase.user_id !== user.id) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (opCase.context_jsonb?.created_from !== "case_type_settings_test") {
      return NextResponse.json({ error: "not_a_settings_test_case" }, { status: 400 });
    }
    if (ownerResponseText) {
      let caseForOwnerResponse = opCase;
      await expireExternalContactNotificationsForCase(db, opCase.id);
      if (isCharacteristicsOwnerResponseSimulation(body)) {
        const prepared = await updateOperationalCase(db, opCase.id, opCase.version, {
          currentStep: "documents_received",
          status: "waiting_external",
          nextActionAt: null,
          context: {
            ...(opCase.context_jsonb ?? {}),
            test_mode: true,
            controlled_test_prepared_step: "documents_received",
            controlled_test_prepared_at: new Date().toISOString(),
          },
        });
        if (!prepared) {
          return NextResponse.json({ error: "case_prepare_failed" }, { status: 409 });
        }
        caseForOwnerResponse = prepared;
        await insertOperationalCaseEvent(db, {
          caseId: prepared.id,
          eventType: "state_changed",
          actor: "system",
          payload: {
            source: "readiness_owner_simulation",
            current_step: "documents_received",
            status: "waiting_external",
            note: "Caso preparado para simular respuesta de características del dueño.",
          },
        });
      }

      const chatId = caseForOwnerResponse.external_contact_jsonb?.chat_id;
      if (typeof chatId !== "number" || !Number.isFinite(chatId)) {
        return NextResponse.json(
          {
            error: "missing_external_chat_id",
            hint:
              "El caso de prueba necesita telegram_chat_id para simular una respuesta del dueño.",
          },
          { status: 400 }
        );
      }
      const awakened = await associateExternalResponseWithCase(db, {
        caseId: caseForOwnerResponse.id,
        channel: "telegram",
        chatId,
        payload: {
          source: "readiness_owner_simulation",
          simulated: true,
          text: ownerResponseText,
          received_at: new Date().toISOString(),
        },
      });
      if (!awakened) {
        return NextResponse.json({ error: "owner_response_not_registered" }, { status: 500 });
      }
    }

    const caseBeforeLock = ownerResponseText
      ? await getOperationalCase(db, opCase.id)
      : opCase;
    if (!caseBeforeLock) {
      return NextResponse.json({ error: "case_not_found_after_owner_response" }, { status: 404 });
    }

    const locked = await markCaseProcessing(db, caseBeforeLock.id, caseBeforeLock.version, 1);
    if (!locked) {
      return NextResponse.json({ error: "case_busy" }, { status: 409 });
    }

    const fresh = await getOperationalCase(db, opCase.id);
    if (!fresh) {
      return NextResponse.json({ error: "case_not_found_after_lock" }, { status: 404 });
    }

    let resultCase: OperationalCase;
    let agentMeta: { pending_confirmation: boolean; response_preview: string | null } | null =
      null;
    let tickStartedAt: string | null = null;
    let internalReviewSent = false;

    if (mode === "agent_e2e") {
      tickStartedAt = new Date().toISOString();
      if (ownerResponseText && isCharacteristicsOwnerResponseSimulation(body)) {
        const deterministic =
          await processCharacteristicsOwnerResponseDeterministically(
            db,
            fresh,
            ownerResponseText
          );
        resultCase = deterministic.case;
        internalReviewSent = deterministic.internalReviewSent;
        agentMeta = {
          pending_confirmation: false,
          response_preview: deterministic.internalReviewSent
            ? `Respuesta mergeada en property_data y revisión interna solicitada (notify_user). Campos extraídos: ${
                deterministic.parsedFields.join(", ") || "(ninguno)"
              }.`
            : `Respuesta simulada procesada sin reenviar mensajes al lead. Campos extraídos: ${
                deterministic.parsedFields.join(", ") || "(ninguno)"
              }.`,
        };
      } else {
        const e2e = await runAgentE2E(db, fresh, user.id, ownerResponseText || undefined);
        resultCase = e2e.case;
        agentMeta = e2e.agent;
      }
    } else {
      const safe = await runSafeCheck(db, fresh);
      if ("error" in safe) {
        return NextResponse.json({ error: safe.error }, { status: safe.status });
      }
      resultCase = safe.case;
    }

    const events = await db
      .from("operational_case_events")
      .select("*")
      .eq("case_id", resultCase.id)
      .order("created_at", { ascending: true })
      .limit(80);

    const toolCalls = await listToolCallsForCase(db, resultCase.id);
    const flow = await effectiveFlowForCase(db, resultCase);
    const flowProgress = buildFlowProgress({
      opCase: resultCase,
      events: (events.data ?? []) as OperationalCaseEvent[],
      flow,
      toolCalls,
    });

    const businessOutcome = ownerResponseText
      ? evaluateOwnerResponseBusinessOutcome({
          opCase: resultCase,
          toolCalls,
          pendingConfirmation: Boolean(agentMeta?.pending_confirmation),
          ownerResponseText,
          leadMessagePurpose: isCharacteristicsOwnerResponseSimulation(body)
            ? "characteristics_pending"
            : null,
          toolCallsSince: tickStartedAt,
          internalReviewSent,
        })
      : null;

    return NextResponse.json({
      ok: true,
      mode,
      owner_response_processed: Boolean(ownerResponseText),
      case: resultCase,
      events: events.data ?? [],
      toolCalls,
      flowProgress,
      agent: agentMeta,
      business_outcome: businessOutcome,
    });
  } catch (err) {
    console.error("[POST /api/operational-case-tests/run] failed:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
