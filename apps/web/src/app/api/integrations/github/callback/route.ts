import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServerClient, upsertIntegration, encryptToken } from "@agents/db";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const storedState = request.cookies.get("github_oauth_state")?.value;

  if (!code || !state || state !== storedState) {
    return NextResponse.redirect(
      new URL("/settings?github=error&reason=invalid_state", request.url)
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  const tokenRes = await fetch(
    "https://github.com/login/oauth/access_token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code,
      }),
    }
  );

  const tokenData = await tokenRes.json();

  if (tokenData.error || !tokenData.access_token) {
    console.error("GitHub token exchange failed:", tokenData);
    return NextResponse.redirect(
      new URL("/settings?github=error&reason=token_exchange", request.url)
    );
  }

  const encrypted = encryptToken(tokenData.access_token);
  const scopes = tokenData.scope
    ? tokenData.scope.split(",")
    : ["repo"];

  const db = createServerClient();
  await upsertIntegration(db, user.id, "github", scopes, encrypted);

  const response = NextResponse.redirect(
    new URL("/settings?github=connected", request.url)
  );

  response.cookies.set("github_oauth_state", "", {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 0,
    path: "/",
  });

  return response;
}
