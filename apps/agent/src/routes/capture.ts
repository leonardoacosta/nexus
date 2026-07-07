/**
 * POST /capture — Capture passthrough to the mx gateway.
 *
 * The pilot capture surface is a share-sheet Apple Shortcut (see
 * docs/capture-shortcut.md) that posts a captured thought — `{title, url?}` —
 * to nexus-agent over Tailscale. This handler forwards the JSON request body
 * verbatim to `${MX_GATEWAY_URL}/capture` via POST and relays the gateway's
 * status + body back to the caller.
 *
 * NOT FAIL-SOFT (the deliberate asymmetry vs the read routes, same posture as
 * /requests/:id/decision): a swallowed capture is silent data loss, and a
 * capture that silently vanishes is worse than one that visibly fails — the
 * Shortcut shows the error and the thought stays in hand. Failures surface
 * loudly:
 *   - Gateway 2xx/4xx/5xx → status + body relayed VERBATIM (the Shortcut
 *     surfaces the created id on success, the error on failure).
 *   - Fetch timeout / abort / network error → mapped to 504 (NEVER a
 *     fabricated success). The Shortcut retry is a re-tap.
 *
 * The upstream fetch is bounded by the same 10s timeout as the read routes.
 *
 * Auth: this handler carries no per-request gate of its own — it is dispatched
 * from `createRequestHandler` AFTER the origin defense-in-depth block, so a
 * disallowed browser origin is rejected with 403 before it ever reaches here,
 * and bind-layer reach (loopback + Tailscale) is the transport-level gate. No
 * new auth mechanism is introduced (drop-attach-secret-gate removed the legacy
 * `x-nexus-secret` header).
 */

import { logger } from "@nexus/core/node";

/** mx gateway base URL. Loopback on the homelab; override via env for tests. */
const GATEWAY_URL = process.env.MX_GATEWAY_URL ?? "http://127.0.0.1:8799";

/** Bound the upstream fetch so a hung gateway can't stall the capture POST. */
const FETCH_TIMEOUT_MS = 10_000;

export async function handlePostCapture(request: Request): Promise<Response> {
  // Read the client body once, forward it verbatim to the gateway.
  const body = await request.text();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const upstreamUrl = new URL(`${GATEWAY_URL}/capture`);

    const upstream = await fetch(upstreamUrl, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body,
    });

    // Relay the gateway status + body VERBATIM — 2xx, 4xx, and 5xx alike.
    // Re-emit as a fresh Response so we control the Content-Type + drop
    // hop-by-hop headers, but preserve the upstream status code.
    const upstreamBody = await upstream.text();
    if (!upstream.ok) {
      logger.warn(
        { route: "/capture", upstreamStatus: upstream.status },
        "mx gateway returned non-2xx for capture — relaying status verbatim",
      );
    }
    return new Response(upstreamBody, {
      status: upstream.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    // Timeout / abort / network error — map to 504. NEVER a fabricated 200: a
    // dropped capture must be visibly unacknowledged so the Shortcut retries.
    logger.warn(
      { route: "/capture", err },
      "mx gateway unreachable for capture — returning 504",
    );
    return new Response(
      JSON.stringify({ error: "capture gateway unreachable" }),
      { status: 504, headers: { "Content-Type": "application/json" } },
    );
  } finally {
    clearTimeout(timer);
  }
}
