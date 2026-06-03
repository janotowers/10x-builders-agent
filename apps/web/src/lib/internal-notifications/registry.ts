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
  comparables_analysis: {
    kind: "comparables_analysis",
    label: "Analisis de comparables",
    visibleInInbox: true,
    intent: "reminder",
  },
  property_comparables: {
    kind: "property_comparables",
    label: "Comparables de propiedad",
    visibleInInbox: true,
    intent: "reminder",
  },
  preflight_check: {
    kind: "preflight_check",
    label: "Verificacion previa",
    visibleInInbox: true,
    intent: "reminder",
  },
  missing_requirements: {
    kind: "missing_requirements",
    label: "Requisitos faltantes",
    visibleInInbox: true,
    intent: "reminder",
  },
};

export function humanizeNotificationKind(kind: string): string {
  return kind.replace(/[_-]+/g, " ").trim() || "Notificacion";
}

function normalizeNotificationKindKey(kind: string): string {
  return kind.trim().toLowerCase().replace(/\s+/g, "_");
}

const COMPARABLES_NOTIFICATION_KINDS = new Set([
  "comparables_analysis",
  "property_comparables",
]);

function notificationDecisionText(params: {
  kind: string;
  body?: string | null;
  title?: string | null;
}) {
  return `${params.title ?? ""} ${params.body ?? ""}`.toLowerCase();
}

/** Algunos notify_user de comparables piden revisión de precio sin kind=price_approval. */
export function effectiveInternalNotificationKind(params: {
  kind: string;
  body?: string | null;
  title?: string | null;
}): string {
  const kind = normalizeNotificationKindKey(params.kind || "general");
  if (kind === "price_approval") return kind;
  if (!COMPARABLES_NOTIFICATION_KINDS.has(kind)) return kind;

  const text = notificationDecisionText(params);
  if (
    /revisemos el precio|precio propuesto|aprobar precio|aprobacion de precio|aprobar el precio|revisar precio/.test(
      text
    )
  ) {
    return "price_approval";
  }
  return kind;
}

export function internalNotificationKindConfig(
  kind: string | null | undefined,
  opts: { body?: string | null; title?: string | null } = {}
): InternalNotificationKindConfig {
  const normalized = effectiveInternalNotificationKind({
    kind: normalizeNotificationKindKey(kind?.trim() || "general"),
    body: opts.body,
    title: opts.title,
  });
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
