/**
 * Helpers HITL seguros para el cliente React (sin node:/DB).
 * La presentación con adjuntos vive en web-hitl-presentation.ts (server).
 */
import {
  contractDataReviewBooleanButtonLabels,
  resolveSingleRequiredBooleanField,
} from "@/lib/notify/contract-data-review-telegram-markup";

export type WebHitlActionDef = {
  id: string;
  label: string;
  variant?: "primary" | "secondary" | "danger";
  /** Muestra input de notas compartido; se envía como `text` si aplica. */
  acceptsNotes?: boolean;
  notesPlaceholder?: string;
  /** Si acceptsNotes y el input está vacío, usa este texto. */
  defaultNotes?: string;
  /** Bloquea el click si acceptsNotes y no hay notas ni default. */
  requiresNotes?: boolean;
  /** Campos extra del body (p. ej. patch de contract_data_review). */
  body?: Record<string, unknown>;
};

export type WebHitlAttachment = {
  fileName: string;
  downloadUrl?: string;
  contentType?: string;
  sizeBytes?: number;
  /** Click-through al renderizar preview de imagen (p. ej. EasyBroker). */
  href?: string;
  label?: string;
};

const UPLOAD_BATCH_KINDS = new Set([
  "photos_upload_requested",
  "documents_upload_requested",
]);

/** Kinds con botones/adjunto en timeline; dedupe mirror por kind+caso. */
export const WEB_HITL_MIRROR_KINDS = new Set([
  "contract_review",
  "price_approval",
  "property_data_review",
  "contract_data_review",
  "listing_description_review",
  "easybroker_publish_approval",
  "ungga_publish_approval",
  "publication_review_required",
  "titularidad_review",
  "photos_upload_requested",
  "documents_upload_requested",
  "comparables_search_expansion_decision",
]);

const CONTRACT_REVIEW_WEB_ACTIONS = [
  { id: "approve_send" as const, label: "Enviar por email" },
  {
    id: "request_changes" as const,
    label: "Subir contrato corregido y enviar",
  },
];

function publishDestinationLabel(kind: string | undefined): string {
  if (kind === "easybroker_publish_approval") return "EasyBroker";
  if (kind === "ungga_publish_approval") return "Ungga";
  return "destino";
}

export function webHitlEndpointForKind(kind: string): string | null {
  switch (kind) {
    case "price_approval":
      return "/api/business-decisions/price-approval";
    case "property_data_review":
      return "/api/business-decisions/property-data-review";
    case "contract_review":
    case "contract_pending":
      return "/api/business-decisions/contract-review";
    case "contract_data_review":
      return "/api/business-decisions/contract-data-review";
    case "listing_description_review":
      return "/api/business-decisions/listing-description-review";
    case "easybroker_publish_approval":
    case "ungga_publish_approval":
      return "/api/business-decisions/publish-destination-approval";
    case "publication_review_required":
      return "/api/business-decisions/publication-review";
    case "titularidad_review":
      return "/api/business-decisions/titularidad-review";
    case "photos_upload_requested":
    case "documents_upload_requested":
      return "/api/business-decisions/upload-batch-complete";
    case "comparables_search_expansion_decision":
      return "/api/business-decisions/comparables-expansion-decision";
    default:
      return null;
  }
}

