import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  createServerClient,
  createCalendarBookingLink,
  GOOGLE_CALENDAR_PROVIDER,
} from "@agents/db";

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { data: calIntegration } = await supabase
      .from("user_integrations")
      .select("id")
      .eq("user_id", user.id)
      .eq("provider", GOOGLE_CALENDAR_PROVIDER)
      .eq("status", "active")
      .maybeSingle();

    if (!calIntegration) {
      return NextResponse.json(
        { error: "Conecta Google Calendar en Ajustes antes de crear un enlace." },
        { status: 400 }
      );
    }

    let calendarId = "primary";
    try {
      const body = await request.json();
      if (body?.calendar_id && typeof body.calendar_id === "string") {
        calendarId = body.calendar_id;
      }
    } catch {
      /* no body */
    }

    const db = createServerClient();
    const row = await createCalendarBookingLink(db, user.id, calendarId);
    const base = process.env.NEXT_PUBLIC_SITE_URL ?? "";
    const path = `/book/${row.token}`;
    const bookUrl = base ? `${base.replace(/\/$/, "")}${path}` : path;

    return NextResponse.json({
      token: row.token,
      calendar_id: row.calendar_id,
      book_url: bookUrl,
    });
  } catch (e) {
    console.error("booking-link error:", e);
    const err = e as { code?: string; message?: string };
    const missingTable =
      err?.code === "PGRST205" ||
      (typeof err?.message === "string" &&
        err.message.includes("calendar_booking_links"));
    if (missingTable) {
      return NextResponse.json(
        {
          error:
            "Falta la tabla calendar_booking_links en Supabase. En el SQL Editor ejecuta el script packages/db/supabase/migrations/00002_calendar_booking_links.sql (ver README, Paso 3).",
        },
        { status: 503 }
      );
    }
    return NextResponse.json(
      { error: "No se pudo crear el enlace." },
      { status: 500 }
    );
  }
}
