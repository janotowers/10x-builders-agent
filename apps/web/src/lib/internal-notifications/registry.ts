import type { InternalUserNotificationStatus } from "@agents/types";
import {
  defaultDueAtForEngagement,
  reminderCooldownHoursForEngagement,
  type EngagementIntent,
} from "@/lib/engagement-policies/registry";

export type InternalNotificationActionStatus = Exclude<
  InternalUserNotificationStatus,
  "unread"
>;

export interface InternalNotificationKindConfig {
  kind: string;
  label: string;
  visibleInInbox: boolean;
  autoStatusOnCreate?: InternalNotificationActionStatus;
  intent?: EngagementIntent;
  businessDecision?: "price_approval" | "contract_review";
  technical?: boolean;
}

export const INTERNAL_NOTIFICATION_KIND_CONFIGS: Record<
  string,
  InternalNotificationKindConfig
> = {
  tool_readiness_test: {
    kind: "tool_readiness_test",
    label: "Prueba tecnica de notificacion",
    visibleInInbox: false,
    autoStatusOnCreate: "actioned",
    intent: "technical",
    technical: true,
  },
  price_approval: {
    kind: "price_approval",
    label: "Aprobacion de precio",
    visibleInInbox: true,
    intent: "approval",
    businessDecision: "price_approval",
  },
  contract_review: {
    kind: "contract_review",
    label: "Revision de contrato",
    visibleInInbox: true,
    intent: "review",
    businessDecision: "contract_review",
  },
  contract_owner_signed: {
    kind: "contract_owner_signed",
    label: "Contrato firmado (simulación)",
    visibleInInbox: false,
    intent: "technical",
    technical: true,
  },
  contract_approval: {
    kind: "contract_approval",
    label: "Aprobacion de contrato",
    visibleInInbox: true,
    intent: "approval",
  },
  contract_pending: {
    kind: "contract_pending",
    label: "Contrato pendiente",
    visibleInInbox: true,
    intent: "review",
  },
};

export function humanizeNotificationKind(kind: string): string {
  return kind.replace(/[_-]+/g, " ").trim() || "Notificacion";
}

export function internalNotificationKindConfig(
  kind: string | null | undefined
): InternalNotificationKindConfig {
  const normalized = kind?.trim() || "general";
  return (
    INTERNAL_NOTIFICATION_KIND_CONFIGS[normalized] ?? {
      kind: normalized,
      label: humanizeNotificationKind(normalized),
      visibleInInbox: true,
      intent: "reminder",
    }
  );
}

export function hiddenInboxNotificationKinds(): string[] {
  return Object.values(INTERNAL_NOTIFICATION_KIND_CONFIGS)
    .filter((config) => !config.visibleInInbox)
    .map((config) => config.kind);
}

export function defaultDueAtForNotificationKind(
  kind: string | null | undefined,
  now = Date.now()
): string | null {
  const config = internalNotificationKindConfig(kind);
  return defaultDueAtForEngagement(
    {
      audience: "internal_user",
      intent: config.intent ?? "reminder",
      kind: config.kind,
    },
    now
  );
}

export function reminderCooldownHoursForNotificationKind(
  kind: string | null | undefined
): number {
  const config = internalNotificationKindConfig(kind);
  return reminderCooldownHoursForEngagement({
    audience: "internal_user",
    intent: config.intent ?? "reminder",
    kind: config.kind,
  });
}

export function autoStatusOnCreateForNotificationKind(
  kind: string | null | undefined
): InternalNotificationActionStatus | null {
  return internalNotificationKindConfig(kind).autoStatusOnCreate ?? null;
}
