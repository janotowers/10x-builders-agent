"use client";

import { useMemo, useState } from "react";
import type { EngagementPolicyOverrides } from "@agents/types";

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
  const hitlKind = initialOverrides.by_kind?.tool_confirmation_pending ?? {};

  const [internalWorkingHours, setInternalWorkingHours] = useState(
    internalAudience.respect_working_hours ?? true
  );
  const [internalDays, setInternalDays] = useState<number[]>(
    sortDays(normalizeDays(internalAudience.delivery_window?.days_of_week, [1, 2, 3, 4, 5]))
  );
  const [internalStart, setInternalStart] = useState(
    timeOrFallback(internalAudience.delivery_window?.start_time, "08:00")
  );
  const [internalEnd, setInternalEnd] = useState(
    timeOrFallback(internalAudience.delivery_window?.end_time, "21:00")
  );
  const [internalReminderCooldown, setInternalReminderCooldown] = useState(
    numberOrFallback(hitlKind.reminder_cooldown_hours, 4)
  );
  const [internalMaxReminders, setInternalMaxReminders] = useState(
    numberOrFallback(hitlKind.max_reminder_attempts, 3)
  );
  const [internalEscalateAfter, setInternalEscalateAfter] = useState(
    numberOrFallback(hitlKind.escalate_after_hours, 24)
  );

  const [externalWorkingHours, setExternalWorkingHours] = useState(
    externalAudience.respect_working_hours ?? true
  );
  const [externalDays, setExternalDays] = useState<number[]>(
    sortDays(normalizeDays(externalAudience.delivery_window?.days_of_week, [1, 2, 3, 4, 5, 6]))
  );
  const [externalStart, setExternalStart] = useState(
    timeOrFallback(externalAudience.delivery_window?.start_time, "09:00")
  );
  const [externalEnd, setExternalEnd] = useState(
    timeOrFallback(externalAudience.delivery_window?.end_time, "20:00")
  );
  const [externalReminderCooldown, setExternalReminderCooldown] = useState(
    numberOrFallback(externalAudience.reminder_cooldown_hours, 24)
  );
  const [externalMaxAttempts, setExternalMaxAttempts] = useState(
    numberOrFallback(externalAudience.max_attempts, 3)
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
      const engagementPolicyOverrides: EngagementPolicyOverrides = {
        by_audience: {
          internal_user: {
            respect_working_hours: internalWorkingHours,
            delivery_window: {
              timezone,
              days_of_week: internalDays.length > 0 ? internalDays : [1, 2, 3, 4, 5],
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
                externalDays.length > 0 ? externalDays : [1, 2, 3, 4, 5, 6],
              start_time: externalStart,
              end_time: externalEnd,
            },
          },
        },
        by_kind: {
          tool_confirmation_pending: {
            reminder_cooldown_hours: internalReminderCooldown,
            max_reminder_attempts: internalMaxReminders,
            escalate_after_hours: internalEscalateAfter,
            escalation_priority: "high",
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

  return (
    <section className="rounded-xl border border-blue-200 bg-blue-50/60 p-3 dark:border-blue-900 dark:bg-blue-950/20">
      <p className="text-xs text-blue-800/90 dark:text-blue-200/90">
        Configuración global de tu cuenta: aplica a todos los flujos operativos
        y recordatorios proactivos. Horario local:{" "}
        <span className="font-mono">{timezone}</span> (desde tu perfil de usuario).
      </p>
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <div className="rounded border border-blue-200 bg-white/90 p-3 dark:border-blue-900 dark:bg-blue-950/30">
          <div className="text-xs font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-300">
            Asesor interno (HITL)
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
            <div className="grid grid-cols-3 gap-2">
              <label className="flex flex-col gap-1">
                <span>Cooldown (h)</span>
                <input
                  type="number"
                  min={1}
                  value={internalReminderCooldown}
                  onChange={(event) =>
                    setInternalReminderCooldown(numberOrFallback(event.target.value, 4))
                  }
                  className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span>Máx. recordatorios</span>
                <input
                  type="number"
                  min={1}
                  value={internalMaxReminders}
                  onChange={(event) =>
                    setInternalMaxReminders(numberOrFallback(event.target.value, 3))
                  }
                  className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span>Escalar tras (h)</span>
                <input
                  type="number"
                  min={1}
                  value={internalEscalateAfter}
                  onChange={(event) =>
                    setInternalEscalateAfter(numberOrFallback(event.target.value, 24))
                  }
                  className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950"
                />
              </label>
            </div>
          </div>
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
                    setExternalReminderCooldown(numberOrFallback(event.target.value, 24))
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
                    setExternalMaxAttempts(numberOrFallback(event.target.value, 3))
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
