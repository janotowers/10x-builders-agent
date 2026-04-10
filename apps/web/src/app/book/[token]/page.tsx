"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";

type Availability = {
  timezone: string;
  calendar_id: string;
  time_min: string;
  time_max: string;
  slot_starts: string[];
};

export default function PublicBookPage() {
  const params = useParams();
  const token = typeof params?.token === "string" ? params.token : "";

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<Availability | null>(null);
  const [selectedStart, setSelectedStart] = useState<string | null>(null);
  const [guestName, setGuestName] = useState("");
  const [guestNote, setGuestNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<{ html_link?: string } | null>(null);

  const slotDurationMin = 30;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/public/booking/${encodeURIComponent(token)}?days=7`);
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "No se pudo cargar.");
        setData(null);
        return;
      }
      setData(json as Availability);
    } catch {
      setError("Error de red.");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (token) void load();
  }, [token, load]);

  const slots = data?.slot_starts ?? [];

  const endForStart = useMemo(() => {
    if (!selectedStart) return "";
    const startMs = Date.parse(selectedStart);
    return new Date(startMs + slotDurationMin * 60 * 1000).toISOString();
  }, [selectedStart, slotDurationMin]);

  async function submit() {
    if (!selectedStart || !data) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/public/booking/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          start_datetime: selectedStart,
          end_datetime: endForStart,
          guest_name: guestName,
          guest_note: guestNote,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "No se pudo reservar.");
        return;
      }
      setDone({ html_link: json.html_link as string | undefined });
    } catch {
      setError("Error de red.");
    } finally {
      setSubmitting(false);
    }
  }

  if (!token) {
    return <p className="p-6 text-sm text-neutral-600">Enlace inválido.</p>;
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <p className="text-sm text-neutral-500">Cargando disponibilidad…</p>
      </div>
    );
  }

  if (done) {
    return (
      <div className="mx-auto max-w-md p-8 space-y-4">
        <h1 className="text-lg font-semibold">Reserva confirmada</h1>
        <p className="text-sm text-neutral-600">
          El evento se ha añadido al calendario del anfitrión.
        </p>
        {done.html_link && (
          <a
            href={done.html_link}
            className="text-sm font-medium text-blue-600 underline"
            target="_blank"
            rel="noreferrer"
          >
            Ver en Google Calendar
          </a>
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg p-6 space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Reservar cita</h1>
        <p className="text-sm text-neutral-500 mt-1">
          Horario sugerido 09:00–17:00 (zona del anfitrión:{" "}
          {data?.timezone ?? "…"}).
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          {error}
        </div>
      )}

      <div className="space-y-2">
        <label className="block text-sm font-medium">Hora</label>
        <select
          value={selectedStart ?? ""}
          onChange={(e) => setSelectedStart(e.target.value || null)}
          className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        >
          <option value="">Elige una franja (30 min)</option>
          {slots.map((s) => (
            <option key={s} value={s}>
              {new Date(s).toLocaleString(undefined, {
                weekday: "short",
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </option>
          ))}
        </select>
        {slots.length === 0 && (
          <p className="text-xs text-neutral-400">
            No hay huecos en el rango mostrado. Prueba «Actualizar disponibilidad».
          </p>
        )}
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">Tu nombre</label>
        <input
          type="text"
          value={guestName}
          onChange={(e) => setGuestName(e.target.value)}
          placeholder="Ej. Ana García"
          className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        />
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">Nota (opcional)</label>
        <textarea
          value={guestNote}
          onChange={(e) => setGuestNote(e.target.value)}
          rows={3}
          className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        />
      </div>

      <button
        type="button"
        onClick={() => void submit()}
        disabled={!selectedStart || submitting}
        className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {submitting ? "Reservando…" : "Confirmar reserva"}
      </button>

      <button
        type="button"
        onClick={() => void load()}
        className="text-xs text-neutral-500 underline"
      >
        Actualizar disponibilidad
      </button>
    </div>
  );
}
