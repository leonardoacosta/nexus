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

import { gatewayGetFailSoft } from "../lib/mx-gateway";

/** The fail-soft empty payload — a bare JSON array (mx /decisions is an array). */
const EMPTY_DECISIONS = "[]";

export async function handleGetDecisions(request: Request): Promise<Response> {
  return gatewayGetFailSoft({
    path: "/decisions",
    route: "/decisions",
    emptyPayload: EMPTY_DECISIONS,
    incomingUrl: new URL(request.url),
    forwardParams: ["since", "action"],
  });
}
