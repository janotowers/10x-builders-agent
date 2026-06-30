import type { InternalUserNotificationStatus } from "@agents/types";
import {
  defaultDueAtForEngagement,
  resolveEngagementPolicy,
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
  businessDecision?: "price_approval" | "contract_review" | "contract_data_review";
  technical?: boolean;
  /**
   * Pure FYI notifications: no decision/action expected from the user, so the
   * inbox only offers an acknowledge ("Entendido") button.
   */
  informational?: boolean;
  /**
   * Label for the primary CTA when the notification needs action but has no
   * inline resolver UI (the action lives in the operational case flow).
   */
  reviewCtaLabel?: string;
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
  contract_data_review: {
    kind: "contract_data_review",
    label: "Datos contractuales faltantes",
    visibleInInbox: true,
    intent: "review",
    businessDecision: "contract_data_review",
    reviewCtaLabel: "Capturar datos del comitente",
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
    reviewCtaLabel: "Revisar y confirmar en flujo",
  },
  contract_revision_upload: {
    kind: "contract_revision_upload",
    label: "Subir contrato corregido",
    visibleInInbox: true,
    intent: "review",
    reviewCtaLabel: "Subir DOCX/PDF corregido",
  },
  contract_drafted: {
    kind: "contract_drafted",
    label: "Borrador de contrato listo",
    visibleInInbox: true,
    intent: "reminder",
    informational: true,
  },
  property_data_review: {
    kind: "property_data_review",
    label: "Revisión de datos de propiedad",
    visibleInInbox: true,
    intent: "review",
    reviewCtaLabel: "Confirmar o corregir en flujo",
  },
  property_data_quality_review: {
    kind: "property_data_quality_review",
    label: "Validar calidad de superficie predial",
    visibleInInbox: true,
    intent: "review",
    reviewCtaLabel: "Confirmar m² correctos",
  },
  comparables_analysis: {
    kind: "comparables_analysis",
    label: "Analisis de comparables",
    visibleInInbox: true,
    intent: "reminder",
    informational: true,
  },
  comparables_insufficient_data: {
    kind: "comparables_insufficient_data",
    label: "Comparables insuficientes (informativo)",
    visibleInInbox: true,
    intent: "reminder",
    informational: true,
  },
  comparables_search_expansion_decision: {
    kind: "comparables_search_expansion_decision",
    label: "Decision de ampliacion de busqueda",
    visibleInInbox: true,
    intent: "review",
    reviewCtaLabel: "Elegir ampliacion en flujo",
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
  tool_confirmation_pending: {
    kind: "tool_confirmation_pending",
    label: "Esperando aprobación humana (HITL)",
    visibleInInbox: true,
    intent: "approval",
    reviewCtaLabel: "Ver acciones del agente",
  },
  missing_requirements: {
    kind: "missing_requirements",
    label: "Requisitos faltantes",
    visibleInInbox: true,
    intent: "reminder",
    reviewCtaLabel: "Revisar en flujo",
  },
  integration_reconnect: {
    kind: "integration_reconnect",
    label: "Reconectar integración",
    visibleInInbox: true,
    intent: "reminder",
    reviewCtaLabel: "Reconectar integración",
  },
  document_extraction_failed: {
    kind: "document_extraction_failed",
    label: "No pude leer documentos del caso",
    visibleInInbox: true,
    intent: "reminder",
    reviewCtaLabel: "Revisar documentos",
  },
  titularidad_review: {
    kind: "titularidad_review",
    label: "Verificación de titularidad",
    visibleInInbox: true,
    intent: "review",
    reviewCtaLabel: "Revisar titularidad",
  },
  internal_notification_reminder: {
    kind: "internal_notification_reminder",
    label: "Recordatorio",
    visibleInInbox: true,
    intent: "reminder",
  },
  internal_notification_escalation: {
    kind: "internal_notification_escalation",
    label: "Escalación de pendiente",
    visibleInInbox: true,
    intent: "escalation",
    reviewCtaLabel: "Revisar en flujo",
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

/**
 * Canonicaliza variantes de forma libre que el agente puede emitir para
 * "análisis de comparables listo" (p. ej. "comparables_ready",
 * "comparables analysis ready", "property_comparables") al kind canónico
 * `comparables_analysis`, que está marcado como `informational` y por tanto NO
 * bloquea el flujo como pendiente humano. Las decisiones reales de comparables
 * (`comparables_insufficient_data`, `comparables_search_expansion_decision`) se
 * preservan intactas.
 */
function canonicalizeComparablesNotificationKind(kind: string): string {
  if (
    kind === "price_proposal" ||
    kind === "priceproposal" ||
    kind === "pricing_proposal" ||
    kind === "proposal_price"
  ) {
    return "price_approval";
  }
  if (
    kind === "comparables_insufficient_data" ||
    kind === "comparables_search_expansion_decision"
  ) {
    return kind;
  }
  if (kind === "property_comparables") return "comparables_analysis";
  if (
    kind.startsWith("comparable") &&
    /(ready|analysis|analisis|complete|completo|completado|done|summary|resumen|listo)/.test(
      kind
    )
  ) {
    return "comparables_analysis";
  }
  return kind;
}

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
  const kind = canonicalizeComparablesNotificationKind(
    normalizeNotificationKindKey(params.kind || "general")
  );
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

export function maxReminderAttemptsForNotificationKind(
  kind: string | null | undefined
): number | null {
  const config = internalNotificationKindConfig(kind);
  const policy = resolveEngagementPolicy({
    audience: "internal_user",
    intent: config.intent ?? "reminder",
    kind: config.kind,
  });
  return policy.maxReminderAttempts ?? null;
}

export function escalationPolicyForNotificationKind(
  kind: string | null | undefined
): {
  escalateAfterHours: number | null;
  escalationPriority: "high" | null;
} {
  const config = internalNotificationKindConfig(kind);
  const policy = resolveEngagementPolicy({
    audience: "internal_user",
    intent: config.intent ?? "reminder",
    kind: config.kind,
  });
  return {
    escalateAfterHours: policy.escalateAfterHours ?? null,
    escalationPriority: policy.escalationPriority ?? null,
  };
}

export function autoStatusOnCreateForNotificationKind(
  kind: string | null | undefined
): InternalNotificationActionStatus | null {
  return internalNotificationKindConfig(kind).autoStatusOnCreate ?? null;
}
