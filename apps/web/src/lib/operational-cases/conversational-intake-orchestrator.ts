/**
 * Motor de intake conversacional compartido entre canales (chat web y Telegram).
 *
 * Concentra las PROTECCIONES de intake que originalmente vivían sólo en el
 * webhook de Telegram, de modo que ambos canales operen con las mismas reglas:
 *
 *  1. Primer prompt de campos faltantes al crear un caso conversacional.
 *  2. Recuperación de desincronía (reopen) cuando llega data de intake pero el
 *     caso ya avanzó de paso sin haber completado el intake.
 *  3. Actualización determinística del intake (parser + clasificador LLM),
 *     recalculando `missing_required` y avanzando el estado cuando se completa.
 *
 * Es agnóstico de canal: NO envía mensajes. Realiza los efectos en DB
 * (update de caso, eventos, bindings) y devuelve `responseText` para que cada
 * adapter lo entregue por su medio (Telegram: `sendTelegramMessage`; web:
 * respuesta JSON del chat). Las etiquetas de telemetría (`source`) preservan los
 * strings históricos de Telegram para no romper trazabilidad.
 */
import {
  createServerClient,
  getOperationalCase,
  getOperationalCaseTypeForUser,
  getRecentOperationalCaseEvents,
  insertOperationalCaseEvent,
  listOperationalCaseDocuments,
  updateOperationalCase,
  upsertConversationBinding,
} from "@agents/db";
import {
  buildOperationalCaseIntakeUpdateContext,
  isPropertyOptioningIntent,
} from "@agents/agent";
import type { OperationalCase, OperationalCaseIntakeField } from "@agents/types";
import {
  extractConservativeIntakePatch,
  mergeIntakePatches,
  normalizeIntakePatchValues,
} from "./property-optioning-intake-extraction";
import { classifyOperationalConversationMessage } from "./operational-conversation-classifier";
import {
  buildTelegramIntakeCompletionMessage,
  isIntakeInProgress,
} from "./telegram-intake-completion-message";
import {
  buildOperationalCaseContinuationReprompt,
  buildPostIntakeDocumentRequestMessage,
  recordDocumentFlowReminder,
  shouldPromptCaseDocumentRequestTarget,
} from "./document-request-target";

type DbClient = ReturnType<typeof createServerClient>;

export type ConversationalIntakeRoute =
  | "intake_missing_fields_requested"
  | "intake_reopen_blocked"
  | "intake_still_missing"
  | "intake_updated_incomplete"
  | "intake_completed"
  | "case_continuation_reprompt"
  | "delegate_to_agent";

export interface ResolveConversationalIntakeTurnResult {
  /** `false` sólo cuando el turno no corresponde al intake (delegar al agente). */
  handled: boolean;
  route: ConversationalIntakeRoute;
  /** Caso (posiblemente actualizado) tras procesar el turno. */
  updatedCase: OperationalCase;
  /** Mensaje a entregar al usuario por el canal; `null` si no aplica. */
  responseText: string | null;
  intakeCompletedNow: boolean;
  /** El adapter debe intentar el tick E2E post-intake (sólo casos E2E). */
  shouldRunPostIntakeE2ETick: boolean;
}

/** Prefijo de telemetría que preserva los strings históricos de Telegram. */
function channelSourceBase(channel: "web" | "telegram"): string {
  return channel === "telegram" ? "telegram_webhook" : "web";
}

export function firstOperationalStepAfterIntake(flow: unknown): string {
  if (!Array.isArray(flow)) return "awaiting_documents";
  const steps = flow.filter(
    (step): step is { step_key?: unknown } =>
      Boolean(step) && typeof step === "object"
  );
  const intakeIndex = steps.findIndex((step) => step.step_key === "intake");
  const nextStep =
    intakeIndex >= 0 ? steps[intakeIndex + 1]?.step_key : steps[0]?.step_key;
  return typeof nextStep === "string" && nextStep.trim()
    ? nextStep.trim()
    : "awaiting_documents";
}

