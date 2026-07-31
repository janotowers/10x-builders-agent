/**
 * Presentación HITL para espejo web (server): texto + actions + attachments.
 * La lógica de botones/submit segura para el cliente está en web-hitl-client.ts.
 */
import { buildContractReviewWebChatPresentation } from "./contract-draft-document";
import {
  buildWebHitlActions,
  type WebHitlActionDef,
  type WebHitlAttachment,
} from "./web-hitl-client";

export type { WebHitlActionDef, WebHitlAttachment };
export {
  WEB_HITL_MIRROR_KINDS,
  buildWebHitlActions,
  buildWebHitlSubmitRequest,
  webHitlEndpointForKind,
} from "./web-hitl-client";

export type WebHitlPresentation = {
  text: string;
  actions: WebHitlActionDef[];
  attachments?: WebHitlAttachment[];
};

function listingDescriptionDownloadPath(notificationId: string): string {
  return `/api/business-decisions/listing-description-review/download?notification_id=${encodeURIComponent(notificationId)}`;
}

/**
 * Presentación web de un notify HITL: texto (markdown si hay adjunto),
 * botones y chips de descarga.
 */
export function buildWebHitlPresentation(params: {
  kind?: string;
  caseId: string;
  text: string;
  data?: Record<string, unknown>;
  notificationId?: string | null;
}): WebHitlPresentation {
  const kind = params.kind?.trim() || "";
  const data = params.data ?? {};

  if (kind === "contract_review") {
    const storagePath =
      typeof data.storage_path === "string"
        ? data.storage_path
        : typeof data.output_path === "string"
          ? data.output_path
          : null;
    const presentation = buildContractReviewWebChatPresentation({
      caseId: params.caseId,
      storagePath,
    });
    return {
      text: presentation.text,
      attachments: [presentation.attachment],
      actions: buildWebHitlActions(kind, data),
    };
  }

  const actions = buildWebHitlActions(kind, data);
  let text = params.text;
  let attachments: WebHitlAttachment[] | undefined;

  if (kind === "listing_description_review") {
    const fileName =
      (typeof data.listing_description_txt_filename === "string" &&
        data.listing_description_txt_filename.trim()) ||
      "descripcion_comercial.txt";
    const hasTxt =
      typeof data.listing_description_txt === "string" &&
      data.listing_description_txt.trim().length > 0;
    const notificationId =
      typeof params.notificationId === "string" && params.notificationId.trim()
        ? params.notificationId.trim()
        : null;
    if (hasTxt && notificationId) {
      const downloadUrl = listingDescriptionDownloadPath(notificationId);
      attachments = [
        {
          fileName,
          downloadUrl,
          contentType: "text/plain; charset=utf-8",
        },
      ];
      if (
        !text.includes(downloadUrl) &&
        !/descripcion_comercial\.txt/i.test(text)
      ) {
        // Label corto: el filename largo va en el chip de adjunto (evita
        // overflow en el bubble del web chat).
        text = `${text.trim()}\n\n[Descargar descripción](${downloadUrl})`;
      }
    }
  }

  return { text, actions, attachments };
}
