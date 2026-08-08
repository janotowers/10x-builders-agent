import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  createServerClient,
  upsertIntegration,
  encryptToken,
  decryptToken,
  GOOGLE_CALENDAR_PROVIDER,
  GOOGLE_CALENDAR_SCOPES,
  GOOGLE_GMAIL_PROVIDER,
  GOOGLE_GMAIL_SCOPES,
} from "@agents/db";

type Flow = "google_calendar" | "gmail";
type TokenPayload = {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
};

const FLOW_CONFIG: Record<
  Flow,
  {
    stateCookie: string;
    provider: typeof GOOGLE_CALENDAR_PROVIDER | typeof GOOGLE_GMAIL_PROVIDER;
    scopes: string[];
    statusParam: "google_calendar" | "gmail";
  }
> = {
  google_calendar: {
    stateCookie: "google_calendar_oauth_state",
    provider: GOOGLE_CALENDAR_PROVIDER,
    scopes: GOOGLE_CALENDAR_SCOPES,
    statusParam: "google_calendar",
  },
  gmail: {
    stateCookie: "google_gmail_oauth_state",
    provider: GOOGLE_GMAIL_PROVIDER,
    scopes: GOOGLE_GMAIL_SCOPES,
    statusParam: "gmail",
  },
};

function inferFlowFromCookies(request: NextRequest): Flow {
  const lastFlowCookie = request.cookies.get("google_oauth_last_flow")?.value;
  if (lastFlowCookie === "gmail") return "gmail";
  if (lastFlowCookie === "google_calendar") return "google_calendar";
  const hasGmailCookie = Boolean(
    request.cookies.get(FLOW_CONFIG.gmail.stateCookie)?.value
  );
  return hasGmailCookie ? "gmail" : "google_calendar";
}

function findFlowByState(request: NextRequest, state: string): Flow | null {
  for (const flow of Object.keys(FLOW_CONFIG) as Flow[]) {
    const cookieValue = request.cookies.get(FLOW_CONFIG[flow].stateCookie)?.value;
    if (cookieValue && cookieValue === state) return flow;
  }
  return null;
}

function getTokenExchangeRedirectUri(request: NextRequest, flow: Flow): string {
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "";
  if (flow !== "gmail") {
    return `${siteUrl}/api/integrations/google/callback`;
  }
  const gmailRedirectMode =
    request.cookies.get("google_gmail_oauth_redirect_uri")?.value ?? "google";
  return gmailRedirectMode === "gmail"
    ? `${siteUrl}/api/integrations/gmail/callback`
    : `${siteUrl}/api/integrations/google/callback`;
}

function gmailReturnUrl(request: NextRequest): URL | null {
  const raw = request.cookies.get("google_gmail_oauth_return_to")?.value;
  if (!raw?.startsWith("/operations/workflows/design")) return null;
  const url = new URL(raw, request.url);
  url.searchParams.set("gmail", "connected");
  return url;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const fallbackFlow = inferFlowFromCookies(request);
  const fallbackStatusParam = FLOW_CONFIG[fallbackFlow].statusParam;

  if (!code || !state) {
    return NextResponse.redirect(
      new URL(
        `/settings?${fallbackStatusParam}=error&reason=invalid_state`,
        request.url
      )
    );
  }
  const flow = findFlowByState(request, state);
  if (!flow) {
    return NextResponse.redirect(
      new URL(
        `/settings?${fallbackStatusParam}=error&reason=invalid_state`,
        request.url
      )
    );
  }
  const flowConfig = FLOW_CONFIG[flow];

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = getTokenExchangeRedirectUri(request, flow);

  if (!clientId || !clientSecret) {
    return NextResponse.redirect(
      new URL(
        `/settings?${flowConfig.statusParam}=error&reason=not_configured`,
        request.url
      )
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
    console.error(`Google ${flow} token exchange failed:`, tokenData);
    return NextResponse.redirect(
      new URL(
        `/settings?${flowConfig.statusParam}=error&reason=token_exchange`,
        request.url
      )
    );
  }

  const db = createServerClient();

  let previousRefresh: string | undefined;
  const { data: existing } = await supabase
    .from("user_integrations")
    .select("encrypted_tokens")
    .eq("user_id", user.id)
    .eq("provider", flowConfig.provider)
    .maybeSingle();

  if (existing?.encrypted_tokens) {
    try {
      const prev = JSON.parse(
        decryptToken(existing.encrypted_tokens as string)
      ) as TokenPayload;
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
  const payload: TokenPayload = {
    access_token: tokenData.access_token as string,
    refresh_token: newRefresh,
    expires_at: Date.now() + expiresIn * 1000,
  };

  const scopesFromGoogle =
    typeof tokenData.scope === "string"
      ? tokenData.scope.split(" ").filter(Boolean)
      : flowConfig.scopes;

  const encrypted = encryptToken(JSON.stringify(payload));
  await upsertIntegration(
    db,
    user.id,
    flowConfig.provider,
    scopesFromGoogle.length ? scopesFromGoogle : flowConfig.scopes,
    encrypted
  );

  const response = NextResponse.redirect(
    flow === "gmail"
      ? gmailReturnUrl(request) ??
          new URL(`/settings?${flowConfig.statusParam}=connected`, request.url)
      : new URL(`/settings?${flowConfig.statusParam}=connected`, request.url)
  );

  response.cookies.set(flowConfig.stateCookie, "", {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 0,
    path: "/",
  });
  if (flow === "gmail") {
    response.cookies.set("google_gmail_oauth_redirect_uri", "", {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 0,
      path: "/",
    });
    response.cookies.set("google_gmail_oauth_return_to", "", {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 0,
      path: "/",
    });
  }
  response.cookies.set("google_oauth_last_flow", "", {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 0,
    path: "/",
  });

  return response;
}
