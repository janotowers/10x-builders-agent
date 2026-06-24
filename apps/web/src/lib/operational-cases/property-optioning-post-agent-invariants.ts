import {
  buildPropertyDataMinimumsSummaryMessage,
  documentExtractionMinimumsContext,
  evaluatePropertyAdvanceGate,
  evaluatePropertyDataMinimumsForReview,
  runDocumentFieldExtraction,
  type PropertyAdvanceGateBlock,
} from "@agents/agent";
import {
  createServerClient,
  getRecentOperationalCaseEvents,
  insertOperationalCaseEvent,
  listOperationalCaseDocuments,
  updateOperationalCase,
} from "@agents/db";
import {
  operationalCaseDocumentRequestTargetFromContext,
  type OperationalCase,
} from "@agents/types";
import { notify } from "@/lib/notify";
import { sendTelegramMessage } from "@/lib/telegram/send-message";

type ApplyPropertyOptioningPostAgentInvariantsResult = {
  case: OperationalCase | null;
  action:
    | "not_applicable"
    | "no_action"
    | "deferred_pending_extraction"
    | "remediated_extraction"
    | "escalated_extraction_to_human"
    | "asked_missing_characteristics"
    | "asked_missing_characteristics_internal"
    | "asked_missing_characteristics_again"
    | "asked_missing_characteristics_again_internal"
    | "requested_property_data_review";
};

/**
 * Circuit breaker para la auto-remediación determinística de extracción (WS3).
 * Tras N intentos sin lograr extraer un documento, dejamos de reintentar y
 * escalamos a humano en vez de congelar el caso (sub-decisión A).
 */
const MAX_EXTRACTION_REMEDIATION_ATTEMPTS = (() => {
  const raw = Number(process.env.DOCUMENT_EXTRACTION_MAX_REMEDIATION_ATTEMPTS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 3;
})();

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function positiveNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value.replace(/,/g, ""));
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function surfaceSourceScore(value: unknown): number {
  if (typeof value !== "string") return 0;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return 0;
  if (normalized.includes("predial")) return 4;
  if (normalized.includes("boleta")) return 3;
  if (normalized.includes("escritura")) return 2;
  if (normalized.includes("documento")) return 1;
  return 0;
}

type MergeDocumentSurfacesResult = {
  context: Record<string, unknown>;
  changed: boolean;
  adopted: {
    area_total_m2?: number;
    area_construida_m2?: number;
  };
};

export function mergeDocumentSurfacesIntoContextPropertyData(input: {
  context: Record<string, unknown> | null | undefined;
  documentFields: Record<string, unknown>;
}): MergeDocumentSurfacesResult {
  const baseContext = asRecord(input.context) ?? {};
  const basePropertyData = asRecord(baseContext.property_data) ?? {};
  const documentFields = input.documentFields;
  const nextContext: Record<string, unknown> = {
    ...baseContext,
    property_data: { ...basePropertyData },
  };
  const nextPropertyData = nextContext.property_data as Record<string, unknown>;
  const adopted: MergeDocumentSurfacesResult["adopted"] = {};
  let changed = false;

  const maybeAdopt = (field: "area_total_m2" | "area_construida_m2") => {
    const sourceField = `${field}_source` as const;
    const incoming = positiveNumberOrNull(documentFields[field]);
    if (incoming == null) return;
    const existing = positiveNumberOrNull(nextPropertyData[field]);
    const incomingSource = documentFields[sourceField];
    const existingSource = nextPropertyData[sourceField];
    const shouldAdopt =
      existing == null ||
      surfaceSourceScore(incomingSource) > surfaceSourceScore(existingSource) ||
      (typeof incomingSource === "string" &&
        incomingSource.toLowerCase().includes("predial") &&
        incoming !== existing);
    if (!shouldAdopt) return;

    nextPropertyData[field] = incoming;
    if (incomingSource != null && incomingSource !== "") {
      nextPropertyData[sourceField] = incomingSource;
    }
    // Backfill top-level context for legacy readers outside property_data.
    nextContext[field] = incoming;
    if (incomingSource != null && incomingSource !== "") {
      nextContext[sourceField] = incomingSource;
    }
    adopted[field] = incoming;
    changed = true;
  };

  maybeAdopt("area_total_m2");
  maybeAdopt("area_construida_m2");

  return { context: nextContext, changed, adopted };
}

