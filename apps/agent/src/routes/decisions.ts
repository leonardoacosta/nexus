/**
 * GET /decisions — Decision-feed passthrough to the mx gateway.
 *
 * The decision feed exposes recently-decided requests for a source from the mx
 * gateway (cmd/mx-gateway, 127.0.0.1:8799). This handler is a thin passthrough
 * mirroring `/queue` (see queue.ts): it forwards the `since` + `action` query
 * params to `${MX_GATEWAY_URL}/decisions` and returns the gateway body verbatim.
 *
 * FAIL-SOFT (mirrors /queue): if the gateway is down / unreachable / slow /
 * non-200, it returns an empty JSON array `[]` with status 200 so consumers
 * show a graceful empty state rather than crashing or spinning forever. NOTE:
 * mx /decisions returns a bare ARRAY (not `{ items: [] }`), so the fail-soft
 * empty is `[]`.
 */

import { logger } from "@nexus/core/node";

/** mx gateway base URL. Loopback on the homelab; override via env for tests. */
const GATEWAY_URL = process.env.MX_GATEWAY_URL ?? "http://127.0.0.1:8799";

/** Bound the upstream fetch so a hung gateway can't stall the poll. */
const FETCH_TIMEOUT_MS = 10_000;

/** The fail-soft empty payload — a bare JSON array (mx /decisions is an array). */
const EMPTY_DECISIONS = "[]";

/** Query params forwarded verbatim to the gateway. */
const FORWARDED_PARAMS = ["since", "action"] as const;

function emptyResponse(): Response {
  return new Response(EMPTY_DECISIONS, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

export async function handleGetDecisions(request: Request): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    // Forward the allowed query params to the gateway, dropping anything else.
    // URL construction lives inside the try so a malformed MX_GATEWAY_URL
    // fail-softs to the empty payload rather than throwing past the catch.
    const incoming = new URL(request.url);
    const upstreamUrl = new URL(`${GATEWAY_URL}/decisions`);
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
        { route: "/decisions", upstreamStatus: upstream.status },
        "mx gateway returned non-200 — serving empty decision feed",
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
      { route: "/decisions", err },
      "mx gateway unreachable — serving empty decision feed",
    );
    return emptyResponse();
  } finally {
    clearTimeout(timer);
  }
}