export function buildMissingIntakeFieldsPrompt(missingFields: unknown[]): string {
  const labels = missingFields
    .map((field) => {
      if (!field || typeof field !== "object" || Array.isArray(field)) return null;
      const record = field as Record<string, unknown>;
      const label =
        typeof record.label === "string" && record.label.trim()
          ? record.label.trim()
          : typeof record.name === "string" && record.name.trim()
            ? record.name.trim()
            : null;
      return label;
    })
    .filter((label): label is string => Boolean(label));

  const withExamples = (label: string): string => {
    const normalized = label
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
    if (/operacion/.test(normalized)) {
      return "Operación aplicable (ej., Venta, Renta, Venta y Renta)";
    }
    if (/tipo de propiedad|property_type/.test(normalized)) {
      return "Tipo de propiedad (ej., Casa, Departamento, Terreno, etc.)";
    }
    // Strip trailing colon if the schema label included one.
    return label.replace(/:\s*$/, "");
  };

  const fallback = [
    "Título / propiedad",
    "Zona / colonia",
    "Operación aplicable (ej., Venta, Renta, Venta y Renta)",
    "Tipo de propiedad (ej., Casa, Departamento, Terreno, etc.)",
  ];
  const items = (labels.length > 0 ? labels.map(withExamples) : fallback)
    .map((label, index) => `${index + 1}. ${label}`)
    .join("\n");

  return [
    "Para iniciar el proceso de opción de la propiedad, necesito estos datos:",
    "",
    items,
    "",
    "Compártemelos en un solo mensaje.",
  ].join("\n");
}

export function buildIntakeProgressPrompt(params: {
  context: Record<string, unknown> | null | undefined;
  missingFields: unknown[];
}): string {
  const context = params.context ?? {};
  const captured = [
    ["Título / propiedad", context.property_title],
    ["Zona / colonia", context.property_zone],
    ["Operación aplicable", context.operation_type],
    ["Tipo de propiedad", context.property_type],
  ]
    .filter(([, value]) => typeof value === "string" && (value as string).trim())
    .map(([label, value]) => `- ${label}: ${String(value).trim()}`);
  const missingPrompt = buildMissingIntakeFieldsPrompt(params.missingFields);
  if (captured.length === 0) return missingPrompt;
  return [
    "Perfecto, ya registré estos datos:",
    "",
    ...captured,
    "",
    missingPrompt,
  ].join("\n");
}

/**
 * Decide, de forma pura, si un caso fuera de `intake` con intake incompleto
 * puede reabrirse para continuar la recolección. No debe reabrirse si ya hay
 * documentos recibidos o una decisión humana posterior a la entrada a intake,
 * para no pisar actividad operativa.
 */
export function decideIntakeReopen(params: {
  documentsReceived: number;
  recentEvents: Array<{
    event_type: string;
    created_at: string;
    payload_jsonb?: unknown;
  }>;
}): { canReopen: boolean; hasHumanDecisionAfterIntake: boolean } {
  const lastIntakeTimestamp = params.recentEvents.reduce<string | null>(
    (latest, event) => {
      if (event.event_type !== "state_changed") return latest;
      const payload =
        event.payload_jsonb && typeof event.payload_jsonb === "object"
          ? (event.payload_jsonb as Record<string, unknown>)
          : null;
      const payloadStep =
        typeof payload?.current_step === "string" ? payload.current_step : null;
      const toStep =
        payload?.to && typeof payload.to === "object"
          ? (payload.to as Record<string, unknown>).current_step
          : null;
      const enteredIntake =
        payloadStep === "intake" ||
        toStep === "intake" ||
        payload?.kind === "case_created";
      if (!enteredIntake) return latest;
      if (!latest || event.created_at > latest) return event.created_at;
      return latest;
    },
    null
  );
  const hasHumanDecisionAfterIntake = params.recentEvents.some((event) => {
    if (event.event_type !== "human_decision") return false;
    if (!lastIntakeTimestamp) return true;
    return event.created_at > lastIntakeTimestamp;
  });
  return {
    canReopen: params.documentsReceived === 0 && !hasHumanDecisionAfterIntake,
    hasHumanDecisionAfterIntake,
  };
}

