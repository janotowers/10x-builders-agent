"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserClient } from "@supabase/ssr";

interface Props {
  userId: string;
  profile: Record<string, unknown> | null;
  toolSettings: Array<{ tool_id: string; enabled: boolean }>;
  telegramLinked: boolean;
  githubConnected: boolean;
  googleCalendarConnected: boolean;
  /** Query `google_calendar` tras OAuth (connected | error). */
  googleOAuthStatus?: string;
  googleOAuthReason?: string;
}

const TIMEZONES = [
  "America/Mexico_City",
  "America/Bogota",
  "America/Lima",
  "America/Santiago",
  "America/Buenos_Aires",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Europe/Madrid",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "UTC",
];

const TOOL_IDS = [
  "get_user_preferences",
  "list_enabled_tools",
  "github_list_repos",
  "github_list_issues",
  "github_create_repo",
  "github_create_issue",
  "calendar_list_calendars",
  "calendar_list_events",
  "calendar_create_event",
  "calendar_update_event",
  "calendar_delete_event",
  "bash",
];

export function SettingsForm({
  userId,
  profile,
  toolSettings,
  telegramLinked,
  githubConnected,
  googleCalendarConnected,
  googleOAuthStatus,
  googleOAuthReason,
}: Props) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const [name, setName] = useState((profile?.name as string) ?? "");
  const browserTz = typeof window !== "undefined"
    ? Intl.DateTimeFormat().resolvedOptions().timeZone
    : "UTC";
  const profileTz = (profile?.timezone as string) || "";
  const [timezone, setTimezone] = useState(profileTz || browserTz);
  const [agentName, setAgentName] = useState((profile?.agent_name as string) ?? "Agente");
  const [systemPrompt, setSystemPrompt] = useState(
    (profile?.agent_system_prompt as string) ?? ""
  );
  const [enabledTools, setEnabledTools] = useState<string[]>(
    toolSettings.filter((t) => t.enabled).map((t) => t.tool_id)
  );
  const [linkCode, setLinkCode] = useState<string | null>(null);
  const [ghConnected, setGhConnected] = useState(githubConnected);
  const [gCalConnected, setGCalConnected] = useState(googleCalendarConnected);
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectingGCal, setDisconnectingGCal] = useState(false);
  const [bookingBusy, setBookingBusy] = useState(false);
  const [bookingUrl, setBookingUrl] = useState<string | null>(null);

  const supabase = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  useEffect(() => {
    setGCalConnected(googleCalendarConnected);
  }, [googleCalendarConnected]);

  function toggleTool(id: string) {
    setEnabledTools((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]
    );
  }

  async function handleSave() {
    setSaving(true);

    await supabase.from("profiles").update({
      name,
      timezone,
      agent_name: agentName,
      agent_system_prompt: systemPrompt.slice(0, 500),
      updated_at: new Date().toISOString(),
    }).eq("id", userId);

    for (const toolId of TOOL_IDS) {
      await supabase.from("user_tool_settings").upsert(
        {
          user_id: userId,
          tool_id: toolId,
          enabled: enabledTools.includes(toolId),
          config_json: {},
        },
        { onConflict: "user_id,tool_id" }
      );
    }

    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    router.refresh();
  }

  async function disconnectGoogleCalendar() {
    setDisconnectingGCal(true);
    try {
      await fetch("/api/integrations/google/disconnect", { method: "POST" });
      setGCalConnected(false);
      setBookingUrl(null);
      router.refresh();
    } finally {
      setDisconnectingGCal(false);
    }
  }

  async function createPublicBookingLink() {
    setBookingBusy(true);
    setBookingUrl(null);
    try {
      const res = await fetch("/api/calendar/booking-link", { method: "POST" });
      const json = await res.json();
      if (!res.ok) {
        console.error(json);
        return;
      }
      setBookingUrl(json.book_url as string);
    } finally {
      setBookingBusy(false);
    }
  }

  async function disconnectGitHub() {
    setDisconnecting(true);
    try {
      await fetch("/api/integrations/github/disconnect", { method: "POST" });
      setGhConnected(false);
      router.refresh();
    } finally {
      setDisconnecting(false);
    }
  }

  async function generateTelegramCode() {
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    await supabase.from("telegram_link_codes").insert({
      user_id: userId,
      code,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });
    setLinkCode(code);
  }

  return (
    <div className="space-y-8">
      {googleOAuthStatus === "connected" && (
        <div className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800 dark:border-green-900 dark:bg-green-950/30 dark:text-green-200">
          Google Calendar se conectó correctamente. Si no ves el estado abajo, recarga la página (F5).
        </div>
      )}
      {googleOAuthStatus === "error" && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          No se pudo completar la conexión con Google
          {googleOAuthReason ? ` (${googleOAuthReason})` : ""}. Revisa{" "}
          <code className="text-xs">GOOGLE_CLIENT_*</code>,{" "}
          <code className="text-xs">NEXT_PUBLIC_SITE_URL</code> y el redirect en Google Cloud.
        </div>
      )}
      {/* Profile */}
      <section className="space-y-4">
        <h2 className="text-base font-semibold">Perfil</h2>
        <div>
          <label className="block text-sm font-medium mb-1">Nombre</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Zona horaria</label>
          <select
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          >
            {TIMEZONES.map((tz) => (
              <option key={tz} value={tz}>
                {tz.replace(/_/g, " ")}
              </option>
            ))}
            {!TIMEZONES.includes(timezone) && (
              <option value={timezone}>{timezone.replace(/_/g, " ")}</option>
            )}
          </select>
          <p className="text-xs text-neutral-400 mt-1">
            Afecta las horas que ves en eventos de calendario y la interpretación de períodos.
          </p>
        </div>
      </section>

      {/* Agent */}
      <section className="space-y-4">
        <h2 className="text-base font-semibold">Agente</h2>
        <div>
          <label className="block text-sm font-medium mb-1">Nombre del agente</label>
          <input
            type="text"
            value={agentName}
            onChange={(e) => setAgentName(e.target.value)}
            maxLength={50}
            className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Instrucciones</label>
          <textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value.slice(0, 500))}
            rows={4}
            maxLength={500}
            className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
          <p className="text-xs text-neutral-400 text-right mt-1">{systemPrompt.length}/500</p>
        </div>
      </section>

      {/* Tools */}
      <section className="space-y-4">
        <h2 className="text-base font-semibold">Herramientas</h2>
        <div className="space-y-2">
          {TOOL_IDS.map((id) => (
            <label key={id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={enabledTools.includes(id)}
                onChange={() => toggleTool(id)}
                className="rounded border-neutral-300"
              />
              {id}
            </label>
          ))}
        </div>
      </section>

      {/* Google Calendar */}
      <section className="space-y-4">
        <h2 className="text-base font-semibold">Google Calendar</h2>
        {gCalConnected ? (
          <div className="space-y-3">
            <p className="text-sm text-green-600">Calendario de Google conectado.</p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void createPublicBookingLink()}
                disabled={bookingBusy}
                className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
              >
                {bookingBusy ? "Generando…" : "Generar enlace de reserva pública"}
              </button>
              <button
                type="button"
                onClick={() => void disconnectGoogleCalendar()}
                disabled={disconnectingGCal}
                className="rounded-md border border-red-300 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950"
              >
                {disconnectingGCal ? "Desconectando…" : "Desconectar Google"}
              </button>
            </div>
            {bookingUrl && (
              <p className="text-xs text-neutral-600 break-all">
                Enlace (comparte por tu canal seguro):{" "}
                <a href={bookingUrl} className="text-blue-600 underline" target="_blank" rel="noreferrer">
                  {bookingUrl}
                </a>
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-neutral-500">
              Conecta Google Calendar para que el agente consulte eventos y cree citas (con tu confirmación).
              La reserva para terceros usa este calendario vía la app; el invitado no inicia sesión en Google.
            </p>
            <a
              href="/api/integrations/google/authorize"
              className="inline-block rounded-md bg-neutral-800 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-200 dark:text-neutral-900 dark:hover:bg-neutral-300"
            >
              Conectar Google Calendar
            </a>
          </div>
        )}
      </section>

      {/* GitHub */}
      <section className="space-y-4">
        <h2 className="text-base font-semibold">GitHub</h2>
        {ghConnected ? (
          <div className="space-y-2">
            <p className="text-sm text-green-600">Cuenta de GitHub conectada.</p>
            <button
              onClick={disconnectGitHub}
              disabled={disconnecting}
              className="rounded-md border border-red-300 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950"
            >
              {disconnecting ? "Desconectando..." : "Desconectar GitHub"}
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-neutral-500">
              Conecta tu cuenta de GitHub para que el agente pueda trabajar con tus repositorios e issues.
            </p>
            <a
              href="/api/integrations/github/authorize"
              className="inline-block rounded-md bg-neutral-800 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-200 dark:text-neutral-900 dark:hover:bg-neutral-300"
            >
              Conectar con GitHub
            </a>
          </div>
        )}
      </section>

      {/* Telegram */}
      <section className="space-y-4">
        <h2 className="text-base font-semibold">Telegram</h2>
        {telegramLinked ? (
          <p className="text-sm text-green-600">Cuenta de Telegram vinculada.</p>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-neutral-500">
              Vincula tu cuenta de Telegram para usar el agente desde allí.
            </p>
            {linkCode ? (
              <div className="rounded-md bg-neutral-50 p-4 dark:bg-neutral-900">
                <p className="text-sm">
                  Envía este código al bot en Telegram:{" "}
                  <code className="rounded bg-blue-100 px-2 py-0.5 text-sm font-mono font-bold text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
                    /link {linkCode}
                  </code>
                </p>
                <p className="text-xs text-neutral-400 mt-1">Expira en 10 minutos.</p>
              </div>
            ) : (
              <button
                onClick={generateTelegramCode}
                className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
              >
                Generar código de vinculación
              </button>
            )}
          </div>
        )}
      </section>

      {/* Save */}
      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={saving}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {saving ? "Guardando..." : "Guardar cambios"}
        </button>
        {saved && (
          <span className="text-sm text-green-600">Guardado correctamente.</span>
        )}
      </div>
    </div>
  );
}
