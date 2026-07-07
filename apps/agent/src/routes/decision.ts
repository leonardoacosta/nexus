/**
 * POST /requests/{id}/decision — Decision passthrough to the mx gateway.
 *
 * The Decide-flow menubar submits a pilot's verdict (approve / reject / edit)
 * for a live request to the mx gateway (cmd/mx-gateway, 127.0.0.1:8799). This
 * handler forwards the JSON request body verbatim to
 * `${MX_GATEWAY_URL}/requests/{id}/decision` via POST and relays the gateway's
 * status + body back to the caller.
 *
 * NOT FAIL-SOFT (the deliberate asymmetry vs /requests + /queue): a swallowed
 * decision is silent pilot-data loss, so failures surface loudly:
 *   - Gateway 2xx/409/5xx → status + body relayed VERBATIM (the client decides
 *     what a 409 "no live verdict / already decided" means).
 *   - Fetch timeout / abort / network error → mapped to 504 (NOT an empty 200).
 *
 * The upstream fetch is bounded by the same 10s timeout as the read routes.
 */

import { logger } from "@nexus/core/node";

/** mx gateway base URL. Loopback on the homelab; override via env for tests. */
const GATEWAY_URL = process.env.MX_GATEWAY_URL ?? "http://127.0.0.1:8799";

/** Bound the upstream fetch so a hung gateway can't stall the decision POST. */
const FETCH_TIMEOUT_MS = 10_000;

/** Extract the `{id}` segment from `/requests/{id}/decision`. */
function parseRequestId(pathname: string): string | null {
  const match = pathname.match(/^\/requests\/([^/]+)\/decision$/);
  return match ? decodeURIComponent(match[1]!) : null;
}

export async function handlePostDecision(request: Request): Promise<Response> {
  const incoming = new URL(request.url);
  const id = parseRequestId(incoming.pathname);
  if (id === null) {
    return new Response(JSON.stringify({ error: "malformed decision path" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Read the client body once, forward it verbatim to the gateway.
  const body = await request.text();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const upstreamUrl = new URL(
      `${GATEWAY_URL}/requests/${encodeURIComponent(id)}/decision`,
    );

    const upstream = await fetch(upstreamUrl, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body,
    });

    // Relay the gateway status + body VERBATIM — 2xx, 409, and 5xx alike.
    // Re-emit as a fresh Response so we control the Content-Type + drop
    // hop-by-hop headers, but preserve the upstream status code.
    const upstreamBody = await upstream.text();
    if (!upstream.ok) {
      logger.warn(
        { route: "/requests/:id/decision", id, upstreamStatus: upstream.status },
        "mx gateway returned non-2xx for decision — relaying status verbatim",
      );
    }
    return new Response(upstreamBody, {
      status: upstream.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    // Timeout / abort / network error — map to 504. NEVER an empty 200: a
    // dropped decision must be visibly unacknowledged so the caller retries.
    logger.warn(
      { route: "/requests/:id/decision", id, err },
      "mx gateway unreachable for decision — returning 504",
    );
    return new Response(
      JSON.stringify({ error: "decision gateway unreachable" }),
      { status: 504, headers: { "Content-Type": "application/json" } },
    );
  } finally {
    clearTimeout(timer);
  }
}
