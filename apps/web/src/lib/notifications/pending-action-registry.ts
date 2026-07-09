import { effectiveInternalNotificationKind } from "@/lib/internal-notifications/registry";
import type { InternalNotificationDisplay } from "@/lib/notifications/pending-inbox-types";

export type PendingInlineActionKind =
  | "price_approval"
  | "comparables_search_expansion_decision"
  | "contract_review"
  | "contract_data_review"
  | "property_data_review"
  | "listing_description_review";

function contractPendingLooksDecisional(notification: InternalNotificationDisplay) {
  const text = `${notification.title ?? ""} ${notification.body ?? ""}`.toLowerCase();
  if (/faltan datos obligatorios|correo electr[oó]nico del propietario|datos contractuales/.test(text)) {
    return false;
  }
  return /contrato|borrador|revis|aprueb|confirm|cambios|dueño|dueno/.test(text);
}

export function pendingInlineActionKind(
  notification: InternalNotificationDisplay
): PendingInlineActionKind | null {
  const effectiveKind = effectiveInternalNotificationKind({
    kind: notification.kind,
    body: notification.body,
    title: notification.title,
  });
  if (effectiveKind === "price_approval") return "price_approval";
  if (notification.kind === "comparables_search_expansion_decision") {
    return "comparables_search_expansion_decision";
  }
  if (notification.kind === "property_data_review") return "property_data_review";
  if (notification.kind === "listing_description_review") {
    return "listing_description_review";
  }
  if (notification.kind === "contract_data_review") return "contract_data_review";
  if (notification.kind === "contract_review") return "contract_review";
  if (
    notification.kind === "contract_pending" &&
    contractPendingLooksDecisional(notification)
  ) {
    return "contract_review";
  }
  return null;
}