export async function resolveConversationalIntakeTurn(params: {
  db: DbClient;
  userId: string;
  sessionId: string;
  opCase: OperationalCase;
  message: string;
  channel: "web" | "telegram";
  /** `true` si el caso se acaba de crear en este mismo turno. */
  justCreated: boolean;
  /** Chat del operador (Telegram) para bindings; ausente en web. */
  chatId?: number;
}): Promise<ResolveConversationalIntakeTurnResult> {
  const { db, userId, sessionId, channel, message, chatId } = params;
  let opCase = params.opCase;
  const base = channelSourceBase(channel);

  const notHandled = (): ResolveConversationalIntakeTurnResult => ({
    handled: false,
    route: "delegate_to_agent",
    updatedCase: opCase,
    responseText: null,
    intakeCompletedNow: false,
    shouldRunPostIntakeE2ETick: false,
  });

  // (A) Primer prompt al crear el caso — o al re-expresar intención de inicio
  // sin datos de intake en el mensaje (p. ej. "quiero opcionar una propiedad").
  const startIntentWithoutIntakeData =
    isPropertyOptioningIntent(message) &&
    Object.keys(
      normalizeIntakePatchValues(extractConservativeIntakePatch(message))
    ).length === 0;
  if (
    (params.justCreated || startIntentWithoutIntakeData) &&
    opCase.current_step === "intake" &&
    opCase.context_jsonb?.intake_status !== "complete"
  ) {
    await insertOperationalCaseEvent(db, {
      caseId: opCase.id,
      eventType: "reminder_sent",
      actor: "system",
      payload: {
        kind: "intake_fields_requested",
        source: `${base}_deterministic_intake`,
        current_step: "intake",
        missing_required: opCase.context_jsonb?.missing_required ?? [],
      },
    });
    return {
      handled: true,
      route: "intake_missing_fields_requested",
      updatedCase: opCase,
      responseText: buildIntakeProgressPrompt({
        context: opCase.context_jsonb,
        missingFields:
          (opCase.context_jsonb?.missing_required as unknown[]) ?? [],
      }),
      intakeCompletedNow: false,
      shouldRunPostIntakeE2ETick: false,
    };
  }

  // (A2) Re-expresión de intención de inicio sobre un caso que YA pasó intake
  // (p. ej. "quiero opcionar una propiedad" tras confirmar "continuar este
  // caso"). No reabrimos intake ni delegamos al LLM —que improvisaría un
  // formulario de intake equivocado—: reconfirmamos el estado del caso y la
  // acción esperada del paso actual de forma determinística.
  if (
    startIntentWithoutIntakeData &&
    opCase.current_step !== "intake" &&
    opCase.context_jsonb?.intake_status === "complete"
  ) {
    return {
      handled: true,
      route: "case_continuation_reprompt",
      updatedCase: opCase,
      responseText: buildOperationalCaseContinuationReprompt(opCase),
      intakeCompletedNow: false,
      shouldRunPostIntakeE2ETick: false,
    };
  }

  if (!message) return notHandled();

  // (B) Recuperación de desincronía: el caso avanzó de paso pero el intake no
  // se completó y llega data de intake. Reabrimos para continuar (o bloqueamos).
  if (
    opCase.context_jsonb?.created_from === "agent_conversation" &&
    opCase.current_step !== "intake" &&
    opCase.context_jsonb?.intake_status !== "complete"
  ) {
    const deterministicPatch = normalizeIntakePatchValues(
      extractConservativeIntakePatch(message)
    );
    let looksLikeIntakeContinuation = Object.keys(deterministicPatch).length > 0;
    if (!looksLikeIntakeContinuation) {
      const intakeClassification = await classifyOperationalConversationMessage({
        message,
        stage: "intake",
        caseSummary: [
          opCase.context_jsonb?.property_title,
          opCase.context_jsonb?.property_zone,
          opCase.context_jsonb?.operation_type,
          opCase.context_jsonb?.property_type,
          `current_step=${opCase.current_step}`,
          `intake_status=${String(opCase.context_jsonb?.intake_status ?? "")}`,
        ]
          .filter((value) => typeof value === "string" && value.trim())
          .join(" · "),
      });
      looksLikeIntakeContinuation = Boolean(
        intakeClassification &&
          (intakeClassification.intent === "provide_intake" ||
            intakeClassification.intent === "start_case")
      );
    }
    if (looksLikeIntakeContinuation) {
      const [documents, recentEvents] = await Promise.all([
        listOperationalCaseDocuments(db, {
          caseId: opCase.id,
          statuses: ["received"],
        }),
        getRecentOperationalCaseEvents(db, opCase.id, 80),
      ]);
      const { canReopen, hasHumanDecisionAfterIntake } = decideIntakeReopen({
        documentsReceived: documents.length,
        recentEvents,
      });
      if (canReopen) {
        const fromStepBeforeReopen = opCase.current_step;
        const reopenedCase = await updateOperationalCase(
          db,
          opCase.id,
          opCase.version,
          {
            status: "waiting_internal",
            currentStep: "intake",
            nextActionAt: null,
          }
        );
        if (reopenedCase) {
          opCase = reopenedCase;
          await insertOperationalCaseEvent(db, {
            caseId: reopenedCase.id,
            eventType: "state_changed",
            actor: "system",
            payload: {
              kind: "conversational_intake_reopened",
              source: `${base}_desync_recovery`,
              from_step: fromStepBeforeReopen,
              to_step: "intake",
              reason: "intake_incomplete_desync",
            },
          });
        }
        // Cae al bloque (C) para aplicar el patch sobre el caso reabierto.
      } else {
        await insertOperationalCaseEvent(db, {
          caseId: opCase.id,
          eventType: "error",
          actor: "system",
          payload: {
            kind: "conversational_intake_reopen_blocked",
            source: `${base}_desync_recovery`,
            current_step: opCase.current_step,
            intake_status: opCase.context_jsonb?.intake_status ?? null,
            documents_received: documents.length,
            has_human_decision_after_intake: hasHumanDecisionAfterIntake,
          },
        });
        return {
          handled: true,
          route: "intake_reopen_blocked",
          updatedCase: opCase,
          responseText:
            "Detecté datos de intake, pero este caso ya avanzó a una etapa operativa con actividad registrada. Para evitar inconsistencias, continuaré con el paso actual. Si deseas reiniciar el registro del caso, indícalo explícitamente.",
          intakeCompletedNow: false,
          shouldRunPostIntakeE2ETick: false,
        };
      }
    }
  }

  // (C) Actualización determinística del intake en curso.
  if (
    opCase.current_step === "intake" &&
    opCase.context_jsonb?.intake_status !== "complete"
  ) {
    const caseType = await getOperationalCaseTypeForUser(
      db,
      opCase.user_id,
      opCase.case_type
    );
    if (!caseType) return notHandled();

    const deterministicPatch = normalizeIntakePatchValues(
      extractConservativeIntakePatch(message)
    );
    const intakeClassification = await classifyOperationalConversationMessage({
      message,
      stage: "intake",
      caseSummary: [
        opCase.context_jsonb?.property_title,
        opCase.context_jsonb?.property_zone,
        opCase.context_jsonb?.operation_type,
        opCase.context_jsonb?.property_type,
        `missing_required=${JSON.stringify(
          opCase.context_jsonb?.missing_required ?? []
        )}`,
      ]
        .filter((value) => typeof value === "string" && value.trim())
        .join(" · "),
    });
    const llmPatch =
      intakeClassification &&
      (intakeClassification.intent === "provide_intake" ||
        intakeClassification.intent === "start_case")
        ? normalizeIntakePatchValues(intakeClassification.patch ?? {})
        : {};
    const intakePatch = mergeIntakePatches(llmPatch, deterministicPatch);

    if (Object.keys(intakePatch).length === 0) {
      await upsertConversationBinding(db, {
        userId,
        caseId: opCase.id,
        caseType: opCase.case_type,
        channel,
        chatId,
        sessionId,
        status: "awaiting_user",
        awaitingFields:
          (opCase.context_jsonb?.missing_required as unknown[]) ?? [],
        metadata: { source: `${base}_intake_still_missing` },
      });
      return {
        handled: true,
        route: "intake_still_missing",
        updatedCase: opCase,
        responseText: buildIntakeProgressPrompt({
          context: opCase.context_jsonb,
          missingFields:
            (opCase.context_jsonb?.missing_required as unknown[]) ?? [],
        }),
        intakeCompletedNow: false,
        shouldRunPostIntakeE2ETick: false,
      };
    }

    const intakeSchema =
      (caseType.intake_schema_jsonb as
        | readonly OperationalCaseIntakeField[]
        | undefined) ?? [];
    const buildIntakeUpdate = (existingContext: Record<string, unknown>) =>
      buildOperationalCaseIntakeUpdateContext({
        existingContext,
        intakePatch,
        intakeSchema,
        e2eControlled: existingContext.e2e_controlled === true,
        channel,
      });
    let intakeUpdate = buildIntakeUpdate(
      (opCase.context_jsonb as Record<string, unknown>) ?? {}
    );
    const nextStep = intakeUpdate.complete
      ? firstOperationalStepAfterIntake(caseType.operational_flow_jsonb)
      : "intake";
    let updatedCase = await updateOperationalCase(db, opCase.id, opCase.version, {
      status: intakeUpdate.complete ? "active" : "waiting_internal",
      currentStep: nextStep,
      nextActionAt:
        opCase.context_jsonb?.e2e_controlled === true
          ? null
          : new Date().toISOString(),
      context: intakeUpdate.context,
    });
    if (!updatedCase) {
      // Conflicto de versión: reintentar con la versión fresca.
      const fresh = await getOperationalCase(db, opCase.id);
      if (fresh) {
        intakeUpdate = buildIntakeUpdate(
          (fresh.context_jsonb as Record<string, unknown>) ?? {}
        );
        const retryNextStep = intakeUpdate.complete
          ? firstOperationalStepAfterIntake(caseType.operational_flow_jsonb)
          : "intake";
        updatedCase = await updateOperationalCase(db, fresh.id, fresh.version, {
          status: intakeUpdate.complete ? "active" : "waiting_internal",
          currentStep: retryNextStep,
          nextActionAt:
            fresh.context_jsonb?.e2e_controlled === true
              ? null
              : new Date().toISOString(),
          context: intakeUpdate.context,
        });
        if (!updatedCase) {
          updatedCase = fresh;
        }
      }
    }
    updatedCase = updatedCase ?? opCase;
    const persistedMissing =
      ((updatedCase.context_jsonb?.missing_required as unknown[]) ??
        intakeUpdate.missing) ||
      [];
    const intakeCompletedNow = !isIntakeInProgress(updatedCase);
    await insertOperationalCaseEvent(db, {
      caseId: updatedCase.id,
      eventType: intakeCompletedNow ? "step_completed" : "state_changed",
      actor: "system",
      payload: {
        source: `${base}_deterministic_intake_update`,
        current_step: updatedCase.current_step,
        intake_status: intakeCompletedNow ? "complete" : "incomplete",
        intake_patch: intakeUpdate.intakePatch,
        missing_required: persistedMissing,
      },
    });
    await upsertConversationBinding(db, {
      userId,
      caseId: updatedCase.id,
      caseType: updatedCase.case_type,
      channel,
      chatId,
      sessionId,
      status: "awaiting_user",
      awaitingFields: persistedMissing,
      metadata: { source: `${base}_deterministic_intake_update` },
    });

    if (intakeCompletedNow) {
      if (shouldPromptCaseDocumentRequestTarget(updatedCase)) {
        await recordDocumentFlowReminder({
          db,
          caseId: updatedCase.id,
          purpose: "documents_checklist_post_intake",
          channel,
          source: `${base}_deterministic_intake_completed`,
          audience: "internal_user",
        });
        return {
          handled: true,
          route: "intake_completed",
          updatedCase,
          responseText: buildPostIntakeDocumentRequestMessage(updatedCase),
          intakeCompletedNow: true,
          shouldRunPostIntakeE2ETick: false,
        };
      }
      return {
        handled: true,
        route: "intake_completed",
        updatedCase,
        responseText: buildTelegramIntakeCompletionMessage(updatedCase),
        intakeCompletedNow: true,
        shouldRunPostIntakeE2ETick:
          updatedCase.context_jsonb?.e2e_controlled === true,
      };
    }

    return {
      handled: true,
      route: "intake_updated_incomplete",
      updatedCase,
      responseText: buildIntakeProgressPrompt({
        context:
          (updatedCase.context_jsonb as Record<string, unknown> | null | undefined) ??
          intakeUpdate.context,
        missingFields: persistedMissing,
      }),
      intakeCompletedNow: false,
      shouldRunPostIntakeE2ETick: false,
    };
  }

  return notHandled();
}
