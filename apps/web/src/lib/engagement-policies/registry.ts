import type {
  EngagementDeliveryWindow,
  EngagementPolicyOverride,
  EngagementPolicyOverrides,
  NotificationChannel,
  NotificationPriority,
} from "@agents/types";
import { calendarDateInZone, zonedWallTimeToUtc } from "@/lib/zoned-time";

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
  maxReminderAttempts?: number;
  escalateAfterHours?: number;
  escalationPriority?: "high";
  respectWorkingHours: boolean;
  allowAutonomousAction: boolean;
  deliveryWindow?: EngagementDeliveryWindow;
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
    deliveryWindow: {
      days_of_week: [1, 2, 3, 4, 5, 6, 0],
      start_time: "08:00",
      end_time: "21:00",
    },
  },
  external_prospect: {
    reminderCooldownHours: 24,
    maxAttempts: 3,
    respectWorkingHours: true,
    deliveryWindow: {
      days_of_week: [1, 2, 3, 4, 5, 6, 0],
      start_time: "09:00",
      end_time: "20:00",
    },
  },
  external_owner: {
    reminderCooldownHours: 24,
    maxAttempts: 3,
    respectWorkingHours: true,
    deliveryWindow: {
      days_of_week: [1, 2, 3, 4, 5, 6, 0],
      start_time: "09:00",
      end_time: "20:00",
    },
  },
  external_contact: {
    reminderCooldownHours: 24,
    maxAttempts: 3,
    respectWorkingHours: true,
    deliveryWindow: {
      days_of_week: [1, 2, 3, 4, 5, 6, 0],
      start_time: "09:00",
      end_time: "20:00",
    },
  },
};

