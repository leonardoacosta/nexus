/**
 * GET /sources — Source Index passthrough to the mx gateway.
 *
 * The Swift Source Index view (mx-bzzb) polls `GET {agent}/sources` every 30s
 * and decodes a `SourceIndex { sources: SourceStatus[], inbox: BallInCourtItem[] }`
 * (NexusShared/Models/SourceStatus.swift). The live data is produced by the mx
 * gateway (cmd/mx-gateway, 127.0.0.1:8799), which fans out over the whole mx
 * source mesh and renders the exact snake_case wire shape the Swift model decodes.
 *
 * This handler is a thin passthrough: it fetches the gateway JSON and returns it
 * verbatim. FAIL-SOFT (mx-dn7t): if the gateway is down / unreachable / slow, it
 * returns an empty `{ sources: [], inbox: [] }` with status 200 so the app shows
 * the graceful empty state ("No sources reporting yet") rather than an error.
 */

import { logger } from "@nexus/core/node";

/** mx gateway base URL. Loopback on the homelab; override via env for tests. */
const GATEWAY_URL = process.env.MX_GATEWAY_URL ?? "http://127.0.0.1:8799";

/** Bound the upstream fetch so a hung gateway can't stall the 30s poll. */
const FETCH_TIMEOUT_MS = 10_000;

/** The fail-soft empty payload — valid SourceIndex the Swift decoder accepts. */
const EMPTY_INDEX = JSON.stringify({ sources: [], inbox: [] });

function emptyResponse(): Response {
  return new Response(EMPTY_INDEX, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

export async function handleGetSources(): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const upstream = await fetch(`${GATEWAY_URL}/sources`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });

    if (!upstream.ok) {
      logger.warn(
        { route: "/sources", upstreamStatus: upstream.status },
        "mx gateway returned non-200 — serving empty source index",
      );
      return emptyResponse();
    }

    // Passthrough: return the gateway body verbatim (already the exact wire
    // shape SourceStatus.swift decodes). Re-emit as a fresh Response so we
    // control the Content-Type + drop any hop-by-hop headers.
    const body = await upstream.text();
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    logger.warn(
      { route: "/sources", err },
      "mx gateway unreachable — serving empty source index",
    );
    return emptyResponse();
  } finally {
    clearTimeout(timer);
  }
}
