"use client";

import { useMemo, useState, type ReactNode } from "react";
import type {
  EngagementPolicyOverrides,
  HumanInvolvementKind,
} from "@agents/types";

type Weekday = { key: number; label: string };

const WEEKDAYS: Weekday[] = [
  { key: 1, label: "Lun" },
  { key: 2, label: "Mar" },
  { key: 3, label: "Mié" },
  { key: 4, label: "Jue" },
  { key: 5, label: "Vie" },
  { key: 6, label: "Sáb" },
  { key: 0, label: "Dom" },
];

/** Defaults that match apps/web engagement-policies/registry.ts KIND_POLICIES. */
const DEFAULTS = {
  action_authorization: {
    reminder_cooldown_hours: 4,
    max_reminder_attempts: 3,
    escalate_after_hours: 24,
  },
  business_decision: {
    reminder_cooldown_hours: 4,
    max_reminder_attempts: 3,
    escalate_after_hours: 24,
  },
  human_contribution: {
    reminder_cooldown_hours: 8,
    max_reminder_attempts: 3,
    nudge_after_upload_minutes: 20,
  },
  internal_window: {
    days: [1, 2, 3, 4, 5, 6, 0] as number[],
    start: "08:00",
    end: "21:00",
  },
  external: {
    days: [1, 2, 3, 4, 5, 6, 0] as number[],
    start: "09:00",
    end: "20:00",
    reminder_cooldown_hours: 24,
    max_attempts: 3,
  },
} as const;

function numberOrFallback(value: unknown, fallback: number) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeDays(value: unknown, fallback: number[]) {
  if (!Array.isArray(value)) return fallback;
  const days = value
    .map((item) => (typeof item === "number" ? item : Number(item)))
    .filter((item) => Number.isInteger(item) && item >= 0 && item <= 6);
  return days.length > 0 ? [...new Set(days)] : fallback;
}

function timeOrFallback(value: unknown, fallback: string) {
  return typeof value === "string" && /^\d{2}:\d{2}$/.test(value.trim())
    ? value.trim()
    : fallback;
}

function sortDays(days: number[]) {
  return [...days].sort((a, b) => {
    const ai = WEEKDAYS.findIndex((day) => day.key === a);
    const bi = WEEKDAYS.findIndex((day) => day.key === b);
    return ai - bi;
  });
}

interface Props {
  initialTimezone: string;
  initialOverrides: EngagementPolicyOverrides;
}

