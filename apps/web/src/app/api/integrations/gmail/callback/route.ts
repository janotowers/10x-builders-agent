import { NextResponse, type NextRequest } from "next/server";

export async function GET(request: NextRequest) {
  const sourceUrl = new URL(request.url);
  const targetUrl = new URL("/api/integrations/google/callback", request.url);
  targetUrl.search = sourceUrl.search;

  const response = NextResponse.redirect(targetUrl);
  response.cookies.set("google_gmail_oauth_redirect_uri", "gmail", {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 600,
    path: "/",
    secure: process.env.NODE_ENV === "production",
  });
  return response;
}
