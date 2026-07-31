/**
 * Helpers HITL seguros para el cliente React (sin node:/DB).
 * La presentación con adjuntos vive en web-hitl-presentation.ts (server).
 * Las acciones canónicas viven en hitl-action-contract.ts (paridad Telegram).
 */
import {
  buildHitlActionsForKind,
  HITL_MIRROR_KINDS,
  hitlEndpointForKind,
  isUploadBatchHitlKind,
  type HitlActionDef,
} from "./hitl-action-contract";

export type WebHitlActionDef = HitlActionDef;

export type WebHitlAttachment = {
  fileName: string;
  downloadUrl?: string;
  contentType?: string;
  sizeBytes?: number;
  /** Click-through al renderizar preview de imagen (p. ej. EasyBroker). */
  href?: string;
  label?: string;
};

/** @deprecated use HITL_MIRROR_KINDS — alias para callers existentes. */
export const WEB_HITL_MIRROR_KINDS = HITL_MIRROR_KINDS;

export function webHitlEndpointForKind(kind: string): string | null {
  return hitlEndpointForKind(kind);
}

export function buildWebHitlActions(
  kind: string | undefined,
  data?: Record<string, unknown>
): WebHitlActionDef[] {
  return buildHitlActionsForKind(kind, data);
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

  if (isUploadBatchHitlKind(params.kind)) {
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
        ...(text ? { text } : {}),
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
