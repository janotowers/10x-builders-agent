import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const AUTH_GET_USER_ATTEMPTS = 3;
const AUTH_RETRY_BASE_DELAY_MS = 120;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function looksTransientAuthFailure(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" &&
          error &&
          "message" in error &&
          typeof (error as { message: unknown }).message === "string"
        ? (error as { message: string }).message
        : String(error ?? "");
  return /fetch failed|network|timeout|econnreset|enotfound|unreachable|503|502|504/i.test(
    message
  );
}

function requestLikelyHasSessionCookie(request: NextRequest): boolean {
  return request.cookies
    .getAll()
    .some(
      (cookie) =>
        cookie.name.includes("auth-token") ||
        cookie.name.startsWith("sb-") ||
        cookie.name.includes("supabase")
    );
}

async function getUserWithRetry(
  supabase: ReturnType<typeof createServerClient>
): Promise<{
  user: Awaited<ReturnType<typeof supabase.auth.getUser>>["data"]["user"];
  transientFailure: boolean;
}> {
  let transientFailure = false;
  for (let attempt = 0; attempt < AUTH_GET_USER_ATTEMPTS; attempt += 1) {
    try {
      const result = await supabase.auth.getUser();
      if (result.data.user) {
        return { user: result.data.user, transientFailure: false };
      }
      if (result.error && looksTransientAuthFailure(result.error)) {
        transientFailure = true;
        if (attempt < AUTH_GET_USER_ATTEMPTS - 1) {
          await sleep(AUTH_RETRY_BASE_DELAY_MS * (attempt + 1));
          continue;
        }
        return { user: null, transientFailure: true };
      }
      // Sesión realmente ausente/inválida: no reintentar.
      return { user: null, transientFailure: false };
    } catch {
      // Un throw en getUser casi siempre es red/Auth caído, no sesión inválida.
      transientFailure = true;
      if (attempt < AUTH_GET_USER_ATTEMPTS - 1) {
        await sleep(AUTH_RETRY_BASE_DELAY_MS * (attempt + 1));
        continue;
      }
      return { user: null, transientFailure: true };
    }
  }
  return { user: null, transientFailure };
}

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options?: CookieOptions }[]) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // No lanzar en middleware: un throw aquí devolvía HTML 500 a fetch() del chat.
  const { user, transientFailure } = await getUserWithRetry(supabase);

  const { pathname } = request.nextUrl;

  const publicPaths = ["/login", "/signup", "/auth/callback"];
  const isAnonymousOk =
    publicPaths.some((p) => pathname.startsWith(p)) ||
    pathname.startsWith("/book/") ||
    pathname.startsWith("/api/public/") ||
    pathname.startsWith("/api/telegram/webhook") ||
    pathname.startsWith("/api/cron/");

  if (!user && !isAnonymousOk) {
    // API routes must answer with JSON so fetch() callers can handle auth
    // failures cleanly. Redirecting them to the HTML /login page makes
    // res.json() throw "Unexpected token '<'" on the client.
    if (pathname.startsWith("/api/")) {
      if (transientFailure && requestLikelyHasSessionCookie(request)) {
        return NextResponse.json(
          {
            error: "auth_unavailable",
            reason: "auth_unreachable",
            retryable: true,
          },
          { status: 503 }
        );
      }
      return NextResponse.json(
        { error: "unauthorized", reason: "session_expired" },
        { status: 401 }
      );
    }
    // Páginas: si Auth falló de forma transitoria pero hay cookie, no echar
    // al login; deja pasar y el cliente/SSR reintentan.
    if (transientFailure && requestLikelyHasSessionCookie(request)) {
      return supabaseResponse;
    }
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  if (user && (pathname === "/login" || pathname === "/signup")) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}
