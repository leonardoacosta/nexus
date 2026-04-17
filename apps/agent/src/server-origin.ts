/**
 * Origin/CORS helpers extracted from server.ts.
 *
 * Encapsulates:
 * - Tailscale origin detection (100.x.x.x)
 * - Disallowed browser origin detection (defense-in-depth 403)
 * - CORS header attachment for Tailscale origins
 */

/** Return true if the origin is a Tailscale IP (100.x.x.x). */
export function isTailscaleOrigin(origin: string | null): boolean {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return /^100\./.test(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Return true if the origin is a well-formed URL that is NOT a Tailscale host.
 *
 * Used for defense-in-depth 403 blocking. A present-but-malformed Origin is
 * treated as if no Origin were sent (proceed via auth gate) — we cannot
 * confidently label a garbage string "non-Tailscale" so we defer to the
 * `x-nexus-secret` check rather than reject.
 */
export function isDisallowedBrowserOrigin(origin: string | null): boolean {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return !/^100\./.test(url.hostname);
  } catch {
    // Malformed Origin — treat as absent (scenario 5 of terminal-attach spec).
    return false;
  }
}

/** Attach CORS headers when the request comes from a Tailscale origin. */
export function withCors(request: Request, response: Response): Response {
  const origin = request.headers.get("origin");
  if (isTailscaleOrigin(origin)) {
    response.headers.set("Access-Control-Allow-Origin", origin!);
    response.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
    response.headers.set("Access-Control-Allow-Headers", "Content-Type, x-nexus-secret");
  }
  return response;
}