const INTENT_POLICIES: Partial<Record<EngagementIntent, Partial<EngagementPolicy>>> = {
  approval: {
    defaultDueAfterHours: 4,
    reminderCooldownHours: 4,
    maxReminderAttempts: 3,
    escalateAfterHours: 24,
    escalationPriority: "high",
  },
  review: {
    reminderCooldownHours: 4,
    maxReminderAttempts: 3,
    escalateAfterHours: 24,
    escalationPriority: "high",
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
    maxReminderAttempts: 3,
    escalateAfterHours: 24,
    escalationPriority: "high",
  },
  contract_review: {
    reminderCooldownHours: 4,
    maxReminderAttempts: 3,
    escalateAfterHours: 24,
    escalationPriority: "high",
  },
  contract_approval: {
    defaultDueAfterHours: 4,
    reminderCooldownHours: 4,
    maxReminderAttempts: 3,
    escalateAfterHours: 24,
    escalationPriority: "high",
  },
  contract_pending: {
    reminderCooldownHours: 4,
    maxReminderAttempts: 3,
    escalateAfterHours: 24,
    escalationPriority: "high",
  },
  property_data_review: {
    reminderCooldownHours: 4,
    maxReminderAttempts: 3,
    escalateAfterHours: 24,
    escalationPriority: "high",
  },
  tool_confirmation_pending: {
    defaultDueAfterHours: 4,
    reminderCooldownHours: 4,
    maxReminderAttempts: 3,
    escalateAfterHours: 24,
    escalationPriority: "high",
  },
  external_contact_escalation: {
    reminderCooldownHours: 4,
  },
  // Upload-batch confirmation: advisor uploaded docs/photos but may forget «listo».
  // Timing is account-overridable via engagement_policy_overrides_jsonb.
  photos_upload_requested: {
    defaultDueAfterHours: 8,
    reminderCooldownHours: 8,
    maxReminderAttempts: 3,
  },
  documents_upload_requested: {
    defaultDueAfterHours: 8,
    reminderCooldownHours: 8,
    maxReminderAttempts: 3,
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

function cleanNumericHours(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function cleanWindowTime(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return /^\d{2}:\d{2}$/.test(normalized) ? normalized : undefined;
}

function cleanWindowDays(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const cleaned = value
    .map((item) => (typeof item === "number" ? item : Number(item)))
    .filter((item) => Number.isInteger(item) && item >= 0 && item <= 6);
  return cleaned.length > 0 ? [...new Set(cleaned)] : undefined;
}

function sanitizeDeliveryWindow(
  window: EngagementDeliveryWindow | undefined
): EngagementDeliveryWindow | undefined {
  if (!window) return undefined;
  const days = cleanWindowDays(window.days_of_week);
  const startTime = cleanWindowTime(window.start_time);
  const endTime = cleanWindowTime(window.end_time);
  const timezone =
    typeof window.timezone === "string" && window.timezone.trim()
      ? window.timezone.trim()
      : undefined;
  const hasAny = Boolean(days || startTime || endTime || timezone);
  return hasAny
    ? {
        ...(days ? { days_of_week: days } : {}),
        ...(startTime ? { start_time: startTime } : {}),
        ...(endTime ? { end_time: endTime } : {}),
        ...(timezone ? { timezone } : {}),
      }
    : undefined;
}

function sanitizePolicyOverride(
  override: EngagementPolicyOverride | undefined
): Partial<EngagementPolicy> | undefined {
  if (!override) return undefined;
  const cleaned: Partial<EngagementPolicy> = {};
  const due = cleanNumericHours(override.default_due_after_hours);
  const cooldown = cleanNumericHours(override.reminder_cooldown_hours);
  const maxAttempts = cleanNumericHours(override.max_attempts);
  const maxReminderAttempts = cleanNumericHours(override.max_reminder_attempts);
  const escalateAfter = cleanNumericHours(override.escalate_after_hours);
  if (due) cleaned.defaultDueAfterHours = due;
  if (cooldown) cleaned.reminderCooldownHours = cooldown;
  if (maxAttempts) cleaned.maxAttempts = maxAttempts;
  if (maxReminderAttempts) cleaned.maxReminderAttempts = maxReminderAttempts;
  if (escalateAfter) cleaned.escalateAfterHours = escalateAfter;
  if (override.escalation_priority === "high") {
    cleaned.escalationPriority = "high";
  }
  if (typeof override.respect_working_hours === "boolean") {
    cleaned.respectWorkingHours = override.respect_working_hours;
  }
  const window = sanitizeDeliveryWindow(override.delivery_window);
  if (window) cleaned.deliveryWindow = window;
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

export function normalizeEngagementPolicyOverrides(
  raw: unknown
): EngagementPolicyOverrides {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const input = raw as EngagementPolicyOverrides;
  const byAudienceInput = input.by_audience ?? {};
  const byKindInput = input.by_kind ?? {};
  const byAudience: EngagementPolicyOverrides["by_audience"] = {};
  for (const audience of [
    "internal_user",
    "external_prospect",
    "external_owner",
    "external_contact",
  ] as const) {
    const cleaned = sanitizePolicyOverride(byAudienceInput[audience]);
    if (cleaned) {
      byAudience[audience] = {
        ...(cleaned.defaultDueAfterHours
          ? { default_due_after_hours: cleaned.defaultDueAfterHours }
          : {}),
        ...(cleaned.reminderCooldownHours
          ? { reminder_cooldown_hours: cleaned.reminderCooldownHours }
          : {}),
        ...(cleaned.maxAttempts ? { max_attempts: cleaned.maxAttempts } : {}),
        ...(cleaned.maxReminderAttempts
          ? { max_reminder_attempts: cleaned.maxReminderAttempts }
          : {}),
        ...(cleaned.escalateAfterHours
          ? { escalate_after_hours: cleaned.escalateAfterHours }
          : {}),
        ...(cleaned.escalationPriority
          ? { escalation_priority: cleaned.escalationPriority }
          : {}),
        ...(typeof cleaned.respectWorkingHours === "boolean"
          ? { respect_working_hours: cleaned.respectWorkingHours }
          : {}),
        ...(cleaned.deliveryWindow ? { delivery_window: cleaned.deliveryWindow } : {}),
      };
    }
  }
  const byKind: Record<string, EngagementPolicyOverride> = {};
  for (const [kind, override] of Object.entries(byKindInput)) {
    const cleaned = sanitizePolicyOverride(override);
    if (!cleaned || !kind.trim()) continue;
    byKind[kind.trim()] = {
      ...(cleaned.defaultDueAfterHours
        ? { default_due_after_hours: cleaned.defaultDueAfterHours }
        : {}),
      ...(cleaned.reminderCooldownHours
        ? { reminder_cooldown_hours: cleaned.reminderCooldownHours }
        : {}),
      ...(cleaned.maxAttempts ? { max_attempts: cleaned.maxAttempts } : {}),
      ...(cleaned.maxReminderAttempts
        ? { max_reminder_attempts: cleaned.maxReminderAttempts }
        : {}),
      ...(cleaned.escalateAfterHours
        ? { escalate_after_hours: cleaned.escalateAfterHours }
        : {}),
      ...(cleaned.escalationPriority
        ? { escalation_priority: cleaned.escalationPriority }
        : {}),
      ...(typeof cleaned.respectWorkingHours === "boolean"
        ? { respect_working_hours: cleaned.respectWorkingHours }
        : {}),
      ...(cleaned.deliveryWindow ? { delivery_window: cleaned.deliveryWindow } : {}),
    };
  }
  return {
    ...(Object.keys(byAudience).length > 0 ? { by_audience: byAudience } : {}),
    ...(Object.keys(byKind).length > 0 ? { by_kind: byKind } : {}),
  };
}

export function resolveEngagementPolicy(
  context: EngagementPolicyContext,
  overrides?: EngagementPolicyOverrides | null
): EngagementPolicy {
  const normalizedOverrides = normalizeEngagementPolicyOverrides(overrides ?? {});
  const overrideByAudience = sanitizePolicyOverride(
    normalizedOverrides.by_audience?.[context.audience]
  );
  const overrideByKind = context.kind
    ? sanitizePolicyOverride(normalizedOverrides.by_kind?.[context.kind])
    : undefined;
  return mergePolicy(
    DEFAULT_POLICY,
    AUDIENCE_POLICIES[context.audience],
    INTENT_POLICIES[context.intent],
    context.kind ? KIND_POLICIES[context.kind] : undefined,
    context.priority ? PRIORITY_POLICIES[context.priority] : undefined,
    overrideByAudience,
    overrideByKind
  );
}

export function defaultDueAtForEngagement(
  context: EngagementPolicyContext,
  now = Date.now(),
  overrides?: EngagementPolicyOverrides | null
): string | null {
  const hours = resolveEngagementPolicy(context, overrides).defaultDueAfterHours;
  if (hours == null) return null;
  return new Date(now + hours * 60 * 60_000).toISOString();
}

export function reminderCooldownHoursForEngagement(
  context: EngagementPolicyContext,
  overrides?: EngagementPolicyOverrides | null
): number {
  return resolveEngagementPolicy(context, overrides).reminderCooldownHours;
}

function parseHourMinute(value: string | undefined): { hour: number; minute: number } {
  if (!value || !/^\d{2}:\d{2}$/.test(value)) return { hour: 0, minute: 0 };
  const [hourRaw, minuteRaw] = value.split(":");
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  if (
    !Number.isFinite(hour) ||
    !Number.isFinite(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return { hour: 0, minute: 0 };
  }
  return { hour, minute };
}

function localWeekdayInTimezone(date: Date, timezone: string): number {
  const weekdayName = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
  }).format(date);
  const map: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return map[weekdayName] ?? 0;
}

function localDateParts(date: Date, timezone: string, dayOffset = 0) {
  return calendarDateInZone(date.toISOString(), timezone, dayOffset);
}

export function isWithinDeliveryWindow(params: {
  now: Date;
  timezone: string;
  window?: EngagementDeliveryWindow;
}): boolean {
  const window = sanitizeDeliveryWindow(params.window);
  if (!window) return true;
  const days = window.days_of_week ?? [1, 2, 3, 4, 5, 6, 0];
  const weekday = localWeekdayInTimezone(params.now, params.timezone);
  if (!days.includes(weekday)) return false;
  const { hour: startHour, minute: startMinute } = parseHourMinute(
    window.start_time
  );
  const { hour: endHour, minute: endMinute } = parseHourMinute(window.end_time);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: params.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(params.now).map((item) => [item.type, item.value])
  );
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  const nowMinutes = hour * 60 + minute;
  const startMinutes = startHour * 60 + startMinute;
  const endMinutes = endHour * 60 + endMinute;
  if (startMinutes === endMinutes) return true;
  if (startMinutes < endMinutes) {
    return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  }
  // Overnight window (e.g. 22:00-06:00)
  return nowMinutes >= startMinutes || nowMinutes < endMinutes;
}

export function nextAllowedDeliveryAt(params: {
  now: Date;
  timezone: string;
  window?: EngagementDeliveryWindow;
}): Date {
  const window = sanitizeDeliveryWindow(params.window);
  if (!window) return params.now;
  if (isWithinDeliveryWindow(params)) return params.now;
  const days = window.days_of_week ?? [1, 2, 3, 4, 5, 6, 0];
  const { hour: startHour, minute: startMinute } = parseHourMinute(
    window.start_time
  );
  for (let offset = 0; offset <= 14; offset++) {
    const localDate = localDateParts(params.now, params.timezone, offset);
    const candidate = zonedWallTimeToUtc(
      localDate.year,
      localDate.month,
      localDate.day,
      startHour,
      startMinute,
      params.timezone
    );
    if (!candidate) continue;
    const weekday = localWeekdayInTimezone(candidate, params.timezone);
    if (!days.includes(weekday)) continue;
    if (candidate.getTime() <= params.now.getTime()) continue;
    return candidate;
  }
  return new Date(params.now.getTime() + 60 * 60_000);
}
