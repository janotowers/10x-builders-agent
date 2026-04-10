import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  createServerClient,
  upsertIntegration,
  encryptToken,
  decryptToken,
  GOOGLE_CALENDAR_PROVIDER,
  GOOGLE_CALENDAR_SCOPES,
  type GoogleOAuthTokenPayload,
} from "@agents/db";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const storedState = request.cookies.get("google_calendar_oauth_state")?.value;

  if (!code || !state || state !== storedState) {
    return NextResponse.redirect(
      new URL("/settings?google_calendar=error&reason=invalid_state", request.url)
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = `${process.env.NEXT_PUBLIC_SITE_URL ?? ""}/api/integrations/google/callback`;

  if (!clientId || !clientSecret) {
    return NextResponse.redirect(
      new URL("/settings?google_calendar=error&reason=not_configured", request.url)
    );
  }

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  const tokenData = (await tokenRes.json()) as Record<string, unknown>;

  if (!tokenRes.ok || typeof tokenData.access_token !== "string") {
    console.error("Google token exchange failed:", tokenData);
    return NextResponse.redirect(
      new URL("/settings?google_calendar=error&reason=token_exchange", request.url)
    );
  }

  const db = createServerClient();

  let previousRefresh: string | undefined;
  const { data: existing } = await supabase
    .from("user_integrations")
    .select("encrypted_tokens")
    .eq("user_id", user.id)
    .eq("provider", GOOGLE_CALENDAR_PROVIDER)
    .maybeSingle();

  if (existing?.encrypted_tokens) {
    try {
      const prev = JSON.parse(
        decryptToken(existing.encrypted_tokens as string)
      ) as GoogleOAuthTokenPayload;
      previousRefresh = prev.refresh_token;
    } catch {
      /* ignore */
    }
  }

  const newRefresh =
    typeof tokenData.refresh_token === "string"
      ? tokenData.refresh_token
      : previousRefresh;

  const expiresIn = Number(tokenData.expires_in ?? 3600);
  const payload: GoogleOAuthTokenPayload = {
    access_token: tokenData.access_token as string,
    refresh_token: newRefresh,
    expires_at: Date.now() + expiresIn * 1000,
  };

  const scopesFromGoogle =
    typeof tokenData.scope === "string"
      ? tokenData.scope.split(" ").filter(Boolean)
      : GOOGLE_CALENDAR_SCOPES;

  const encrypted = encryptToken(JSON.stringify(payload));
  await upsertIntegration(
    db,
    user.id,
    GOOGLE_CALENDAR_PROVIDER,
    scopesFromGoogle.length ? scopesFromGoogle : GOOGLE_CALENDAR_SCOPES,
    encrypted
  );

  const response = NextResponse.redirect(
    new URL("/settings?google_calendar=connected", request.url)
  );

  response.cookies.set("google_calendar_oauth_state", "", {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 0,
    path: "/",
  });

  return response;
}
