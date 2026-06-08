/**
 * GET /triage — unified cross-source item feed passthrough to the mx gateway.
 *
 * The six archetype iOS pages (Comms / Calendar / Finance / Health / Sessions /
 * Detail) consume `GET {agent}/triage` via `NexusClient.fetchTriage(source:kind:)`
 * and decode a bare JSON array `[TriageItem]` (NexusShared/Models/TriageItem.swift:
 * Core spine + TriagePayload oneof). The live data is produced by the mx gateway
 * (cmd/mx-gateway, 127.0.0.1:8799), which fans out over the whole mx source mesh
 * and serializes each merged proto TriageItem via protojson into the exact nested
 * `{ core, payload: { <arm> } }` shape the Swift decoder reads on its primary path.
 *
 * Sibling of `/sources` (mx-dn7t). This handler is a thin passthrough: it forwards
 * the optional `?source=` / `?kind=` query params, fetches the gateway JSON, and
 * returns it verbatim. FAIL-SOFT (mx-5jw1): if the gateway is down / unreachable /
 * slow / non-200, it returns an empty array `[]` with status 200, so the archetype
 * pages fall back to `TriageItem.sampleData` via TriageObserver (with the
 * "Sample data — live feed pending" caption) rather than surfacing an error.
 */

import { logger } from "@nexus/core/node";

/** mx gateway base URL. Loopback on the homelab; override via env for tests. */
const GATEWAY_URL = process.env.MX_GATEWAY_URL ?? "http://127.0.0.1:8799";

/** Bound the upstream fetch so a hung gateway can't stall the poll. */
const FETCH_TIMEOUT_MS = 12_000;

/** The fail-soft empty payload — a valid bare `[TriageItem]` array. */
const EMPTY_FEED = "[]";

function emptyResponse(): Response {
  return new Response(EMPTY_FEED, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

export async function handleGetTriage(url: URL): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  // Forward the optional server-side filters verbatim. The gateway matches
  // `kind` case-insensitively against the canonical proto name and `source`
  // exactly against Core.source.
  const upstreamUrl = new URL(`${GATEWAY_URL}/triage`);
  const source = url.searchParams.get("source");
  const kind = url.searchParams.get("kind");
  if (source) upstreamUrl.searchParams.set("source", source);
  if (kind) upstreamUrl.searchParams.set("kind", kind);

  try {
    const upstream = await fetch(upstreamUrl, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });

    if (!upstream.ok) {
      logger.warn(
        { route: "/triage", upstreamStatus: upstream.status },
        "mx gateway returned non-200 — serving empty triage feed",
      );
      return emptyResponse();
    }

    // Passthrough: return the gateway body verbatim (already the exact wire
    // shape TriageItem.swift decodes). Re-emit as a fresh Response so we
    // control the Content-Type + drop any hop-by-hop headers.
    const body = await upstream.text();
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    logger.warn(
      { route: "/triage", err },
      "mx gateway unreachable — serving empty triage feed",
    );
    return emptyResponse();
  } finally {
    clearTimeout(timer);
  }
}
