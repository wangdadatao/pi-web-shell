import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

// @project-doc docs/operations/security.md#origin_check
/**
 * Browser-facing checks for every `/api` request.
 *
 * The token stops a page that does not know it. Origin and Sec-Fetch-Site
 * stop a page that somehow learned it from still being able to call us as a
 * cross-site form or image. Neither check is skipped when the bind address
 * is not loopback.
 */

/** Lower-cased header name, as Node exposes it on `IncomingMessage`. */
export const TOKEN_HEADER = "x-pi-shell-token";

/**
 * Inline scripts are disallowed. Inline styles stay: Mermaid's SVG uses them,
 * and the script decision for diagrams is still open.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self' data: blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");

export function headerValue(value: string | string[] | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  return value;
}

export function isJsonContentType(value: string | undefined): boolean {
  if (!value) return false;
  const mime = value.split(";", 1)[0]?.trim().toLowerCase();
  return mime === "application/json";
}

export function isWriteMethod(method: string | undefined): boolean {
  const name = (method ?? "GET").toUpperCase();
  return name === "POST" || name === "PUT" || name === "PATCH" || name === "DELETE";
}

/**
 * EventSource and `<img>` cannot set headers. Those GETs may carry the token
 * in the query string. Writes may not: an HTML form can set a query string
 * but cannot set a custom header.
 */
export function queryTokenAllowed(method: string | undefined, pathname: string): boolean {
  const name = (method ?? "GET").toUpperCase();
  if (name !== "GET" && name !== "HEAD") return false;
  return (
    pathname === "/api/stream" ||
    pathname === "/api/events" ||
    pathname === "/api/local-image" ||
    pathname.startsWith("/api/image/")
  );
}

export function isOriginAllowed(headers: IncomingHttpHeaders, hostHeader: string | undefined): boolean {
  if (!hostHeader || !hostHeader.trim()) return false;
  const site = headerValue(headers["sec-fetch-site"])?.trim().toLowerCase();
  // `same-site` is still a different origin (another port on 127.0.0.1).
  // Anything other than the page itself or a user-typed navigation is rejected.
  if (site !== undefined && site !== "same-origin" && site !== "none") return false;

  const origin = headerValue(headers.origin)?.trim();
  if (!origin) return true;
  if (origin.toLowerCase() === "null") return false;
  return origin.toLowerCase() === `http://${hostHeader.trim().toLowerCase()}`;
}

export function presentedToken(
  headers: IncomingHttpHeaders,
  url: URL,
  allowQuery: boolean,
): string | null {
  if (headers[TOKEN_HEADER] !== undefined) {
    return headerValue(headers[TOKEN_HEADER]) ?? null;
  }
  if (!allowQuery) return null;
  const token = url.searchParams.get("token");
  return token ? token : null;
}

export function tokenMatches(presented: string | null, expected: string): boolean {
  if (!presented || !expected) return false;
  const actual = createHash("sha256").update(presented).digest();
  const want = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actual, want);
}
