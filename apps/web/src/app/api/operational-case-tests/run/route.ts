import { NextResponse } from "next/server";
import {
  createServerClient,
  associateExternalResponseWithCase,
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
  PendingConfirmation,
} from "@agents/types";
import {
  isControlledE2EOperationalCase,
  isSettingsOperationalTestCase,
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
import { sendTelegramMessage } from "@/lib/telegram/send-message";
import {
  buildSettingsTestCaseResponse,
  effectiveFlowForCaseType,
} from "@/lib/operational-cases/settings-test-case-response";
import { buildLastE2ETransitionOutcome } from "@/lib/operational-cases/settings-test-e2e-transitions";
import { runSettingsTestSafeCheck } from "@/lib/operational-cases/settings-test-safe-check";
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

function isConversationalIntakeIncomplete(opCase: OperationalCase) {
  return (
    opCase.context_jsonb?.created_from === "agent_conversation" &&
    opCase.current_step === "intake" &&
    opCase.context_jsonb?.intake_status !== "complete"
  );
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
      pendingConfirmation: tick.pendingConfirmation,
      response_preview: tick.response_preview,
    },
  };
}

async function sendPendingConfirmationToLinkedTelegram(
  db: ReturnType<typeof createServerClient>,
  userId: string,
  pending: PendingConfirmation | null | undefined
) {
  if (!pending) return false;
  const { data, error } = await db
    .from("telegram_accounts")
    .select("chat_id")
    .eq("user_id", userId)
    .order("linked_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data?.chat_id) return false;
  try {
    await sendTelegramMessage(Number(data.chat_id), pending.message, {
      inline_keyboard: [
        [
          {
            text: "✅ Aprobar",
            callback_data: `approve:${pending.toolCallId}`,
          },
          {
            text: "❌ Cancelar",
            callback_data: `reject:${pending.toolCallId}`,
          },
        ],
      ],
    });
    return true;
  } catch (error) {
    console.warn(
      "[operational-case-tests/run] telegram pending confirmation send failed:",
      error
    );
    return false;
  }
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
    const settingsTestCase = isSettingsOperationalTestCase(opCase);
    const conversationalCase =
      opCase.context_jsonb?.created_from === "agent_conversation";
    if (!settingsTestCase && !conversationalCase) {
      return NextResponse.json(
        { error: "not_a_lab_or_conversational_case" },
        { status: 400 }
      );
    }
    if (mode === "safe_check" && !settingsTestCase) {
      return NextResponse.json(
        { error: "safe_check_requires_settings_test_case" },
        { status: 400 }
      );
    }
    if (ownerResponseText) {
      let caseForOwnerResponse = opCase;
      await expireExternalContactNotificationsForCase(db, opCase.id);
      if (settingsTestCase && isCharacteristicsOwnerResponseSimulation(body)) {
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

    let caseBeforeLock = ownerResponseText
      ? await getOperationalCase(db, opCase.id)
      : opCase;
    if (!caseBeforeLock) {
      return NextResponse.json({ error: "case_not_found_after_owner_response" }, { status: 404 });
    }
    if (
      mode === "agent_e2e" &&
      !settingsTestCase &&
      !isControlledE2EOperationalCase(caseBeforeLock)
    ) {
      const adopted = await updateOperationalCase(
        db,
        caseBeforeLock.id,
        caseBeforeLock.version,
        {
          nextActionAt: null,
          context: {
            ...(caseBeforeLock.context_jsonb ?? {}),
            e2e_controlled: true,
            e2e_control_source: "settings_agent_test",
            e2e_control_case_type: caseBeforeLock.case_type,
            e2e_control_status:
              caseBeforeLock.current_step === "intake"
                ? "intake"
                : "ready_for_manual_tick",
            e2e_control_started_at:
              typeof caseBeforeLock.context_jsonb?.e2e_control_started_at ===
              "string"
                ? caseBeforeLock.context_jsonb.e2e_control_started_at
                : new Date().toISOString(),
          },
        }
      );
      if (!adopted) {
        return NextResponse.json({ error: "case_adoption_conflict" }, { status: 409 });
      }
      caseBeforeLock = adopted;
    }

    if (mode === "agent_e2e" && isConversationalIntakeIncomplete(caseBeforeLock)) {
      const caseType = await getOperationalCaseTypeById(
        db,
        caseBeforeLock.case_type_id
      );
      const flow = caseType ? await effectiveFlowForCaseType(db, caseType) : [];
      return NextResponse.json({
        ...(await buildSettingsTestCaseResponse(db, caseBeforeLock, user.id, flow)),
        skipped: true,
        skipped_reason: "conversational_intake_incomplete",
        hint:
          "Completa el intake por Telegram antes de ejecutar una revisión E2E con agente.",
      });
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
    let agentMeta: {
      pending_confirmation: boolean;
      pendingConfirmation?: PendingConfirmation | null;
      response_preview: string | null;
      telegram_sent?: boolean;
    } | null = null;
    let tickStartedAt: string | null = null;
    let internalReviewSent = false;

    const stepBeforeE2E = fresh.current_step ?? null;
    const statusBeforeE2E = fresh.status ?? null;

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
        if (agentMeta.pendingConfirmation) {
          agentMeta.telegram_sent = await sendPendingConfirmationToLinkedTelegram(
            db,
            user.id,
            agentMeta.pendingConfirmation
          );
        }
      }
    } else {
      const caseType = await getOperationalCaseTypeById(db, fresh.case_type_id);
      const flow = caseType ? await effectiveFlowForCaseType(db, caseType) : [];
      const safe = await runSettingsTestSafeCheck(db, fresh, {
        activationPolicy: caseType?.activation_policy_jsonb,
        flow,
      });
      if ("error" in safe) {
        return NextResponse.json({ error: safe.error }, { status: safe.status });
      }
      resultCase = safe.case;
    }

    const telegramSentToolCallId =
      agentMeta?.telegram_sent && agentMeta.pendingConfirmation?.toolCallId
        ? agentMeta.pendingConfirmation.toolCallId
        : null;
    const caseType = await getOperationalCaseTypeById(db, resultCase.case_type_id);
    const flow = caseType ? await effectiveFlowForCaseType(db, caseType) : [];
    const testCasePayload = await buildSettingsTestCaseResponse(
      db,
      resultCase,
      user.id,
      flow,
      { telegramSentForToolCallId: telegramSentToolCallId }
    );
    const { toolCalls } = testCasePayload;

    const businessOutcome = ownerResponseText
      ? evaluateOwnerResponseBusinessOutcome({
          opCase: testCasePayload.case,
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

    const last_transition =
      mode === "agent_e2e"
        ? buildLastE2ETransitionOutcome({
            stepBefore: stepBeforeE2E,
            stepAfter: testCasePayload.case.current_step ?? null,
            statusBefore: statusBeforeE2E,
            statusAfter: testCasePayload.case.status ?? null,
            responsePreview: agentMeta?.response_preview ?? null,
            pendingConfirmation: agentMeta?.pending_confirmation,
          })
        : null;

    return NextResponse.json({
      mode,
      owner_response_processed: Boolean(ownerResponseText),
      ...testCasePayload,
      agent: agentMeta,
      business_outcome: businessOutcome,
      last_transition,
    });
  } catch (err) {
    console.error("[POST /api/operational-case-tests/run] failed:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
