import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServerClient, revokeIntegration, GOOGLE_CALENDAR_PROVIDER } from "@agents/db";

export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = createServerClient();
  await revokeIntegration(db, user.id, GOOGLE_CALENDAR_PROVIDER);

  return NextResponse.json({ ok: true });
}
