import {
  createServerClient,
  setInternalUserNotificationStatus,
} from "@agents/db";
import type { InternalUserNotification, OperationalCase } from "@agents/types";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Pendientes conversacionales que ya no pueden ser accionables porque el caso
 * superó su etapa. El cron lo usa justo antes de recordar/escalar; también se
 * invoca al cerrar publicación para no dejar zombies hasta el próximo reminder.
 */
export function isInternalCaseNotificationObsolete(params: {
  notification: Pick<InternalUserNotification, "kind">;
  opCase: Pick<OperationalCase, "current_step" | "context_jsonb">;
}): boolean {
  const { notification, opCase } = params;
  const context = record(opCase.context_jsonb);
  const pricing = record(context.pricing_proposal);
  const contractData = record(context.contract_data_review);
  const contractReview = record(context.contract_review);
  const publication = record(context.publication);
  const destinations = record(publication.destinations);

  switch (notification.kind) {
    case "property_data_minimums_missing":
      return opCase.current_step !== "documents_received";
    case "property_data_review":
    case "property_data_quality_review":
      return (
        opCase.current_step !== "documents_received" &&
        opCase.current_step !== "property_data_review"
      );
    case "comparables_search_expansion_decision":
      return opCase.current_step !== "comparables_in_progress";
    case "price_approval":
      return (
        opCase.current_step !== "price_proposal_pending" ||
        pricing.approval_status === "approved" ||
        pricing.approval_status === "rejected"
      );
    case "titularidad_review": {
      // Ausente del switch hasta el walkthrough E2E: el cron no la
      // auto-cerraba y un unread sobrevivía al caso completed/published.
      const titularidad = record(context.titularidad);
      const override = record(titularidad.override);
      return (
        opCase.current_step !== "contract_pending" ||
        override.approved === true
      );
    }
    case "contract_data_review":
      return (
        opCase.current_step !== "contract_pending" ||
        contractData.status === "captured"
      );
    case "contract_review":
      return opCase.current_step !== "contract_pending";
    case "contract_revision_upload":
      return (
        opCase.current_step !== "contract_pending" ||
        contractReview.status !== "awaiting_revision_upload"
      );
    case "photos_upload_requested":
      return opCase.current_step !== "photos_requested";
    case "documents_upload_requested":
      return opCase.current_step !== "awaiting_documents";
    case "listing_description_review":
      return (
        opCase.current_step !== "package_ready" ||
        Boolean(context.listing_description_approved)
      );
    case "easybroker_publish_approval": {
      const destination = record(destinations.easybroker);
      return (
        opCase.current_step !== "package_ready" ||
        ["approved", "skipped", "rejected"].includes(String(destination.approval))
      );
    }
    case "ungga_publish_approval": {
      const destination = record(destinations.ungga);
      return (
        opCase.current_step !== "package_ready" ||
        ["approved", "skipped", "rejected"].includes(String(destination.approval))
      );
    }
    case "publication_review_required":
      return opCase.current_step !== "package_ready";
    default:
      return false;
  }
}

/**
 * Cierra unread del caso que ya no son accionables según el step/contexto
 * actual. Idempotente; usado al finalizar publicación y por el cron.
 */
export async function dismissObsoleteInternalNotificationsForCase(params: {
  db: ReturnType<typeof createServerClient>;
  userId: string;
  opCase: Pick<
    OperationalCase,
    "id" | "current_step" | "context_jsonb" | "user_id"
  >;
}): Promise<number> {
  const { db, userId, opCase } = params;
  const { data, error } = await db
    .from("internal_user_notifications")
    .select("id,kind,status")
    .eq("user_id", userId)
    .eq("case_id", opCase.id)
    .eq("status", "unread");
  if (error) {
    console.warn(
      "[obsolete-case-notification] list unread failed:",
      error.message
    );
    return 0;
  }
  let dismissed = 0;
  for (const row of data ?? []) {
    if (
      !isInternalCaseNotificationObsolete({
        notification: { kind: row.kind },
        opCase,
      })
    ) {
      continue;
    }
    const ok = await setInternalUserNotificationStatus(db, {
      id: row.id,
      userId,
      status: "actioned",
    });
    if (ok) dismissed += 1;
  }
  return dismissed;
}