function remediationAttemptsFromContext(
  context: Record<string, unknown> | null | undefined
): Record<string, number> {
  const raw = context?.extraction_remediation_attempts;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

function deterministicDocumentIdsFromBlocks(
  blocks: PropertyAdvanceGateBlock[]
): string[] {
  const ids = new Set<string>();
  for (const block of blocks) {
    if (block.remediation.owner !== "deterministic") continue;
    for (const id of block.remediation.document_ids ?? []) ids.add(id);
  }
  return [...ids];
}

function isPropertyOptioningDocumentsReviewPoint(opCase: OperationalCase) {
  return (
    opCase.case_type === "property_optioning" &&
    opCase.current_step === "documents_received" &&
    opCase.status === "waiting_internal"
  );
}

function operationLabel(value: unknown): string {
  if (Array.isArray(value) && value.length > 0) {
    return operationLabel(value[0]);
  }
  if (typeof value !== "string") return "pendiente";
  const normalized = value.trim().toLowerCase();
  if (!normalized) return "pendiente";
  if (normalized === "sale" || normalized === "venta") return "Venta";
  if (normalized === "rent" || normalized === "renta") return "Renta";
  return value.trim();
}

function propertyDataReviewTextFromContext(params: {
  opCase: OperationalCase;
  documentFields: Record<string, unknown>;
}) {
  const context = params.opCase.context_jsonb ?? {};
  const propertyData =
    context.property_data &&
    typeof context.property_data === "object" &&
    !Array.isArray(context.property_data)
      ? (context.property_data as Record<string, unknown>)
      : {};
  const merged = { ...context, ...propertyData, ...params.documentFields };
  const value = (key: string) => {
    const raw = merged[key];
    if (Array.isArray(raw)) return raw.filter(Boolean).join("; ");
    if (raw && typeof raw === "object") {
      const record = raw as Record<string, unknown>;
      return String(record.full ?? record.formatted ?? record.street ?? "").trim();
    }
    return raw == null ? "" : String(raw).trim();
  };
  const additionalProvided = [
    ["Número de plantas o pisos", value("floors")],
    ["Número de recámaras", value("bedrooms")],
    ["Número de baños completos", value("bathrooms")],
    ["Número de medios baños", value("half_bathrooms")],
    [
      "Cocina integral",
      typeof merged.integral_kitchen === "boolean"
        ? merged.integral_kitchen
          ? "Sí"
          : "No"
        : "",
    ],
  ]
    .filter(([, provided]) => provided && String(provided).trim())
    .map(([label, provided]) => `- ${label}: ${String(provided).trim()}`);
  return [
    `Revisión de datos extraídos para el caso ${params.opCase.id}:`,
    "",
    "Datos iniciales confirmados:",
    `- Título / propiedad: ${String(context.property_title ?? context.title ?? "pendiente")}`,
    `- Zona / colonia: ${String(context.property_zone ?? "pendiente")}`,
    `- Operación: ${operationLabel(context.operation_type)}`,
    `- Tipo de propiedad: ${String(context.property_type ?? "pendiente")}`,
    "",
    "Datos encontrados en documentos:",
    `- Dueño/titular: ${value("owner_names") || "pendiente"}`,
    value("owner_names_source")
      ? `- Fuente de titularidad: ${value("owner_names_source")}`
      : null,
    value("owner_consistency_note")
      ? `- Verificación de titularidad: ${value("owner_consistency_note")}`
      : null,
    value("owner_consistency_warning")
      ? `- Advertencia de titularidad: ${value("owner_consistency_warning")}`
      : null,
    `- Dirección legal: ${
      value("legal_addresses") ||
      value("legal_address") ||
      value("property_address") ||
      value("address") ||
      "pendiente"
    }`,
    `- Superficie terreno: ${value("area_total_m2") || "pendiente"} m²`,
    `- Superficie construcción: ${value("area_construida_m2") || "pendiente"} m²`,
    value("land_context")
      ? `- Contexto del terreno: ${value("land_context")}`
      : null,
    "",
    "Datos adicionales provistos:",
    ...(additionalProvided.length > 0
      ? additionalProvided
      : ["- Sin datos adicionales confirmados aún."]),
    "",
    "Faltantes o dudas:",
    "- Ninguno mínimo detectado.",
    "",
    "Confirma si es correcto o indícame correcciones puntuales.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export async function applyPropertyOptioningPostAgentInvariants(params: {
  db: ReturnType<typeof createServerClient>;
  opCase: OperationalCase | null;
  source: string;
}): Promise<ApplyPropertyOptioningPostAgentInvariantsResult> {
  const { db, opCase, source } = params;
  if (!opCase) return { case: null, action: "not_applicable" };
  if (!isPropertyOptioningDocumentsReviewPoint(opCase)) {
    return { case: opCase, action: "not_applicable" };
  }

  let workingCase: OperationalCase = opCase;
  let workingDocuments = await listOperationalCaseDocuments(db, {
    caseId: workingCase.id,
    statuses: ["received"],
  });
  const recentEvents = await getRecentOperationalCaseEvents(db, workingCase.id, 30);

  // Fuente única de verdad: gate de avance a comparables (WS1/WS2). La
  // corroboración de titularidad NO bloquea aquí; es gate de contract_pending.
  let gate = evaluatePropertyAdvanceGate({
    documents: workingDocuments,
    context: workingCase.context_jsonb,
    targetTransition: "comparables_in_progress",
  });
  let deterministicIds = deterministicDocumentIdsFromBlocks(gate.blocks);

  // --- Auto-remediación determinística + circuit breaker (WS3) ------------
  // El bloqueo por extracción ya no es terminal: el código intenta extraer él
  // mismo (texto PDF + Vision) los documentos pendientes que aún tengan
  // presupuesto, re-evalúa una vez, y solo escala a humano tras agotar N
  // intentos. Nunca deja el caso en limbo silencioso.
  if (deterministicIds.length > 0) {
    const attempts = remediationAttemptsFromContext(workingCase.context_jsonb);
    const remediable = deterministicIds.filter(
      (id) => (attempts[id] ?? 0) < MAX_EXTRACTION_REMEDIATION_ATTEMPTS
    );
    if (remediable.length > 0) {
      for (const documentId of remediable) {
        attempts[documentId] = (attempts[documentId] ?? 0) + 1;
        try {
          await runDocumentFieldExtraction(db, {
            userId: workingCase.user_id,
            documentId,
            force: true,
          });
        } catch {
          // El fallo cuenta como intento; el breaker escalará si persiste.
        }
      }
      const persisted = await updateOperationalCase(
        db,
        workingCase.id,
        workingCase.version,
        {
          context: {
            ...(workingCase.context_jsonb ?? {}),
            extraction_remediation_attempts: attempts,
          },
        }
      );
      workingCase = persisted ?? workingCase;
      workingDocuments = await listOperationalCaseDocuments(db, {
        caseId: workingCase.id,
        statuses: ["received"],
      });
      await insertOperationalCaseEvent(db, {
        caseId: workingCase.id,
        eventType: "state_changed",
        actor: "system",
        payload: {
          kind: "extraction_auto_remediation_attempted",
          source,
          document_ids: remediable,
          attempts,
        },
      });
      gate = evaluatePropertyAdvanceGate({
        documents: workingDocuments,
        context: workingCase.context_jsonb,
        targetTransition: "comparables_in_progress",
      });
      deterministicIds = deterministicDocumentIdsFromBlocks(gate.blocks);
    }

    if (deterministicIds.length > 0) {
      const attemptsNow = remediationAttemptsFromContext(workingCase.context_jsonb);
      const allExhausted = deterministicIds.every(
        (id) => (attemptsNow[id] ?? 0) >= MAX_EXTRACTION_REMEDIATION_ATTEMPTS
      );
      if (allExhausted) {
        const alreadyEscalated = recentEvents.some((event) => {
          const payload = event.payload_jsonb as Record<string, unknown> | null;
          return (
            event.event_type === "escalated" &&
            payload?.kind === "extraction_escalated_to_human"
          );
        });
        if (!alreadyEscalated) {
          const escalationText = [
            "No pude leer automáticamente algunos documentos del caso tras varios intentos.",
            "",
            `Caso: ${String(
              workingCase.context_jsonb?.property_title ??
                workingCase.context_jsonb?.title ??
                workingCase.case_type
            )}`,
            "Revisa los documentos en el caso y, si están ilegibles, pide al dueño que los reenvíe con mejor calidad.",
          ].join("\n");
          const notifyResult = await notify(
            db,
            workingCase.user_id,
            {
              text: escalationText,
              kind: "document_extraction_failed",
              data: {
                case_id: workingCase.id,
                title: "No pude leer documentos del caso",
                source,
                exhausted_document_ids: deterministicIds,
              },
            },
            "high"
          );
          await insertOperationalCaseEvent(db, {
            caseId: workingCase.id,
            eventType: "escalated",
            actor: "system",
            payload: {
              kind: "extraction_escalated_to_human",
              source,
              document_ids: deterministicIds,
              max_attempts: MAX_EXTRACTION_REMEDIATION_ATTEMPTS,
              notify_delivered: notifyResult.delivered,
            },
          });
        }
        const escalated = await updateOperationalCase(
          db,
          workingCase.id,
          workingCase.version,
          {
            status: "waiting_internal",
            currentStep: "documents_received",
            nextActionAt: null,
          }
        );
        return {
          case: escalated ?? workingCase,
          action: "escalated_extraction_to_human",
        };
      }

      // Aún con presupuesto: diferir y reintentar en el próximo tick. No es
      // terminal-silencioso porque el cron (caso real) reprograma el tick y el
      // laboratorio expone el reintento manual con el contador de intentos.
      const blockReason = gate.blocks[0]?.reason ?? "extraction_pending";
      const alreadyDeferred = recentEvents.some((event) => {
        const payload = event.payload_jsonb as Record<string, unknown> | null;
        return (
          event.event_type === "state_changed" &&
          payload?.kind === "property_data_review_deferred_pending_extraction" &&
          payload?.reason === blockReason
        );
      });
      if (!alreadyDeferred) {
        await insertOperationalCaseEvent(db, {
          caseId: workingCase.id,
          eventType: "state_changed",
          actor: "system",
          payload: {
            kind: "property_data_review_deferred_pending_extraction",
            source,
            reason: blockReason,
            pending_document_ids: deterministicIds,
          },
        });
      }
      return { case: workingCase, action: "deferred_pending_extraction" };
    }
  }

  // Recalcular tras la posible remediación determinística.
  const documentFields = documentExtractionMinimumsContext(workingDocuments);
  const mergedSurfaces = mergeDocumentSurfacesIntoContextPropertyData({
    context: workingCase.context_jsonb,
    documentFields,
  });
  if (mergedSurfaces.changed) {
    const persisted = await updateOperationalCase(
      db,
      workingCase.id,
      workingCase.version,
      { context: mergedSurfaces.context }
    );
    workingCase = persisted ?? { ...workingCase, context_jsonb: mergedSurfaces.context };
    await insertOperationalCaseEvent(db, {
      caseId: workingCase.id,
      eventType: "state_changed",
      actor: "system",
      payload: {
        kind: "document_surfaces_consolidated_to_property_data",
        source,
        adopted: mergedSurfaces.adopted,
      },
    });
  }
  const minimums = evaluatePropertyDataMinimumsForReview(
    workingCase.context_jsonb,
    documentFields
  );

  if (!minimums.ok) {
    const requestTarget = operationalCaseDocumentRequestTargetFromContext(
      workingCase.context_jsonb
    );
    const asksPurpose =
      requestTarget === "internal_user"
        ? "characteristics_pending_internal"
        : "characteristics_pending";
    const characteristicsAsks = recentEvents.filter((event) => {
      const payload = event.payload_jsonb;
      return (
        event.event_type === "reminder_sent" &&
        payload &&
        typeof payload === "object" &&
        (payload as Record<string, unknown>).purpose === asksPurpose
      );
    });
    const lastAskAt =
      characteristicsAsks.length > 0
        ? characteristicsAsks[characteristicsAsks.length - 1].created_at ?? null
        : null;

    // A fresh owner reply after the last ask means we must respond, not stay
    // silent: re-ask only the fields that are still missing. Without a new
    // reply we keep waiting (avoids re-asking on every cron tick).
    const ownerRepliedSinceLastAsk =
      lastAskAt != null &&
      recentEvents.some((event) => {
        const payload = event.payload_jsonb as Record<string, unknown> | null;
        const isOwnerReply =
          event.event_type === "external_response" ||
          (event.event_type === "state_changed" &&
            payload?.kind === "owner_characteristics_merged");
        return (
          isOwnerReply &&
          typeof event.created_at === "string" &&
          event.created_at > lastAskAt
        );
      });

    if (lastAskAt != null && !ownerRepliedSinceLastAsk) {
      return { case: workingCase, action: "no_action" };
    }

    const isReAsk = lastAskAt != null && ownerRepliedSinceLastAsk;

    const text = buildPropertyDataMinimumsSummaryMessage({
      context: workingCase.context_jsonb,
      supplement: documentFields,
      missing: minimums.missing,
    });
    if (requestTarget === "internal_user") {
      const notifyResult = await notify(
        db,
        workingCase.user_id,
        {
          text,
          kind: "property_data_minimums_missing",
          data: {
            case_id: workingCase.id,
            source,
            missing: minimums.missing,
            property_type: minimums.propertyType,
          },
        },
        "normal"
      );
      await insertOperationalCaseEvent(db, {
        caseId: workingCase.id,
        eventType: "reminder_sent",
        actor: "system",
        payload: {
          source,
          channel: "notify_user",
          purpose: "characteristics_pending_internal",
          audience: "internal_user",
          notify_delivered: notifyResult.delivered,
          reask: isReAsk,
          missing: minimums.missing,
          document_fields_used: documentFields,
          text_preview: text.slice(0, 200),
        },
      });
      const updated = await updateOperationalCase(
        db,
        workingCase.id,
        workingCase.version,
        {
          status: "waiting_internal",
          currentStep: "documents_received",
          nextActionAt: null,
        }
      );
      return {
        case: updated ?? workingCase,
        action: isReAsk
          ? "asked_missing_characteristics_again_internal"
          : "asked_missing_characteristics_internal",
      };
    }

    const chatId =
      workingCase.external_contact_jsonb?.channel === "telegram" &&
      typeof workingCase.external_contact_jsonb.chat_id === "number"
        ? workingCase.external_contact_jsonb.chat_id
        : null;
    if (!chatId) {
      await insertOperationalCaseEvent(db, {
        caseId: workingCase.id,
        eventType: "state_changed",
        actor: "system",
        payload: {
          kind: "property_data_minimums_missing",
          source,
          property_type: minimums.propertyType,
          missing: minimums.missing,
          document_fields_used: documentFields,
          reason: "no_telegram_external_contact",
        },
      });
      return { case: workingCase, action: "no_action" };
    }

    await sendTelegramMessage(chatId, text);
    await insertOperationalCaseEvent(db, {
      caseId: workingCase.id,
      eventType: "reminder_sent",
      actor: "system",
      payload: {
        source,
        channel: "telegram",
        chat_id: chatId,
        purpose: "characteristics_pending",
        reask: isReAsk,
        missing: minimums.missing,
        document_fields_used: documentFields,
        text_preview: text.slice(0, 200),
      },
    });
    const updated = await updateOperationalCase(db, workingCase.id, workingCase.version, {
      status: "waiting_external",
      currentStep: "documents_received",
      nextActionAt: null,
    });
    return {
      case: updated ?? workingCase,
      action: isReAsk
        ? "asked_missing_characteristics_again"
        : "asked_missing_characteristics",
    };
  }

  const alreadyRequested = recentEvents.some((event) => {
    const payload = event.payload_jsonb;
    return (
      payload &&
      typeof payload === "object" &&
      ((payload as Record<string, unknown>).kind === "property_data_review_requested" ||
        (payload as Record<string, unknown>).kind === "property_data_review")
    );
  });
  if (alreadyRequested) return { case: workingCase, action: "no_action" };

  const reviewText = propertyDataReviewTextFromContext({
    opCase: workingCase,
    documentFields,
  });
  const notifyResult = await notify(
    db,
    workingCase.user_id,
    {
      text: reviewText,
      kind: "property_data_review",
      data: {
        case_id: workingCase.id,
        title: "Revisión de datos de propiedad",
        source,
      },
    },
    "normal"
  );
  await insertOperationalCaseEvent(db, {
    caseId: workingCase.id,
    eventType: "human_decision",
    actor: "system",
    payload: {
      kind: "property_data_review_requested",
      source,
      notify_delivered: notifyResult.delivered,
      document_fields_used: documentFields,
    },
  });
  const updated = await updateOperationalCase(db, workingCase.id, workingCase.version, {
    status: "waiting_internal",
    currentStep: "property_data_review",
    nextActionAt: null,
  });
  return {
    case: updated ?? workingCase,
    action: "requested_property_data_review",
  };
}
