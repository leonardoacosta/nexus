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

import { gatewayGetFailSoft } from "../lib/mx-gateway";

/** The fail-soft empty payload — valid SourceIndex the Swift decoder accepts. */
const EMPTY_INDEX = JSON.stringify({ sources: [], inbox: [] });

export async function handleGetSources(): Promise<Response> {
  return gatewayGetFailSoft({
    path: "/sources",
    route: "/sources",
    emptyPayload: EMPTY_INDEX,
  });
}
