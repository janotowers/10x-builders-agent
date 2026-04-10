function shortTimeZoneName(date: Date, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "short",
    }).formatToParts(date);
    const tzPart = parts.find((p) => p.type === "timeZoneName");
    return tzPart?.value ?? "";
  } catch {
    return "";
  }
}

/**
 * Formatea inicio/fin de evento de Google Calendar para mostrar al usuario
 * en la zona horaria del perfil (p. ej. America/Mexico_City).
 */
export function formatGoogleEventBoundary(
  boundary: unknown,
  profileTimeZone: string
): string {
  if (!boundary || typeof boundary !== "object") return "";
  const b = boundary as Record<string, unknown>;

  if (typeof b.date === "string" && b.date.length >= 8) {
    return `${b.date} (todo el día)`;
  }

  const dateTime = b.dateTime;
  if (typeof dateTime !== "string" || !dateTime.trim()) return "";

  const instant = new Date(dateTime);
  if (Number.isNaN(instant.getTime())) return dateTime;

  try {
    const base = new Intl.DateTimeFormat("es-MX", {
      timeZone: profileTimeZone,
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(instant);

    const tzAbbr = shortTimeZoneName(instant, profileTimeZone);
    return tzAbbr ? `${base} (${tzAbbr})` : base;
  } catch {
    return new Intl.DateTimeFormat("es-MX", {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(instant);
  }
}

export function eventDisplayFields(
  event: Record<string, unknown>,
  profileTimeZone: string
): { start_display: string; end_display: string } {
  return {
    start_display: formatGoogleEventBoundary(event.start, profileTimeZone),
    end_display: formatGoogleEventBoundary(event.end, profileTimeZone),
  };
}
