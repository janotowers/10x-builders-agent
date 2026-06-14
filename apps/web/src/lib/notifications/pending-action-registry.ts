import { effectiveInternalNotificationKind } from "@/lib/internal-notifications/registry";
import type { InternalNotificationDisplay } from "@/lib/notifications/pending-inbox-types";

export type PendingInlineActionKind =
  | "price_approval"
  | "contract_review"
  | "property_data_review";

function contractPendingLooksDecisional(notification: InternalNotificationDisplay) {
  const text = `${notification.title ?? ""} ${notification.body ?? ""}`.toLowerCase();
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
  if (notification.kind === "property_data_review") return "property_data_review";
  if (notification.kind === "contract_review") return "contract_review";
  if (
    notification.kind === "contract_pending" &&
    contractPendingLooksDecisional(notification)
  ) {
    return "contract_review";
  }
  return null;
}
