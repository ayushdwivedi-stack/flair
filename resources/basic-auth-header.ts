/**
 * The Basic `Authorization` header grammar the auth middleware accepts
 * (flair#2764), in one place so the CLI's copy in src/lib/auth-resolve.ts can
 * be tested against it. Scheme names are case-insensitive (RFC 9110), and the
 * scheme is followed by exactly one space; the rest is base64.
 */
export const BASIC_AUTH_HEADER_RE = /^Basic /i;

/** The user and password a Basic header carries, or null for any other header. */
export function parseBasicAuthHeader(header: string): { user: string; pass: string } | null {
  if (!BASIC_AUTH_HEADER_RE.test(header)) return null;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf-8");
  const colonIdx = decoded.indexOf(":");
  return {
    user: colonIdx >= 0 ? decoded.slice(0, colonIdx) : decoded,
    pass: colonIdx >= 0 ? decoded.slice(colonIdx + 1) : "",
  };
}
