/**
 * Constantes/helpers de upload-batch seguros para el bundle del cliente.
 * No importar aquí módulos de DB/agent: hitl-action-contract y el chat web
 * dependen de este archivo desde Client Components.
 */

export const UPLOAD_BATCH_CONFIRMATION_PURPOSE = "upload_batch_confirmation";
export const UPLOAD_BATCH_DONE_CALLBACK_PREFIX = "upload_done:";

export const DOCUMENTS_UPLOAD_REQUESTED_NOTIFICATION_KIND =
  "documents_upload_requested";
export const PHOTOS_UPLOAD_REQUESTED_NOTIFICATION_KIND =
  "photos_upload_requested";

export function isUploadBatchNotificationKind(
  kind: string | null | undefined
): boolean {
  return (
    kind === PHOTOS_UPLOAD_REQUESTED_NOTIFICATION_KIND ||
    kind === DOCUMENTS_UPLOAD_REQUESTED_NOTIFICATION_KIND
  );
}

export function uploadBatchKindFromNotificationKind(
  kind: string | null | undefined
): "documents" | "photos" | null {
  if (kind === PHOTOS_UPLOAD_REQUESTED_NOTIFICATION_KIND) return "photos";
  if (kind === DOCUMENTS_UPLOAD_REQUESTED_NOTIFICATION_KIND) return "documents";
  return null;
}
