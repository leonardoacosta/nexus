/**
 * GET /queue — Decision-queue passthrough to the mx gateway.
 *
 * The Decide-flow menubar reads the pending-decision queue for a source from
 * the mx gateway (cmd/mx-gateway, 127.0.0.1:8799). This handler is a thin
 * passthrough mirroring `/requests` (see requests.ts): it forwards the `limit`
 * query param to `${MX_GATEWAY_URL}/queue` and returns the gateway body
 * verbatim.
 *
 * FAIL-SOFT (mirrors /requests): if the gateway is down / unreachable / slow /
 * non-200, it returns an empty `{ items: [] }` with status 200 so the menubar
 * shows a graceful empty state ("Nothing to decide") rather than crashing or
 * spinning forever.
 */

import { logger } from "@nexus/core/node";

/** mx gateway base URL. Loopback on the homelab; override via env for tests. */
const GATEWAY_URL = process.env.MX_GATEWAY_URL ?? "http://127.0.0.1:8799";

/** Bound the upstream fetch so a hung gateway can't stall the poll. */
const FETCH_TIMEOUT_MS = 10_000;

/** The fail-soft empty payload. */
const EMPTY_QUEUE = JSON.stringify({ items: [] });

/** Query params forwarded verbatim to the gateway. */
const FORWARDED_PARAMS = ["limit"] as const;

function emptyResponse(): Response {
  return new Response(EMPTY_QUEUE, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

export async function handleGetQueue(request: Request): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    // Forward the allowed query params to the gateway, dropping anything else.
    // URL construction lives inside the try so a malformed MX_GATEWAY_URL
    // fail-softs to the empty payload rather than throwing past the catch.
    const incoming = new URL(request.url);
    const upstreamUrl = new URL(`${GATEWAY_URL}/queue`);
    for (const key of FORWARDED_PARAMS) {
      const value = incoming.searchParams.get(key);
      if (value !== null) upstreamUrl.searchParams.set(key, value);
    }

    const upstream = await fetch(upstreamUrl, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });

    if (!upstream.ok) {
      logger.warn(
        { route: "/queue", upstreamStatus: upstream.status },
        "mx gateway returned non-200 — serving empty decision queue",
      );
      return emptyResponse();
    }

    // Passthrough: return the gateway body verbatim. Re-emit as a fresh
    // Response so we control the Content-Type + drop hop-by-hop headers.
    const body = await upstream.text();
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    logger.warn(
      { route: "/queue", err },
      "mx gateway unreachable — serving empty decision queue",
    );
    return emptyResponse();
  } finally {
    clearTimeout(timer);
  }
}
