import { NextResponse } from "next/server";
import {
  createServerClient,
  getInternalUserNotification,
} from "@agents/db";
import { createClient } from "@/lib/supabase/server";

/**
 * Descarga autenticada del .txt de descripción comercial (paridad con
 * sendDocument de Telegram en listing_description_review).
 */
export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const notificationId = new URL(request.url).searchParams
    .get("notification_id")
    ?.trim();
  if (!notificationId) {
    return NextResponse.json(
      { error: "notification_id is required" },
      { status: 400 }
    );
  }

  const notification = await getInternalUserNotification(
    createServerClient(),
    notificationId
  );
  if (!notification || notification.user_id !== user.id) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (notification.kind !== "listing_description_review") {
    return NextResponse.json({ error: "wrong_kind" }, { status: 400 });
  }

  const metadata =
    notification.metadata_jsonb &&
    typeof notification.metadata_jsonb === "object" &&
    !Array.isArray(notification.metadata_jsonb)
      ? (notification.metadata_jsonb as Record<string, unknown>)
      : {};
  const content =
    typeof metadata.listing_description_txt === "string"
      ? metadata.listing_description_txt
      : "";
  if (!content.trim()) {
    return NextResponse.json({ error: "missing_description" }, { status: 404 });
  }
  const fileName =
    (typeof metadata.listing_description_txt_filename === "string" &&
      metadata.listing_description_txt_filename.trim()) ||
    "descripcion_comercial.txt";

  return new NextResponse(content, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${fileName.replace(/"/g, "")}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
