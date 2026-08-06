import {
  getOperationalCase,
  insertOperationalCaseEvent,
  type DbClient,
} from "@agents/db";
import type { OperationalCase } from "@agents/types";
import { createAdvisedCaseUpdate } from "./advised-case-update";
import { deliverInternalCaseFollowUp } from "./deliver-internal-case-follow-up";
import {
  countRawPhotos,
  formatPhotosUploadRequestNotifyText,
  PHOTOS_UPLOAD_REQUESTED_NOTIFICATION_KIND,
  RAW_PHOTOS_MIN_COUNT,
} from "./photo-batch-completion";
import { discardPendingMediaGroupAcksForCase } from "./telegram-media-group-ack-store";

const advisedUpdate = createAdvisedCaseUpdate(
  "ensure_photos_upload_request",
  "runtime"
);

function contextRecord(opCase: OperationalCase): Record<string, unknown> {
  return opCase.context_jsonb &&
    typeof opCase.context_jsonb === "object" &&
    !Array.isArray(opCase.context_jsonb)
    ? (opCase.context_jsonb as Record<string, unknown>)
    : {};
}

function propertyLabel(context: Record<string, unknown>): string {
  for (const key of ["legal_address", "property_address", "property_title", "title"]) {
    const value = context[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const data =
    context.property_data &&
    typeof context.property_data === "object" &&
    !Array.isArray(context.property_data)
      ? (context.property_data as Record<string, unknown>)
      : {};
  return typeof data.property_title === "string" && data.property_title.trim()
    ? data.property_title.trim()
    : "la propiedad";
}

export async function ensurePhotosUploadRequestForCase(params: {
  db: DbClient;
  opCase: OperationalCase;
  source: string;
}): Promise<{ requested: boolean; case: OperationalCase }> {
  const { db, source } = params;
  let opCase = params.opCase;
  if (opCase.current_step !== "photos_requested") {
    return { requested: false, case: opCase };
  }
  // Al entrar desde el lote documental no debe sobrevivir ningún acuse
  // consolidado pendiente. Solo se descarta antes de la primera foto; una
  // carga de fotos ya iniciada conserva su propio media group.
  const initialContext = contextRecord(opCase);
  if (countRawPhotos(initialContext) === 0) {
    opCase = await discardPendingMediaGroupAcksForCase({ db, opCase });
  }
  const { data: unread } = await db
    .from("internal_user_notifications")
    .select("id")
    .eq("user_id", opCase.user_id)
    .eq("case_id", opCase.id)
    .eq("kind", PHOTOS_UPLOAD_REQUESTED_NOTIFICATION_KIND)
    .eq("status", "unread")
    .limit(1);
  if (Array.isArray(unread) && unread.length > 0) {
    return { requested: false, case: opCase };
  }

  const context = contextRecord(opCase);
  const count = countRawPhotos(context);
  const appUrl =
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    process.env.APP_URL?.trim() ||
    null;
  const text = formatPhotosUploadRequestNotifyText({
    propertyLabel: propertyLabel(context),
    caseId: opCase.id,
    appUrl,
  });
  const delivery = await deliverInternalCaseFollowUp({
    db,
    userId: opCase.user_id,
    caseId: opCase.id,
    text,
    kind: PHOTOS_UPLOAD_REQUESTED_NOTIFICATION_KIND,
    data: {
      source,
      raw_photos_count: count,
      minimum_required: RAW_PHOTOS_MIN_COUNT,
    },
  });
  await insertOperationalCaseEvent(db, {
    caseId: opCase.id,
    eventType: "reminder_sent",
    actor: "system",
    stepKey: "photos_requested",
    payload: {
      purpose: "photos_upload_requested",
      source,
      raw_photos_count: count,
      minimum_required: RAW_PHOTOS_MIN_COUNT,
      active_internal_channel: delivery.activeChannel,
      notify_delivered: delivery.notifyDelivered,
      web_chat_mirrored: delivery.webChatMirrored,
    },
  });
  const fresh = (await getOperationalCase(db, opCase.id)) ?? opCase;
  const waiting = await advisedUpdate(db, fresh, fresh.version, {
    status: "waiting_internal",
    currentStep: "photos_requested",
    nextActionAt: null,
  });
  opCase = waiting ?? fresh;
  return { requested: true, case: opCase };
}
