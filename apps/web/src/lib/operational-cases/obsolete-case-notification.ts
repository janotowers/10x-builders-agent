import type { InternalUserNotification, OperationalCase } from "@agents/types";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Pendientes conversacionales que ya no pueden ser accionables porque el caso
 * superó su etapa. El cron lo usa justo antes de recordar/escalar.
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
