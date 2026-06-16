import {
  buildPropertyDataMinimumsSummaryMessage,
  documentExtractionMinimumsContext,
  evaluatePropertyDataMinimumsForReview,
} from "@agents/agent";
import {
  createServerClient,
  getRecentOperationalCaseEvents,
  insertOperationalCaseEvent,
  listOperationalCaseDocuments,
  updateOperationalCase,
} from "@agents/db";
import type { OperationalCase, OperationalCaseDocument } from "@agents/types";
import { notify } from "@/lib/notify";
import { sendTelegramMessage } from "@/lib/telegram/send-message";

type ApplyPropertyOptioningPostAgentInvariantsResult = {
  case: OperationalCase | null;
  action:
    | "not_applicable"
    | "no_action"
    | "deferred_pending_extraction"
    | "asked_missing_characteristics"
    | "requested_property_data_review";
};

function normalizeDocSignalValue(value: unknown) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function isPredialDocumentCandidate(document: OperationalCaseDocument) {
  const normalized = normalizeDocSignalValue(
    [document.kind, document.display_name, document.original_name].filter(Boolean).join(" ")
  );
  return /\bpredial\b|impuesto predial|cuenta predial|clave catastral/.test(normalized);
}

function isOwnerCorroborationDocumentCandidate(document: OperationalCaseDocument) {
  const extraction = document.extraction_jsonb ?? {};
  const normalized = normalizeDocSignalValue(
    [
      document.kind,
      document.display_name,
      document.original_name,
      extraction.document_kind,
      extraction.raw_text,
      extraction.text,
    ]
      .filter(Boolean)
      .join(" ")
      .slice(0, 4000)
  );
  return /ine|instituto nacional electoral|identificacion|identidad|comprobante|domicilio|estado de cuenta|banco|bancario/.test(
    normalized
  );
}

