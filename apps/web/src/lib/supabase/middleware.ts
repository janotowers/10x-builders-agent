import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

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

  let user: Awaited<
    ReturnType<typeof supabase.auth.getUser>
  >["data"]["user"] = null;
  try {
    const result = await supabase.auth.getUser();
    user = result.data.user;
  } catch {
    // Supabase auth briefly unreachable: treat as unauthenticated below instead
    // of throwing (a thrown middleware would surface an HTML 500 page to fetch()
    // callers and produce confusing JSON parse errors on the client).
    user = null;
  }

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
      return NextResponse.json(
        { error: "unauthorized", reason: "session_expired" },
        { status: 401 }
      );
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
