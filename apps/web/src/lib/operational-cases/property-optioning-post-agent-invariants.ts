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
import type { OperationalCase } from "@agents/types";
import { notify } from "@/lib/notify";
import { sendTelegramMessage } from "@/lib/telegram/send-message";

type ApplyPropertyOptioningPostAgentInvariantsResult = {
  case: OperationalCase | null;
  action:
    | "not_applicable"
    | "no_action"
    | "asked_missing_characteristics"
    | "requested_property_data_review";
};

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
    `- Dirección legal: ${
      value("legal_addresses") ||
      value("legal_address") ||
      value("property_address") ||
      value("address") ||
      "pendiente"
    }`,
    `- Superficie: ${value("area_total_m2") || "pendiente"} m²`,
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
  const minimums = evaluatePropertyDataMinimumsForReview(
    opCase.context_jsonb,
    documentFields
  );
  const recentEvents = await getRecentOperationalCaseEvents(db, opCase.id, 30);

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
