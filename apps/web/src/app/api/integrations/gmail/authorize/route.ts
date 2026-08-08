import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { randomBytes } from "crypto";
import { GOOGLE_GMAIL_SCOPES } from "@agents/db";

function safeStudioReturnTo(value: string | null): string | null {
  if (!value) return null;
  return value.startsWith("/operations/workflows/design") ? value : null;
}

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json(
      { error: "Google OAuth not configured" },
      { status: 500 }
    );
  }

  const state = randomBytes(20).toString("hex");
  const redirectUri = `${
    process.env.NEXT_PUBLIC_SITE_URL ?? ""
  }/api/integrations/google/callback`;

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_GMAIL_SCOPES.join(" "),
    state,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
  });

  const response = NextResponse.redirect(
    `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
  );

  response.cookies.set("google_gmail_oauth_state", state, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 600,
    path: "/",
    secure: process.env.NODE_ENV === "production",
  });
  response.cookies.set("google_gmail_oauth_redirect_uri", "google", {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 600,
    path: "/",
    secure: process.env.NODE_ENV === "production",
  });
  response.cookies.set("google_oauth_last_flow", "gmail", {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 600,
    path: "/",
    secure: process.env.NODE_ENV === "production",
  });
  const returnTo = safeStudioReturnTo(
    new URL(request.url).searchParams.get("return_to")
  );
  if (returnTo) {
    response.cookies.set("google_gmail_oauth_return_to", returnTo, {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 600,
      path: "/",
      secure: process.env.NODE_ENV === "production",
    });
  }

  return response;
}