export function buildWebHitlActions(
  kind: string | undefined,
  data?: Record<string, unknown>
): WebHitlActionDef[] {
  if (!kind) return [];

  if (kind === "contract_review" || kind === "contract_pending") {
    return CONTRACT_REVIEW_WEB_ACTIONS.map((action) =>
      action.id === "approve_send"
        ? { ...action, variant: "primary" as const }
        : {
            ...action,
            variant: "secondary" as const,
            acceptsNotes: true,
            notesPlaceholder: "Opcional: comentario para la versión corregida",
            defaultNotes: "subir contrato corregido y enviar",
          }
    );
  }

  if (kind === "price_approval") {
    return [
      { id: "approve", label: "Aprobar precio", variant: "primary" },
      {
        id: "adjust",
        label: "Ajustar",
        variant: "secondary",
        acceptsNotes: true,
        requiresNotes: true,
        notesPlaceholder:
          "Ej. AJUSTAR PRECIO salida=23500 ideal=22000 minimo=18000",
      },
    ];
  }

  if (kind === "property_data_review") {
    return [
      { id: "confirm", label: "Confirmar datos", variant: "primary" },
      {
        id: "adjust",
        label: "Ajustar",
        variant: "secondary",
        acceptsNotes: true,
        requiresNotes: true,
        notesPlaceholder: "Indica qué dato corregir",
      },
    ];
  }

  if (kind === "listing_description_review") {
    return [
      { id: "approve", label: "Aprobar descripción", variant: "primary" },
      {
        id: "request_changes",
        label: "Pedir cambios",
        variant: "secondary",
        acceptsNotes: true,
        notesPlaceholder:
          "Opcional: cambios concretos, o vacío para regenerar el borrador",
        defaultNotes: "Continuar: generar o regenerar el borrador comercial.",
      },
    ];
  }

  if (
    kind === "easybroker_publish_approval" ||
    kind === "ungga_publish_approval"
  ) {
    const dest = publishDestinationLabel(kind);
    return [
      {
        id: "approve",
        label: `Publicar en ${dest}`,
        variant: "primary",
      },
      {
        id: "skip",
        label: `Omitir ${dest}`,
        variant: "secondary",
      },
      {
        id: "reject",
        label: "Pausar publicación",
        variant: "danger",
      },
    ];
  }

  if (kind === "publication_review_required") {
    const credentialFailure = data?.credential_failure === true;
    const prepareDraftFailure =
      data?.prepare_draft_failure === true || data?.safe_retry_prepare === true;
    return [
      {
        id: "approve_continue",
        label: credentialFailure
          ? "Ya actualicé la API key — reintentar"
          : prepareDraftFailure
            ? "Reintentar publicación en Ungga"
            : "Aprobar y continuar",
        variant: "primary",
      },
      {
        id: "stop",
        label: credentialFailure
          ? "Pausar publicación"
          : prepareDraftFailure
            ? "Pausar y avisar a soporte"
            : "Detener y revisar",
        variant: "danger",
      },
    ];
  }

  if (kind === "titularidad_review") {
    return [
      {
        id: "approve",
        label: "Aprobar titularidad",
        variant: "primary",
      },
      {
        id: "request_documents",
        label: "Pedir documentos",
        variant: "secondary",
      },
    ];
  }

  if (UPLOAD_BATCH_KINDS.has(kind)) {
    return [
      {
        id: "upload_done",
        label: "Terminé de subir",
        variant: "primary",
      },
    ];
  }

  if (kind === "comparables_search_expansion_decision") {
    return [
      {
        id: "use_current_comparables",
        label: "1) Muestra actual",
        variant: "primary",
      },
      {
        id: "use_avaclick_primary",
        label: "2) Avaclick base",
        variant: "secondary",
      },
      {
        id: "expand_search",
        label: "3) Ampliar búsqueda",
        variant: "secondary",
      },
    ];
  }

  if (kind === "contract_data_review") {
    const singleBoolean = resolveSingleRequiredBooleanField(
      data?.missing_fields
    );
    if (!singleBoolean) return [];
    const labels = contractDataReviewBooleanButtonLabels(singleBoolean.key);
    return [
      {
        id: "cdr_yes",
        label: labels.yes,
        variant: "primary",
        body: { patch: { [singleBoolean.key]: true } },
      },
      {
        id: "cdr_no",
        label: labels.no,
        variant: "secondary",
        body: { patch: { [singleBoolean.key]: false } },
      },
    ];
  }

  return [];
}

export function buildWebHitlSubmitRequest(params: {
  kind: string;
  notificationId: string;
  action: WebHitlActionDef;
  notes?: string;
}): { url: string; body: Record<string, unknown> } | { error: string } {
  const url = webHitlEndpointForKind(params.kind);
  if (!url) return { error: "kind_not_supported" };

  const notes = (params.notes ?? "").trim();
  if (params.action.requiresNotes && !notes && !params.action.defaultNotes) {
    return { error: "notes_required" };
  }
  const text = notes || params.action.defaultNotes || "";

  if (UPLOAD_BATCH_KINDS.has(params.kind)) {
    return {
      url,
      body: { notification_id: params.notificationId },
    };
  }

  if (params.kind === "contract_data_review") {
    return {
      url,
      body: {
        notification_id: params.notificationId,
        ...(params.action.body ?? {}),
        ...(text ? { text } : {}),
      },
    };
  }

  if (params.kind === "contract_review" || params.kind === "contract_pending") {
    return {
      url,
      body: {
        notification_id: params.notificationId,
        action: params.action.id,
        ...(text ? { text } : {}),
      },
    };
  }

  if (params.kind === "price_approval") {
    if (params.action.id === "adjust") {
      return {
        url,
        body: { notification_id: params.notificationId, text },
      };
    }
    return {
      url,
      body: {
        notification_id: params.notificationId,
        action: "approve",
      },
    };
  }

  if (params.kind === "property_data_review") {
    if (params.action.id === "adjust") {
      return {
        url,
        body: { notification_id: params.notificationId, text },
      };
    }
    return {
      url,
      body: {
        notification_id: params.notificationId,
        action: "confirm",
      },
    };
  }

  if (params.kind === "listing_description_review") {
    if (params.action.id === "approve") {
      return {
        url,
        body: {
          notification_id: params.notificationId,
          action: "approve",
        },
      };
    }
    return {
      url,
      body: {
        notification_id: params.notificationId,
        text:
          text || "Continuar: generar o regenerar el borrador comercial.",
      },
    };
  }

  if (
    params.kind === "easybroker_publish_approval" ||
    params.kind === "ungga_publish_approval"
  ) {
    return {
      url,
      body: {
        notification_id: params.notificationId,
        action: params.action.id,
      },
    };
  }

  if (params.kind === "publication_review_required") {
    return {
      url,
      body: {
        notification_id: params.notificationId,
        action: params.action.id,
      },
    };
  }

  if (params.kind === "titularidad_review") {
    return {
      url,
      body: {
        notification_id: params.notificationId,
        action: params.action.id,
      },
    };
  }

  if (params.kind === "comparables_search_expansion_decision") {
    return {
      url,
      body: {
        notification_id: params.notificationId,
        action: params.action.id,
        ...(text ? { text } : {}),
      },
    };
  }

  return { error: "kind_not_supported" };
}
