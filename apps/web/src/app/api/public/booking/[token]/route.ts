import { NextResponse, type NextRequest } from "next/server";
import {
  createServerClient,
  getCalendarBookingLinkByToken,
  getGoogleCalendarAccessToken,
  getProfile,
} from "@agents/db";
import {
  calendarFreeBusyQuery,
  buildEventResource,
  executeCalendarCreateEvent,
} from "@agents/agent";
import { rateLimit } from "@/lib/public-rate-limit";
import { suggestPublicBookingSlots } from "@/lib/booking-slots";

function clientKey(request: NextRequest, token: string): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const ip = forwarded?.split(",")[0]?.trim() || "unknown";
  return `${token}:${ip}`;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ token: string }> }
) {
  const { token } = await context.params;
  const rl = rateLimit(`booking-get:${clientKey(request, token)}`, 120, 60_000);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Demasiadas solicitudes. Espera un momento." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } }
    );
  }

  const { searchParams } = new URL(request.url);
  const daysRaw = Number(searchParams.get("days") ?? "7");
  const days = Math.min(Math.max(Number.isFinite(daysRaw) ? daysRaw : 7, 1), 14);

  try {
    const db = createServerClient();
    const link = await getCalendarBookingLinkByToken(db, token);
    if (!link) {
      return NextResponse.json({ error: "Enlace no válido." }, { status: 404 });
    }

    const accessToken = await getGoogleCalendarAccessToken(db, link.user_id);
    if (!accessToken) {
      return NextResponse.json(
        { error: "El calendario no está disponible en este momento." },
        { status: 503 }
      );
    }

    const profile = await getProfile(db, link.user_id);
    const timeMin = new Date().toISOString();
    const timeMax = new Date(
      Date.now() + days * 24 * 60 * 60 * 1000
    ).toISOString();

    const { status, data } = await calendarFreeBusyQuery(accessToken, {
      timeMin,
      timeMax,
      items: [{ id: link.calendar_id }],
    });

    if (status >= 400) {
      return NextResponse.json(
        { error: "No se pudo consultar disponibilidad.", details: data },
        { status: 502 }
      );
    }

    const calendars = (data as { calendars?: Record<string, { busy?: unknown }> })
      .calendars ?? {};
    const cal =
      calendars[link.calendar_id] ??
      Object.values(calendars)[0];
    const busy = (cal?.busy as Array<{ start: string; end: string }> | undefined) ?? [];
    const tz = profile.timezone ?? "UTC";
    const slotStarts = suggestPublicBookingSlots(
      timeMin,
      timeMax,
      tz,
      busy,
      days
    );

    return NextResponse.json({
      timezone: tz,
      calendar_id: link.calendar_id,
      time_min: timeMin,
      time_max: timeMax,
      busy,
      slot_starts: slotStarts,
    });
  } catch (e) {
    console.error("public booking GET:", e);
    return NextResponse.json({ error: "Error interno." }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ token: string }> }
) {
  const { token } = await context.params;
  const rl = rateLimit(`booking-post:${clientKey(request, token)}`, 20, 60_000);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Demasiadas reservas desde esta conexión. Prueba más tarde." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } }
    );
  }

  try {
    const body = await request.json();
    const startDatetime = body?.start_datetime;
    const endDatetime = body?.end_datetime;
    if (
      typeof startDatetime !== "string" ||
      typeof endDatetime !== "string"
    ) {
      return NextResponse.json(
        { error: "start_datetime y end_datetime (ISO 8601) son obligatorios." },
        { status: 400 }
      );
    }

    const startMs = Date.parse(startDatetime);
    const endMs = Date.parse(endDatetime);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      return NextResponse.json({ error: "Intervalo de horario no válido." }, { status: 400 });
    }
    const durationMin = (endMs - startMs) / 60000;
    if (durationMin > 240) {
      return NextResponse.json(
        { error: "La reserva no puede superar 4 horas." },
        { status: 400 }
      );
    }

    const db = createServerClient();
    const link = await getCalendarBookingLinkByToken(db, token);
    if (!link) {
      return NextResponse.json({ error: "Enlace no válido." }, { status: 404 });
    }

    const accessToken = await getGoogleCalendarAccessToken(db, link.user_id);
    if (!accessToken) {
      return NextResponse.json(
        { error: "El calendario no está disponible en este momento." },
        { status: 503 }
      );
    }

    const profile = await getProfile(db, link.user_id);
    const tz = profile.timezone ?? "UTC";

    const guestName =
      typeof body?.guest_name === "string" && body.guest_name.trim()
        ? body.guest_name.trim().slice(0, 120)
        : "Invitado";
    const guestNote =
      typeof body?.guest_note === "string"
        ? body.guest_note.trim().slice(0, 2000)
        : "";
    const summary =
      typeof body?.summary === "string" && body.summary.trim()
        ? body.summary.trim().slice(0, 200)
        : `Reserva: ${guestName}`;

    const windowStart = new Date(startMs - 60_000).toISOString();
    const windowEnd = new Date(endMs + 60_000).toISOString();
    const fb = await calendarFreeBusyQuery(accessToken, {
      timeMin: windowStart,
      timeMax: windowEnd,
      items: [{ id: link.calendar_id }],
    });

    if (fb.status >= 400) {
      return NextResponse.json(
        { error: "No se pudo verificar disponibilidad." },
        { status: 502 }
      );
    }

    const calendars = (fb.data as {
      calendars?: Record<string, { busy?: Array<{ start: string; end: string }> }>;
    }).calendars ?? {};
    const calBusy =
      calendars[link.calendar_id]?.busy ??
      Object.values(calendars)[0]?.busy ??
      [];
    const conflicts = calBusy.some((b) => {
      const bs = Date.parse(b.start);
      const be = Date.parse(b.end);
      return Number.isFinite(bs) && Number.isFinite(be) && startMs < be && endMs > bs;
    });
    if (conflicts) {
      return NextResponse.json(
        { error: "Ese horario ya no está libre. Actualiza la página." },
        { status: 409 }
      );
    }

    const descriptionParts = [
      "Reserva desde enlace público.",
      guestNote ? `Nota: ${guestNote}` : "",
    ].filter(Boolean);

    const eventBody = buildEventResource({
      summary,
      start_datetime: startDatetime,
      end_datetime: endDatetime,
      timezone: tz,
      description: descriptionParts.join("\n"),
    });

    const { status, data } = await executeCalendarCreateEvent(
      accessToken,
      link.calendar_id,
      eventBody
    );

    if (status >= 400) {
      return NextResponse.json(
        { error: "No se pudo crear el evento.", details: data },
        { status: 502 }
      );
    }

    const created = data as Record<string, unknown>;
    return NextResponse.json({
      ok: true,
      html_link: created.htmlLink,
      event_id: created.id,
    });
  } catch (e) {
    console.error("public booking POST:", e);
    return NextResponse.json({ error: "Error interno." }, { status: 500 });
  }
}
