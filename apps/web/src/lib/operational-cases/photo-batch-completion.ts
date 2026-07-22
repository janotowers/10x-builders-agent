import {
  createServerClient,
  getOperationalCase,
  insertOperationalCaseEvent,
  resolveUnreadInternalNotificationsByKindForCaseWithReminders,
  updateOperationalCase,
} from "@agents/db";
import type { OperationalCase } from "@agents/types";
import { looksLikeDocumentBatchComplete } from "./document-batch-completion";

type DbClient = ReturnType<typeof createServerClient>;

export const RAW_PHOTOS_MIN_COUNT = 5;
export const PHOTOS_UPLOAD_REQUESTED_NOTIFICATION_KIND = "photos_upload_requested";

export { looksLikeDocumentBatchComplete as looksLikePhotoBatchComplete };

export function countRawPhotos(
  context: Record<string, unknown> | null | undefined
): number {
  if (!context || !Array.isArray(context.raw_photos)) return 0;
  return context.raw_photos.length;
}

/** Cierra pendientes obsoletos de solicitud de fotos (p. ej. al llegar a package_ready). */
export async function dismissPhotosUploadRequestedNotifications(params: {
  db: DbClient;
  userId: string;
  caseId: string;
}): Promise<number> {
  return resolveUnreadInternalNotificationsByKindForCaseWithReminders(params.db, {
    userId: params.userId,
    caseId: params.caseId,
    kind: PHOTOS_UPLOAD_REQUESTED_NOTIFICATION_KIND,
    status: "actioned",
  });
}

export function photosUploadProgressAckText(photoCount: number): string {
  return [
    `Recibí la foto. Van ${photoCount} registrada(s).`,
    `Mínimo ${RAW_PHOTOS_MIN_COUNT} para publicar.`,
    "Cuando termines, toca **«Terminé de subir»** o escribe **«listo»**.",
  ].join(" ");
}

export function photosBatchInsufficientAckText(photoCount: number): string {
  const missing = Math.max(0, RAW_PHOTOS_MIN_COUNT - photoCount);
  if (photoCount === 0) {
    return `Aún no veo fotos registradas en el caso. Sube al menos ${RAW_PHOTOS_MIN_COUNT} y luego escribe **«listo»**.`;
  }
  return `Van ${photoCount}/${RAW_PHOTOS_MIN_COUNT} fotos; faltan ${missing}. Sigue subiendo y escribe **«listo»** cuando termines.`;
}

export function photosBatchAdvancedAckText(photoCount: number): string {
  return `Gracias, registré ${photoCount} foto(s). Avancé el caso a Gestionar publicación.`;
}

export function formatPhotosUploadRequestNotifyText(params: {
  propertyLabel?: string | null;
  caseId: string;
  appUrl?: string | null;
}): string {
  const property =
    params.propertyLabel?.trim() || "el inmueble del caso";
  // Keep signature stable for callers; caseId/appUrl unused (chat-first, no case refs/panel links).
  void params.caseId;
  void params.appUrl;

  return [
    `Solicitud de fotos — ${property}`,
    "",
    `Sube al menos ${RAW_PHOTOS_MIN_COUNT} fotos del inmueble aquí (puedes enviar más).`,
    "",
    "Fotos sugeridas:",
    "• Fachada",
    "• Sala / comedor",
    "• Cocina",
    "• Recámara principal",
    "• Baño principal",
    "• Extras opcionales: jardín, estacionamiento, amenidades, detalles",
    "",
    "Cuando termines de subir todas las fotos, toca **«Terminé de subir»** o escribe **«listo»**.",
  ].join("\n");
}

export type PhotoBatchCompletionStatus =
  | "advanced"
  | "already_advanced"
  | "insufficient_photos"
  | "no_photos"
  | "wrong_step"
  | "failed";

export interface PhotoBatchCompletionResult {
  status: PhotoBatchCompletionStatus;
  case: OperationalCase;
  photoCount: number;
}

const MAX_TRANSITION_ATTEMPTS = 4;

/**
 * Cierra el lote de fotos cuando el asesor escribe «listo» (mismo patrón que
 * documentos). Avanza a package_ready solo si raw_photos >= RAW_PHOTOS_MIN_COUNT.
 */
export async function completePhotoBatchForCase(params: {
  db: DbClient;
  caseId: string;
  channel: "web" | "telegram";
  source: string;
}): Promise<PhotoBatchCompletionResult> {
  const { db, caseId, channel, source } = params;

  let current = await getOperationalCase(db, caseId);
  if (!current) {
    throw new Error("case_not_found");
  }

  if (current.current_step === "package_ready") {
    await dismissPhotosUploadRequestedNotifications({
      db,
      userId: current.user_id,
      caseId: current.id,
    }).catch((error) => {
      console.warn("[photo-batch-completion] dismiss photos notify failed:", error);
    });
    return {
      status: "already_advanced",
      case: current,
      photoCount: countRawPhotos(current.context_jsonb),
    };
  }
  if (current.current_step !== "photos_requested") {
    return {
      status: "wrong_step",
      case: current,
      photoCount: countRawPhotos(current.context_jsonb),
    };
  }

  const photoCount = countRawPhotos(current.context_jsonb);
  if (photoCount === 0) {
    return { status: "no_photos", case: current, photoCount: 0 };
  }
  if (photoCount < RAW_PHOTOS_MIN_COUNT) {
    return { status: "insufficient_photos", case: current, photoCount };
  }

  // E2E: cron is suppressed for controlled cases — leave next_action_at null and
  // let the caller fire runSettingsTestCaseAgentTick immediately (same pattern as
  // characteristics replies). Production: wake the cron with next_action_at=now.
  const isE2EControlled = current.context_jsonb?.e2e_controlled === true;
  const nextActionAt = isE2EControlled ? null : new Date().toISOString();

  for (let attempt = 0; attempt < MAX_TRANSITION_ATTEMPTS; attempt += 1) {
    const updated = await updateOperationalCase(db, current.id, current.version, {
      status: "active",
      currentStep: "package_ready",
      nextActionAt,
    });
    if (updated) {
      await insertOperationalCaseEvent(db, {
        caseId: updated.id,
        eventType: "step_completed",
        actor: "user",
        stepKey: "photos_requested",
        payload: {
          source,
          channel,
          kind: "photos_uploaded",
          from_step: "photos_requested",
          to_step: "package_ready",
          photos_count: photoCount,
          minimum_required: RAW_PHOTOS_MIN_COUNT,
        },
      });
      await dismissPhotosUploadRequestedNotifications({
        db,
        userId: updated.user_id,
        caseId: updated.id,
      }).catch((error) => {
        console.warn("[photo-batch-completion] dismiss photos notify failed:", error);
      });
      return { status: "advanced", case: updated, photoCount };
    }

    const reread = await getOperationalCase(db, caseId);
    if (!reread) {
      throw new Error("case_not_found");
    }
    current = reread;
    if (current.current_step === "package_ready") {
      await dismissPhotosUploadRequestedNotifications({
        db,
        userId: current.user_id,
        caseId: current.id,
      }).catch((error) => {
        console.warn("[photo-batch-completion] dismiss photos notify failed:", error);
      });
      return {
        status: "already_advanced",
        case: current,
        photoCount: countRawPhotos(current.context_jsonb),
      };
    }
  }

  return { status: "failed", case: current, photoCount };
}
