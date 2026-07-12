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

import { gatewayGetFailSoft } from "../lib/mx-gateway";

/** The fail-soft empty payload — a valid bare `[TriageItem]` array. */
const EMPTY_FEED = "[]";

export async function handleGetTriage(url: URL): Promise<Response> {
  // The gateway matches `kind` case-insensitively against the canonical
  // proto name and `source` exactly against Core.source.
  return gatewayGetFailSoft({
    path: "/triage",
    route: "/triage",
    emptyPayload: EMPTY_FEED,
    incomingUrl: url,
    forwardParams: ["source", "kind"],
  });
}