export function EngagementPolicySettingsCard({
  initialTimezone,
  initialOverrides,
}: Props) {
  const internalAudience = initialOverrides.by_audience?.internal_user ?? {};
  const externalAudience = initialOverrides.by_audience?.external_contact ?? {};
  const involvement = initialOverrides.by_involvement ?? {};
  // Legacy: older UI wrote HITL knobs only to by_kind.tool_confirmation_pending.
  const legacyHitl = initialOverrides.by_kind?.tool_confirmation_pending ?? {};

  const actionAuth =
    involvement.action_authorization ??
    (Object.keys(legacyHitl).length > 0 ? legacyHitl : {});
  const business = involvement.business_decision ?? {};
  const contribution = involvement.human_contribution ?? {};

  const [internalWorkingHours, setInternalWorkingHours] = useState(
    internalAudience.respect_working_hours ?? true
  );
  const [internalDays, setInternalDays] = useState<number[]>(
    sortDays(
      normalizeDays(
        internalAudience.delivery_window?.days_of_week,
        [...DEFAULTS.internal_window.days]
      )
    )
  );
  const [internalStart, setInternalStart] = useState(
    timeOrFallback(
      internalAudience.delivery_window?.start_time,
      DEFAULTS.internal_window.start
    )
  );
  const [internalEnd, setInternalEnd] = useState(
    timeOrFallback(
      internalAudience.delivery_window?.end_time,
      DEFAULTS.internal_window.end
    )
  );

  const [actionCooldown, setActionCooldown] = useState(
    numberOrFallback(
      actionAuth.reminder_cooldown_hours,
      DEFAULTS.action_authorization.reminder_cooldown_hours
    )
  );
  const [actionMaxReminders, setActionMaxReminders] = useState(
    numberOrFallback(
      actionAuth.max_reminder_attempts,
      DEFAULTS.action_authorization.max_reminder_attempts
    )
  );
  const [actionEscalateAfter, setActionEscalateAfter] = useState(
    numberOrFallback(
      actionAuth.escalate_after_hours,
      DEFAULTS.action_authorization.escalate_after_hours
    )
  );

  const [businessCooldown, setBusinessCooldown] = useState(
    numberOrFallback(
      business.reminder_cooldown_hours,
      DEFAULTS.business_decision.reminder_cooldown_hours
    )
  );
  const [businessMaxReminders, setBusinessMaxReminders] = useState(
    numberOrFallback(
      business.max_reminder_attempts,
      DEFAULTS.business_decision.max_reminder_attempts
    )
  );
  const [businessEscalateAfter, setBusinessEscalateAfter] = useState(
    numberOrFallback(
      business.escalate_after_hours,
      DEFAULTS.business_decision.escalate_after_hours
    )
  );

  const [contributionCooldown, setContributionCooldown] = useState(
    numberOrFallback(
      contribution.reminder_cooldown_hours,
      DEFAULTS.human_contribution.reminder_cooldown_hours
    )
  );
  const [contributionMaxReminders, setContributionMaxReminders] = useState(
    numberOrFallback(
      contribution.max_reminder_attempts,
      DEFAULTS.human_contribution.max_reminder_attempts
    )
  );
  const [contributionNudgeMinutes, setContributionNudgeMinutes] = useState(
    numberOrFallback(
      contribution.nudge_after_upload_minutes,
      DEFAULTS.human_contribution.nudge_after_upload_minutes
    )
  );

  const [externalWorkingHours, setExternalWorkingHours] = useState(
    externalAudience.respect_working_hours ?? true
  );
  const [externalDays, setExternalDays] = useState<number[]>(
    sortDays(
      normalizeDays(externalAudience.delivery_window?.days_of_week, [
        ...DEFAULTS.external.days,
      ])
    )
  );
  const [externalStart, setExternalStart] = useState(
    timeOrFallback(
      externalAudience.delivery_window?.start_time,
      DEFAULTS.external.start
    )
  );
  const [externalEnd, setExternalEnd] = useState(
    timeOrFallback(
      externalAudience.delivery_window?.end_time,
      DEFAULTS.external.end
    )
  );
  const [externalReminderCooldown, setExternalReminderCooldown] = useState(
    numberOrFallback(
      externalAudience.reminder_cooldown_hours,
      DEFAULTS.external.reminder_cooldown_hours
    )
  );
  const [externalMaxAttempts, setExternalMaxAttempts] = useState(
    numberOrFallback(
      externalAudience.max_attempts,
      DEFAULTS.external.max_attempts
    )
  );

  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const timezone = useMemo(
    () =>
      typeof initialTimezone === "string" && initialTimezone.trim()
        ? initialTimezone.trim()
        : "UTC",
    [initialTimezone]
  );

  function toggleDay(
    current: number[],
    updater: (next: number[]) => void,
    day: number
  ) {
    const hasDay = current.includes(day);
    const next = hasDay ? current.filter((item) => item !== day) : [...current, day];
    updater(sortDays(next));
  }

  async function save() {
    setSaving(true);
    setSaveError(null);
    setSaveMessage(null);
    try {
      const byInvolvement: NonNullable<EngagementPolicyOverrides["by_involvement"]> =
        {
          action_authorization: {
            reminder_cooldown_hours: actionCooldown,
            max_reminder_attempts: actionMaxReminders,
            escalate_after_hours: actionEscalateAfter,
            escalation_priority: "high",
          },
          business_decision: {
            reminder_cooldown_hours: businessCooldown,
            max_reminder_attempts: businessMaxReminders,
            escalate_after_hours: businessEscalateAfter,
            escalation_priority: "high",
          },
          human_contribution: {
            reminder_cooldown_hours: contributionCooldown,
            max_reminder_attempts: contributionMaxReminders,
            nudge_after_upload_minutes: contributionNudgeMinutes,
          },
        };
      const engagementPolicyOverrides: EngagementPolicyOverrides = {
        by_audience: {
          internal_user: {
            respect_working_hours: internalWorkingHours,
            delivery_window: {
              timezone,
              days_of_week:
                internalDays.length > 0
                  ? internalDays
                  : [...DEFAULTS.internal_window.days],
              start_time: internalStart,
              end_time: internalEnd,
            },
          },
          external_contact: {
            reminder_cooldown_hours: externalReminderCooldown,
            max_attempts: externalMaxAttempts,
            respect_working_hours: externalWorkingHours,
            delivery_window: {
              timezone,
              days_of_week:
                externalDays.length > 0
                  ? externalDays
                  : [...DEFAULTS.external.days],
              start_time: externalStart,
              end_time: externalEnd,
            },
          },
        },
        by_involvement: byInvolvement,
        // Compat: keep writing tool_confirmation_pending so older readers
        // that only look at by_kind still see authorization knobs.
        by_kind: {
          tool_confirmation_pending: {
            ...byInvolvement.action_authorization,
          },
        },
      };
      const response = await fetch("/api/notification-preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          engagement_policy_overrides_jsonb: engagementPolicyOverrides,
        }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(payload.error ?? "No se pudo guardar");
      }
      setSaveMessage("Políticas de entrega guardadas.");
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "No se pudo guardar");
    } finally {
      setSaving(false);
    }
  }

  function involvementSection(params: {
    title: string;
    subtitle: string;
    involvement: HumanInvolvementKind;
    children: ReactNode;
  }) {
    return (
      <div className="rounded border border-blue-200 bg-white/90 p-3 dark:border-blue-900 dark:bg-blue-950/30">
        <div className="text-xs font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-300">
          {params.title}
        </div>
        <p className="mt-1 text-[11px] text-neutral-600 dark:text-neutral-400">
          {params.subtitle}
        </p>
        <div className="mt-2 space-y-2 text-xs">{params.children}</div>
      </div>
    );
  }

  return (
    <section className="rounded-xl border border-blue-200 bg-blue-50/60 p-3 dark:border-blue-900 dark:bg-blue-950/20">
      <p className="text-xs text-blue-800/90 dark:text-blue-200/90">
        Configuración global de tu cuenta: aplica a recordatorios proactivos
        según el tipo de involucramiento humano (autorización, decisión de
        negocio o contribución). Horario local:{" "}
        <span className="font-mono">{timezone}</span> (desde tu perfil de usuario).
        Los valores mostrados son los defaults del motor cuando no hay override.
      </p>

      <div className="mt-3 space-y-3">
        <div className="rounded border border-blue-200 bg-white/90 p-3 dark:border-blue-900 dark:bg-blue-950/30">
          <div className="text-xs font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-300">
            Ventana del asesor interno
          </div>
          <div className="mt-2 space-y-2 text-xs">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={internalWorkingHours}
                onChange={(event) => setInternalWorkingHours(event.target.checked)}
              />
              Respetar ventana de entrega
            </label>
            <div className="flex flex-wrap gap-2">
              {WEEKDAYS.map((day) => (
                <button
                  key={`internal-day-${day.key}`}
                  type="button"
                  onClick={() => toggleDay(internalDays, setInternalDays, day.key)}
                  className={`rounded border px-2 py-1 text-[11px] ${
                    internalDays.includes(day.key)
                      ? "border-blue-500 bg-blue-100 text-blue-800 dark:border-blue-400 dark:bg-blue-900/50 dark:text-blue-200"
                      : "border-neutral-300 bg-white text-neutral-600 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300"
                  }`}
                >
                  {day.label}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-1">
                <span>Desde</span>
                <input
                  type="time"
                  value={internalStart}
                  onChange={(event) => setInternalStart(event.target.value)}
                  className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span>Hasta</span>
                <input
                  type="time"
                  value={internalEnd}
                  onChange={(event) => setInternalEnd(event.target.value)}
                  className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950"
                />
              </label>
            </div>
          </div>
        </div>

        <div className="grid gap-3 lg:grid-cols-3">
          {involvementSection({
            title: "Autorización de acciones",
            subtitle:
              "Confirmaciones de herramientas de riesgo medio/alto (antes etiquetado solo como HITL).",
            involvement: "action_authorization",
            children: (
              <div className="grid grid-cols-3 gap-2">
                <label className="flex flex-col gap-1">
                  <span>Cooldown (h)</span>
                  <input
                    type="number"
                    min={1}
                    value={actionCooldown}
                    onChange={(event) =>
                      setActionCooldown(
                        numberOrFallback(
                          event.target.value,
                          DEFAULTS.action_authorization.reminder_cooldown_hours
                        )
                      )
                    }
                    className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span>Máx. recordatorios</span>
                  <input
                    type="number"
                    min={1}
                    value={actionMaxReminders}
                    onChange={(event) =>
                      setActionMaxReminders(
                        numberOrFallback(
                          event.target.value,
                          DEFAULTS.action_authorization.max_reminder_attempts
                        )
                      )
                    }
                    className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span>Escalar tras (h)</span>
                  <input
                    type="number"
                    min={1}
                    value={actionEscalateAfter}
                    onChange={(event) =>
                      setActionEscalateAfter(
                        numberOrFallback(
                          event.target.value,
                          DEFAULTS.action_authorization.escalate_after_hours
                        )
                      )
                    }
                    className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950"
                  />
                </label>
              </div>
            ),
          })}

          {involvementSection({
            title: "Decisiones de negocio",
            subtitle:
              "Precio, contrato, revisión de datos, titularidad y destinos de publicación.",
            involvement: "business_decision",
            children: (
              <div className="grid grid-cols-3 gap-2">
                <label className="flex flex-col gap-1">
                  <span>Cooldown (h)</span>
                  <input
                    type="number"
                    min={1}
                    value={businessCooldown}
                    onChange={(event) =>
                      setBusinessCooldown(
                        numberOrFallback(
                          event.target.value,
                          DEFAULTS.business_decision.reminder_cooldown_hours
                        )
                      )
                    }
                    className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span>Máx. recordatorios</span>
                  <input
                    type="number"
                    min={1}
                    value={businessMaxReminders}
                    onChange={(event) =>
                      setBusinessMaxReminders(
                        numberOrFallback(
                          event.target.value,
                          DEFAULTS.business_decision.max_reminder_attempts
                        )
                      )
                    }
                    className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span>Escalar tras (h)</span>
                  <input
                    type="number"
                    min={1}
                    value={businessEscalateAfter}
                    onChange={(event) =>
                      setBusinessEscalateAfter(
                        numberOrFallback(
                          event.target.value,
                          DEFAULTS.business_decision.escalate_after_hours
                        )
                      )
                    }
                    className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950"
                  />
                </label>
              </div>
            ),
          })}

          {involvementSection({
            title: "Tareas del asesor",
            subtitle:
              "Documentos, fotos y datos que debe aportar. El primer aviso de «listo» se mide desde el último archivo.",
            involvement: "human_contribution",
            children: (
              <div className="grid grid-cols-3 gap-2">
                <label className="flex flex-col gap-1">
                  <span>Primer aviso (min)</span>
                  <input
                    type="number"
                    min={1}
                    value={contributionNudgeMinutes}
                    onChange={(event) =>
                      setContributionNudgeMinutes(
                        numberOrFallback(
                          event.target.value,
                          DEFAULTS.human_contribution.nudge_after_upload_minutes
                        )
                      )
                    }
                    className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span>Cooldown (h)</span>
                  <input
                    type="number"
                    min={1}
                    value={contributionCooldown}
                    onChange={(event) =>
                      setContributionCooldown(
                        numberOrFallback(
                          event.target.value,
                          DEFAULTS.human_contribution.reminder_cooldown_hours
                        )
                      )
                    }
                    className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span>Máx. recordatorios</span>
                  <input
                    type="number"
                    min={1}
                    value={contributionMaxReminders}
                    onChange={(event) =>
                      setContributionMaxReminders(
                        numberOrFallback(
                          event.target.value,
                          DEFAULTS.human_contribution.max_reminder_attempts
                        )
                      )
                    }
                    className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950"
                  />
                </label>
              </div>
            ),
          })}
        </div>

        <div className="rounded border border-blue-200 bg-white/90 p-3 dark:border-blue-900 dark:bg-blue-950/30">
          <div className="text-xs font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-300">
            Contacto externo (recordatorios)
          </div>
          <div className="mt-2 space-y-2 text-xs">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={externalWorkingHours}
                onChange={(event) => setExternalWorkingHours(event.target.checked)}
              />
              Respetar ventana de entrega
            </label>
            <div className="flex flex-wrap gap-2">
              {WEEKDAYS.map((day) => (
                <button
                  key={`external-day-${day.key}`}
                  type="button"
                  onClick={() => toggleDay(externalDays, setExternalDays, day.key)}
                  className={`rounded border px-2 py-1 text-[11px] ${
                    externalDays.includes(day.key)
                      ? "border-blue-500 bg-blue-100 text-blue-800 dark:border-blue-400 dark:bg-blue-900/50 dark:text-blue-200"
                      : "border-neutral-300 bg-white text-neutral-600 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300"
                  }`}
                >
                  {day.label}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-1">
                <span>Desde</span>
                <input
                  type="time"
                  value={externalStart}
                  onChange={(event) => setExternalStart(event.target.value)}
                  className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span>Hasta</span>
                <input
                  type="time"
                  value={externalEnd}
                  onChange={(event) => setExternalEnd(event.target.value)}
                  className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950"
                />
              </label>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-1">
                <span>Cooldown (h)</span>
                <input
                  type="number"
                  min={1}
                  value={externalReminderCooldown}
                  onChange={(event) =>
                    setExternalReminderCooldown(
                      numberOrFallback(
                        event.target.value,
                        DEFAULTS.external.reminder_cooldown_hours
                      )
                    )
                  }
                  className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span>Máx. intentos</span>
                <input
                  type="number"
                  min={1}
                  value={externalMaxAttempts}
                  onChange={(event) =>
                    setExternalMaxAttempts(
                      numberOrFallback(
                        event.target.value,
                        DEFAULTS.external.max_attempts
                      )
                    )
                  }
                  className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950"
                />
              </label>
            </div>
          </div>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="rounded bg-blue-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
        >
          {saving ? "Guardando..." : "Guardar políticas"}
        </button>
        {saveMessage ? (
          <span className="text-xs text-emerald-700 dark:text-emerald-300">
            {saveMessage}
          </span>
        ) : null}
        {saveError ? (
          <span className="text-xs text-red-700 dark:text-red-300">{saveError}</span>
        ) : null}
      </div>
    </section>
  );
}
