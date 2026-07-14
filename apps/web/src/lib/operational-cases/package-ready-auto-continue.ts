import {
  isEasybrokerPublishedInContext,
  isEasybrokerResolvedForUnggaApproval,
} from "@/lib/business-decisions/publish-destination-approval";
import { countRawPhotos } from "@/lib/operational-cases/photo-batch-completion";
import { isPublicationResumeDue } from "@/lib/operational-cases/publication-media-recovery";
import { resolvePublicationRolloutMode } from "@/lib/operational-cases/publication-rollout";
import { listingDescriptionIsApproved } from "@/lib/operational-cases/publication-tool-policy";
import {
  nextPublicationAction,
  publicationFromContext,
} from "@/lib/operational-cases/publication-workflow";

export const PACKAGE_READY_AUTO_FOLLOW_UP_MAX_DEPTH = 2;

const LAB_WAKE_MACHINE_ACTIONS = new Set([
  "create_draft",
  "process_media",
  "wait_remote_media",
  "validate",
  "publish",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function publishApprovalsFromContext(
  context: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  if (!isRecord(context)) return {};
  return isRecord(context.publish_approvals) ? context.publish_approvals : {};
}

function publishedEasybrokerFromContext(
  context: Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
  if (!isRecord(context)) return null;
  const published = isRecord(context.published) ? context.published : {};
  return isRecord(published.easybroker) ? published.easybroker : null;
}

export function hasWatermarkedPhotosInContext(
  context: Record<string, unknown> | null | undefined
): boolean {
  if (!isRecord(context)) return false;
  return (
    (Array.isArray(context.watermarked_photos) &&
      context.watermarked_photos.length > 0) ||
    (Array.isArray(context.watermarked_image_paths) &&
      context.watermarked_image_paths.length > 0)
  );
}

export function isEasybrokerImagesUploadedInContext(
  context: Record<string, unknown> | null | undefined
): boolean {
  const easybroker = publishedEasybrokerFromContext(context);
  if (!easybroker) return false;
  if (easybroker.images_uploaded === true) return true;
  if (easybroker.images_status === "submitted") return true;
  if (
    typeof easybroker.image_count === "number" &&
    Number.isFinite(easybroker.image_count) &&
    easybroker.image_count > 0
  ) {
    return true;
  }
  return false;
}

export function isEasybrokerImagesFailedInContext(
  context: Record<string, unknown> | null | undefined
): boolean {
  const easybroker = publishedEasybrokerFromContext(context);
  if (!easybroker) return false;
  return easybroker.images_status === "failed";
}

export function packageReadyHasListingPhotos(
  context: Record<string, unknown> | null | undefined
): boolean {
  return countRawPhotos(context) > 0 || hasWatermarkedPhotosInContext(context);
}

/** EasyBroker ya tiene listing y aún faltan fotos por subir. */
export function packageReadyNeedsEasybrokerImageUpload(
  context: Record<string, unknown> | null | undefined
): boolean {
  if (!isEasybrokerPublishedInContext(context)) return false;
  if (isEasybrokerImagesUploadedInContext(context)) return false;
  // Fallo permanente de este intento: no reintentar en bucle automático.
  if (isEasybrokerImagesFailedInContext(context)) return false;
  return packageReadyHasListingPhotos(context);
}

/**
 * EasyBroker ya quedó resuelto (publicado públicamente / skipped / rejected) y
 * Ungga aún no tiene decisión humana. Un borrador con listing_id no basta.
 */
export function packageReadyNeedsUnggaApprovalNotify(
  context: Record<string, unknown> | null | undefined
): boolean {
  if (!isEasybrokerResolvedForUnggaApproval(context)) return false;
  const approvals = publishApprovalsFromContext(context);
  const unggaDecision =
    typeof approvals.ungga === "string" ? approvals.ungga : null;
  return !unggaDecision || unggaDecision === "pending";
}

/**
 * No pedir Ungga mientras haya fotos pendientes de subir a EasyBroker.
 * Si el upload falló, tampoco: hay que resolver el error primero.
 */
export function packageReadyBlocksUnggaApprovalNotify(
  context: Record<string, unknown> | null | undefined
): boolean {
  if (!packageReadyHasListingPhotos(context)) return false;
  if (isEasybrokerImagesUploadedInContext(context)) return false;
  if (isEasybrokerImagesFailedInContext(context)) return true;
  return packageReadyNeedsEasybrokerImageUpload(context);
}

export function formatUnggaPublishApprovalNotifyText(): string {
  return [
    "Aprobación de publicación en Ungga",
    "",
    "EasyBroker ya quedó publicado. ¿Quieres publicar esta propiedad en Ungga?",
    "",
    "Usa los botones:",
    "- Publicar en Ungga",
    "- No publicar en Ungga",
    "- Detener y revisar",
  ].join("\n");
}

/**
 * Ticks invoked by the publication runner (or its follow-up/lab wake paths)
 * must not schedule another fire-and-forget runner: the outer loop already
 * continues to process_media / publish.
 *
 * Prefer structural `publicationRunnerOwned` when available; `source` prefixes
 * remain as telemetry/compat fallback.
 */
export function isNestedPublicationRunnerTick(
  source: string | null | undefined,
  options?: { publicationRunnerOwned?: boolean }
): boolean {
  if (options?.publicationRunnerOwned === true) return true;
  if (typeof source !== "string" || !source.trim()) return false;
  return (
    source.startsWith("publication_runner:") ||
    source.startsWith("package_ready_auto_follow_up:") ||
    source.startsWith("package_ready_lab_auto_continue:")
  );
}

/**
 * Tras un tick sin HITL técnico: si aún falta trabajo de máquina (subir fotos
 * a EasyBroker), encadenar otro tick automáticamente.
 */
export function shouldAutoFollowUpPackageReadyTick(params: {
  context: Record<string, unknown> | null | undefined;
  pendingConfirmation: boolean;
  uploadedImagesThisTurn: boolean;
  uploadFailedThisTurn?: boolean;
  autoFollowUpDepth: number;
  /** Tick source; nested runner sources never schedule a second runner. */
  source?: string | null;
  /** Structural ownership from the publication runner (preferred). */
  publicationRunnerOwned?: boolean;
}): boolean {
  if (
    isNestedPublicationRunnerTick(params.source, {
      publicationRunnerOwned: params.publicationRunnerOwned,
    })
  ) {
    return false;
  }
  if (params.pendingConfirmation) return false;
  if (params.uploadFailedThisTurn) return false;
  if (params.autoFollowUpDepth >= PACKAGE_READY_AUTO_FOLLOW_UP_MAX_DEPTH) {
    return false;
  }
  if (params.uploadedImagesThisTurn) return false;
  return packageReadyNeedsEasybrokerImageUpload(params.context);
}

/**
 * Lab observer substitute for cron: wake the serialized publication runner when
 * machine work remains and the resume/lease window is due.
 * Driven by nextPublicationAction (not legacy images_* heuristics alone).
 */
export function shouldLabObserverWakePublicationRunner(params: {
  context: Record<string, unknown> | null | undefined;
  currentStep: string | null | undefined;
  nextActionAt: string | null | undefined;
  blockingActionsCount: number;
  hasPendingPublishApprovalNotification?: boolean;
  nowMs?: number;
}): boolean {
  if (params.blockingActionsCount > 0) return false;
  if (params.currentStep !== "package_ready") return false;
  if (!isRecord(params.context)) return false;
  if (params.context.package_ready_machine_work_in_flight === true) return false;
  if (!isPublicationResumeDue(params.nextActionAt, params.nowMs)) return false;
  if (!listingDescriptionIsApproved(params.context)) return false;
  if (resolvePublicationRolloutMode(params.context) !== "active") return false;

  const next = nextPublicationAction(publicationFromContext(params.context));
  if (LAB_WAKE_MACHINE_ACTIONS.has(next.type)) return true;

  if (
    (next.type === "request_approval" || next.type === "request_review") &&
    params.hasPendingPublishApprovalNotification !== true
  ) {
    return true;
  }

  return false;
}

/**
 * Si ya no falta upload (o no hay fotos), pedir Ungga de forma determinística
 * en post-agent — mismo patrón que listing_description_review tras el draft.
 */
export function shouldDeterministicallyRequestUnggaApproval(params: {
  context: Record<string, unknown> | null | undefined;
  pendingConfirmation: boolean;
  uploadedImagesThisTurn: boolean;
}): boolean {
  if (params.pendingConfirmation) return false;
  if (!packageReadyNeedsUnggaApprovalNotify(params.context)) return false;
  if (packageReadyBlocksUnggaApprovalNotify(params.context)) return false;
  return true;
}
