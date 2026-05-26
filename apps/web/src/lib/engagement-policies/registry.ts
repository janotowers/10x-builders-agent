import type { NotificationChannel, NotificationPriority } from "@agents/types";

export type EngagementAudience =
  | "internal_user"
  | "external_prospect"
  | "external_owner"
  | "external_contact";

export type EngagementIntent =
  | "approval"
  | "review"
  | "reminder"
  | "question"
  | "followup"
  | "escalation"
  | "technical";

export interface EngagementPolicyContext {
  audience: EngagementAudience;
  intent: EngagementIntent;
  channel?: NotificationChannel;
  kind?: string | null;
  priority?: NotificationPriority;
  caseType?: string | null;
}

export interface EngagementPolicy {
  defaultDueAfterHours?: number;
  reminderCooldownHours: number;
  maxAttempts?: number;
  respectWorkingHours: boolean;
  allowAutonomousAction: boolean;
}

const DEFAULT_POLICY: EngagementPolicy = {
  reminderCooldownHours: 24,
  respectWorkingHours: true,
  allowAutonomousAction: false,
};

const AUDIENCE_POLICIES: Record<EngagementAudience, Partial<EngagementPolicy>> = {
  internal_user: {
    reminderCooldownHours: 8,
    respectWorkingHours: true,
  },
  external_prospect: {
    reminderCooldownHours: 24,
    maxAttempts: 3,
    respectWorkingHours: true,
  },
  external_owner: {
    reminderCooldownHours: 24,
    maxAttempts: 3,
    respectWorkingHours: true,
  },
  external_contact: {
    reminderCooldownHours: 24,
    maxAttempts: 3,
    respectWorkingHours: true,
  },
};

const INTENT_POLICIES: Partial<Record<EngagementIntent, Partial<EngagementPolicy>>> = {
  approval: {
    defaultDueAfterHours: 4,
    reminderCooldownHours: 4,
  },
  review: {
    reminderCooldownHours: 4,
  },
  followup: {
    reminderCooldownHours: 24,
    maxAttempts: 3,
  },
  escalation: {
    reminderCooldownHours: 4,
  },
  technical: {
    reminderCooldownHours: 24,
    respectWorkingHours: false,
  },
};

const KIND_POLICIES: Record<string, Partial<EngagementPolicy>> = {
  tool_readiness_test: {
    respectWorkingHours: false,
  },
  price_approval: {
    defaultDueAfterHours: 4,
    reminderCooldownHours: 4,
  },
  contract_review: {
    reminderCooldownHours: 4,
  },
  contract_approval: {
    defaultDueAfterHours: 4,
    reminderCooldownHours: 4,
  },
  contract_pending: {
    reminderCooldownHours: 4,
  },
  external_contact_escalation: {
    reminderCooldownHours: 4,
  },
};

const PRIORITY_POLICIES: Record<NotificationPriority, Partial<EngagementPolicy>> = {
  low: {},
  normal: {},
  high: {
    reminderCooldownHours: 1,
  },
};

function mergePolicy(...parts: Array<Partial<EngagementPolicy> | undefined>) {
  return Object.assign({}, ...parts) as EngagementPolicy;
}

export function resolveEngagementPolicy(
  context: EngagementPolicyContext
): EngagementPolicy {
  return mergePolicy(
    DEFAULT_POLICY,
    AUDIENCE_POLICIES[context.audience],
    INTENT_POLICIES[context.intent],
    context.kind ? KIND_POLICIES[context.kind] : undefined,
    context.priority ? PRIORITY_POLICIES[context.priority] : undefined
  );
}

export function defaultDueAtForEngagement(
  context: EngagementPolicyContext,
  now = Date.now()
): string | null {
  const hours = resolveEngagementPolicy(context).defaultDueAfterHours;
  if (hours == null) return null;
  return new Date(now + hours * 60 * 60_000).toISOString();
}

export function reminderCooldownHoursForEngagement(
  context: EngagementPolicyContext
): number {
  return resolveEngagementPolicy(context).reminderCooldownHours;
}
