import type { OperationalCase, ToolCall } from "@agents/types";

export type OwnerResponseVerdict =
  | "success"
  | "partial"
  | "blocked"
  | "wrong_step";

export type LeadTelegramPreview = {
  text: string;
  purpose: string | null;
  delivery: "sent" | "pending_approval" | "failed" | "not_attempted";
};

export type OwnerResponseBusinessOutcome = {
  verdict: OwnerResponseVerdict;
  headline: string;
  summary: string;
  expected_step: string;
  actual_step: string | null;
  actual_status: string | null;
  property_data_present: boolean;
  critical_missing: string[];
  pending_hitl: boolean;
  internal_review_sent: boolean;
  owner_response_text: string | null;
  lead_messages: LeadTelegramPreview[];
  next_actions: string[];
};

const CRITICAL_FIELDS: Array<[key: string, label: string]> = [
  ["operation", "operación"],
  ["property_type", "tipo"],
  ["area_total_m2", "m² totales"],
  ["bedrooms", "recámaras"],
  ["bathrooms", "baños"],
];

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function missingCritical(propertyData: Record<string, unknown> | null): string[] {
  if (!propertyData) {
    return CRITICAL_FIELDS.map(([, label]) => label);
  }
  return CRITICAL_FIELDS.filter(([key]) => {
    const value = propertyData[key];
    return value == null || value === "";
  }).map(([, label]) => label);
}

function extractLeadTelegramMessages(
  toolCalls: ToolCall[],
  options?: { purposeFilter?: string | null; since?: string | null }
): LeadTelegramPreview[] {
  const sinceMs = options?.since ? Date.parse(options.since) : NaN;
  return toolCalls
    .filter((call) => call.tool_name === "telegram_send_message_to_contact")
    .filter((call) => {
      if (!options?.purposeFilter) return true;
      return call.arguments_json?.purpose === options.purposeFilter;
    })
    .filter((call) => {
      if (!Number.isFinite(sinceMs)) return true;
      const createdMs = Date.parse(call.created_at ?? "");
      return Number.isFinite(createdMs) && createdMs >= sinceMs;
    })
    .slice(-3)
    .map((call) => {
      const text =
        typeof call.arguments_json?.text === "string"
          ? call.arguments_json.text
          : "";
      const purpose =
        typeof call.arguments_json?.purpose === "string"
          ? call.arguments_json.purpose
          : null;
      const delivery: LeadTelegramPreview["delivery"] =
        call.status === "executed"
          ? "sent"
          : call.status === "pending_confirmation"
            ? "pending_approval"
            : call.status === "failed"
              ? "failed"
              : "not_attempted";
      return { text, purpose, delivery };
    })
    .filter((item) => item.text.trim().length > 0);
}

function verdictCopy(verdict: OwnerResponseVerdict): {
  headline: string;
  summary: string;
} {
  switch (verdict) {
    case "success":
      return {
        headline: "Prueba exitosa",
        summary:
          "La respuesta del dueño quedó en property_data. El caso sigue en paso 3 (documents_received) a la espera de que el asesor valide los datos antes de comparables.",
      };
    case "blocked":
      return {
        headline: "Procesada, pero bloqueada por aprobación humana",
        summary:
          "El agente intentó usar una tool de riesgo alto/medio que aún requiere aprobación en Pendientes o Telegram antes de completar property_data o enviar mensajes.",
      };
    case "wrong_step":
      return {
        headline: "Fuera del foco de esta prueba",
        summary:
          "El caso no quedó en extracción de características (documents_received). Regenera el caso de prueba o vuelve a prepararlo antes de repetir B.",
      };
    default:
      return {
        headline: "Parcial: faltan campos críticos",
        summary:
          "Se procesó la respuesta, pero todavía faltan campos críticos en property_data para cerrar el paso 3.",
      };
  }
}

export function evaluateOwnerResponseBusinessOutcome(params: {
  opCase: OperationalCase;
  toolCalls: ToolCall[];
  pendingConfirmation: boolean;
  ownerResponseText?: string | null;
  leadMessagePurpose?: string | null;
  /** ISO timestamp: only show Telegram previews from this tick onward. */
  toolCallsSince?: string | null;
  internalReviewSent?: boolean;
}): OwnerResponseBusinessOutcome {
  const propertyData = isPlainRecord(params.opCase.context_jsonb?.property_data)
    ? params.opCase.context_jsonb.property_data
    : null;
  const criticalMissing = missingCritical(propertyData);
  const leadMessages = extractLeadTelegramMessages(params.toolCalls, {
    purposeFilter: params.leadMessagePurpose,
    since: params.toolCallsSince,
  });
  const actualStep = params.opCase.current_step ?? null;
  const expectedStep = "documents_received";

  let verdict: OwnerResponseVerdict = "partial";
  if (
    actualStep &&
    actualStep !== expectedStep &&
    actualStep !== "comparables_in_progress"
  ) {
    verdict = "wrong_step";
  } else if (params.pendingConfirmation) {
    verdict = propertyData ? "partial" : "blocked";
  } else if (propertyData && criticalMissing.length === 0) {
    verdict = "success";
  } else if (propertyData && criticalMissing.length > 0) {
    verdict = "partial";
  } else {
    verdict = "partial";
  }

  const copy = verdictCopy(verdict);
  const nextActions: string[] = [];

  if (verdict === "blocked") {
    nextActions.push(
      "Revisa Pendientes o Telegram para aprobar/rechazar la acción pendiente."
    );
  }
  if (verdict === "wrong_step") {
    nextActions.push(
      "Regenera el caso de prueba y repite A + B con el caso en paso 3 (documents_received)."
    );
  }
  if (verdict === "partial") {
    nextActions.push(
      "Revisa eventos del caso y vuelve a ejecutar B, o abre el caso en Casos operacionales."
    );
  }
  if (verdict === "success") {
    if (params.internalReviewSent) {
      nextActions.push(
        "Revisa Pendientes o Telegram: se solicitó validación interna (notify_user · property_data_review)."
      );
    } else if (params.opCase.status === "waiting_internal") {
      nextActions.push(
        "El caso está en waiting_internal; falta registrar la solicitud de revisión al asesor (notify_user)."
      );
    }
  }
  if (leadMessages.some((item) => item.delivery === "pending_approval")) {
    nextActions.push(
      "Hay un mensaje al lead preparado pero no enviado hasta que apruebes la tool."
    );
  }
  if (leadMessages.some((item) => item.delivery === "sent")) {
    nextActions.push("El lead ya recibiría (o recibió) el mensaje mostrado abajo.");
  }

  return {
    verdict,
    headline: copy.headline,
    summary: copy.summary,
    expected_step: expectedStep,
    actual_step: actualStep,
    actual_status: params.opCase.status ?? null,
    property_data_present: propertyData != null,
    critical_missing: criticalMissing,
    pending_hitl: params.pendingConfirmation,
    internal_review_sent: Boolean(params.internalReviewSent),
    owner_response_text: params.ownerResponseText?.trim() || null,
    lead_messages: leadMessages,
    next_actions: nextActions,
  };
}
