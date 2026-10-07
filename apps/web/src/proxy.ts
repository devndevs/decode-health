/**
 * Runs before every page request:
 *   1. Sends visitors without a locale prefix to /en or /es based on Accept-Language.
 *   2. Sets a strict, per-request Content-Security-Policy with a fresh nonce.
 *      Next.js reads the nonce from the request header and applies it to its own scripts.
 */
import { NextResponse, type NextRequest } from "next/server";
import { DEFAULT_LOCALE, LOCALES, type Locale } from "./lib/locales";

function preferredLocale(header: string | null): Locale {
  const ranked = (header ?? "")
    .split(",")
    .map((part) => {
      const [tag, q] = part.trim().split(";q=");
      return { lang: (tag ?? "").toLowerCase().split("-")[0] ?? "", q: q ? Number(q) : 1 };
    })
    .sort((a, b) => b.q - a.q);
  return (ranked.find((r) => (LOCALES as readonly string[]).includes(r.lang))?.lang as Locale) ?? DEFAULT_LOCALE;
}

function csp(nonce: string, https: boolean): string {
  const dev = process.env.NODE_ENV === "development";
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self'${dev ? " 'unsafe-inline'" : ` 'nonce-${nonce}'`}`,
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    https ? "upgrade-insecure-requests" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasLocale = LOCALES.some((l) => pathname === `/${l}` || pathname.startsWith(`/${l}/`));
  if (!hasLocale) {
    const url = request.nextUrl.clone();
    url.pathname = `/${preferredLocale(request.headers.get("accept-language"))}${pathname === "/" ? "" : pathname}`;
    return NextResponse.redirect(url);
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const https = request.nextUrl.protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
  const policy = csp(nonce, https);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", policy);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!api|_next/static|_next/image|favicon.ico|robots.txt|.*\\.[a-z0-9]+$).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