function firstMeaningfulValue(...values: unknown[]) {
  for (const value of values) {
    if (value == null) continue;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function predialOrCorroborationExtractionGate(input: {
  documents: OperationalCaseDocument[];
  propertyType: string;
}) {
  const pendingStatuses = new Set(["pending", "failed", "not_applicable"]);
  const usableStatuses = new Set(["ok", "low_confidence"]);

  const predials = input.documents.filter(
    (document) => document.status !== "superseded" && isPredialDocumentCandidate(document)
  );
  const pendingPredials = predials
    .filter((document) => pendingStatuses.has(document.extraction_status))
    .map((document) => document.id);
  if (pendingPredials.length > 0) {
    return {
      blocked: true as const,
      reason: "predial_extraction_pending",
      pending_predial_document_ids: pendingPredials,
      pending_owner_corroboration_document_ids: [] as string[],
    };
  }
  const extractedPredials = predials.filter((document) =>
    usableStatuses.has(document.extraction_status)
  );
  if (predials.length > 0) {
    const hasTotal = extractedPredials.some((document) =>
      firstMeaningfulValue(
        document.extraction_jsonb?.area_total_m2,
        document.extraction_jsonb?.area_m2,
        document.extraction_jsonb?.surface_m2,
        document.extraction_jsonb?.superficie_m2,
        document.extraction_jsonb?.sup_terr,
        document.extraction_jsonb?.superficie_terreno_m2
      ) != null
    );
    if (!hasTotal) {
      return {
        blocked: true as const,
        reason: "predial_area_total_missing",
        pending_predial_document_ids: extractedPredials.map((document) => document.id),
        pending_owner_corroboration_document_ids: [] as string[],
      };
    }
    const requiresBuilt = normalizeDocSignalValue(input.propertyType).includes("casa");
    const hasBuilt = extractedPredials.some((document) =>
      firstMeaningfulValue(
        document.extraction_jsonb?.area_construida_m2,
        document.extraction_jsonb?.construction_area_m2,
        document.extraction_jsonb?.built_area_m2,
        document.extraction_jsonb?.sup_const,
        document.extraction_jsonb?.superficie_construccion_m2
      ) != null
    );
    if (requiresBuilt && !hasBuilt) {
      return {
        blocked: true as const,
        reason: "predial_area_construida_missing",
        pending_predial_document_ids: extractedPredials.map((document) => document.id),
        pending_owner_corroboration_document_ids: [] as string[],
      };
    }
  }

  const corroborationDocs = input.documents.filter(
    (document) =>
      document.status !== "superseded" && isOwnerCorroborationDocumentCandidate(document)
  );
  const pendingCorroboration = corroborationDocs
    .filter((document) => pendingStatuses.has(document.extraction_status))
    .map((document) => document.id);
  if (pendingCorroboration.length > 0) {
    return {
      blocked: true as const,
      reason: "owner_corroboration_extraction_pending",
      pending_predial_document_ids: [] as string[],
      pending_owner_corroboration_document_ids: pendingCorroboration,
    };
  }

  return {
    blocked: false as const,
    reason: null,
    pending_predial_document_ids: [] as string[],
    pending_owner_corroboration_document_ids: [] as string[],
  };
}

function isPropertyOptioningDocumentsReviewPoint(opCase: OperationalCase) {
  return (
    opCase.case_type === "property_optioning" &&
    opCase.current_step === "documents_received" &&
    opCase.status === "waiting_internal"
  );
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
  return [
    `Revisión de datos extraídos para el caso ${params.opCase.id}:`,
    "",
    "Datos confirmados por intake:",
    `- Título / propiedad: ${String(context.property_title ?? context.title ?? "pendiente")}`,
    `- Zona / colonia: ${String(context.property_zone ?? "pendiente")}`,
    `- Operación: ${String(context.operation_type ?? "pendiente")}`,
    `- Tipo de propiedad: ${String(context.property_type ?? "pendiente")}`,
    "",
    "Datos encontrados en documentos y respuestas:",
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

  const documents = await listOperationalCaseDocuments(db, {
    caseId: opCase.id,
    statuses: ["received"],
  });
  const documentFields = documentExtractionMinimumsContext(documents);
  const propertyTypeRaw =
    opCase.context_jsonb?.property_type ??
    (opCase.context_jsonb &&
    typeof opCase.context_jsonb.property_data === "object" &&
    !Array.isArray(opCase.context_jsonb.property_data)
      ? (opCase.context_jsonb.property_data as Record<string, unknown>).property_type
      : null);
  const extractionGate = predialOrCorroborationExtractionGate({
    documents,
    propertyType: typeof propertyTypeRaw === "string" ? propertyTypeRaw : "",
  });
  const minimums = evaluatePropertyDataMinimumsForReview(
    opCase.context_jsonb,
    documentFields
  );
  const recentEvents = await getRecentOperationalCaseEvents(db, opCase.id, 30);

  if (extractionGate.blocked) {
    const alreadyDeferred = recentEvents.some((event) => {
      const payload = event.payload_jsonb as Record<string, unknown> | null;
      return (
        event.event_type === "state_changed" &&
        payload?.kind === "property_data_review_deferred_pending_extraction" &&
        payload?.reason === extractionGate.reason
      );
    });
    if (!alreadyDeferred) {
      await insertOperationalCaseEvent(db, {
        caseId: opCase.id,
        eventType: "state_changed",
        actor: "system",
        payload: {
          kind: "property_data_review_deferred_pending_extraction",
          source,
          reason: extractionGate.reason,
          pending_predial_document_ids: extractionGate.pending_predial_document_ids,
          pending_owner_corroboration_document_ids:
            extractionGate.pending_owner_corroboration_document_ids,
        },
      });
    }
    return { case: opCase, action: "deferred_pending_extraction" };
  }

  if (!minimums.ok) {
    const alreadyAsked = recentEvents.some((event) => {
      const payload = event.payload_jsonb;
      return (
        event.event_type === "reminder_sent" &&
        payload &&
        typeof payload === "object" &&
        (payload as Record<string, unknown>).purpose === "characteristics_pending"
      );
    });
    if (alreadyAsked) return { case: opCase, action: "no_action" };

    const chatId =
      opCase.external_contact_jsonb?.channel === "telegram" &&
      typeof opCase.external_contact_jsonb.chat_id === "number"
        ? opCase.external_contact_jsonb.chat_id
        : null;
    if (!chatId) {
      await insertOperationalCaseEvent(db, {
        caseId: opCase.id,
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
      return { case: opCase, action: "no_action" };
    }

    const text = buildPropertyDataMinimumsSummaryMessage({
      context: opCase.context_jsonb,
      supplement: documentFields,
      missing: minimums.missing,
    });
    await sendTelegramMessage(chatId, text);
    await insertOperationalCaseEvent(db, {
      caseId: opCase.id,
      eventType: "reminder_sent",
      actor: "system",
      payload: {
        source,
        channel: "telegram",
        chat_id: chatId,
        purpose: "characteristics_pending",
        missing: minimums.missing,
        document_fields_used: documentFields,
        text_preview: text.slice(0, 200),
      },
    });
    const updated = await updateOperationalCase(db, opCase.id, opCase.version, {
      status: "waiting_external",
      currentStep: "documents_received",
      nextActionAt: null,
    });
    return {
      case: updated ?? opCase,
      action: "asked_missing_characteristics",
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
  if (alreadyRequested) return { case: opCase, action: "no_action" };

  const reviewText = propertyDataReviewTextFromContext({ opCase, documentFields });
  const notifyResult = await notify(
    db,
    opCase.user_id,
    {
      text: reviewText,
      kind: "property_data_review",
      data: {
        case_id: opCase.id,
        title: "Revisión de datos de propiedad",
        source,
      },
    },
    "normal"
  );
  await insertOperationalCaseEvent(db, {
    caseId: opCase.id,
    eventType: "human_decision",
    actor: "system",
    payload: {
      kind: "property_data_review_requested",
      source,
      notify_delivered: notifyResult.delivered,
      document_fields_used: documentFields,
    },
  });
  const updated = await updateOperationalCase(db, opCase.id, opCase.version, {
    status: "waiting_internal",
    currentStep: "property_data_review",
    nextActionAt: null,
  });
  return {
    case: updated ?? opCase,
    action: "requested_property_data_review",
  };
}
