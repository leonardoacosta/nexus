/**
 * GET /requests — Request-history passthrough to the mx gateway.
 *
 * The Swift/web Radar view reads request-status transitions for a source from
 * the mx gateway (cmd/mx-gateway, 127.0.0.1:8799). This handler is a thin
 * passthrough mirroring `/sources` (see sources.ts): it forwards the
 * `status`, `source`, and `changed_since` query params to
 * `${MX_GATEWAY_URL}/requests` and returns the gateway body verbatim.
 *
 * FAIL-SOFT (mirrors /sources): if the gateway is down / unreachable / slow,
 * it returns an empty `{ requests: [] }` with status 200 so the Radar drawer
 * shows a graceful empty state ("No request history") rather than crashing or
 * spinning forever.
 */

import { gatewayGetFailSoft } from "../lib/mx-gateway";

/** The fail-soft empty payload. */
const EMPTY_REQUESTS = JSON.stringify({ requests: [] });

export async function handleGetRequests(request: Request): Promise<Response> {
  return gatewayGetFailSoft({
    path: "/requests",
    route: "/requests",
    emptyPayload: EMPTY_REQUESTS,
    incomingUrl: new URL(request.url),
    forwardParams: ["status", "source", "changed_since"],
  });
}
