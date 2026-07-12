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

import { gatewayGetFailSoft } from "../lib/mx-gateway";

/** The fail-soft empty payload. */
const EMPTY_QUEUE = JSON.stringify({ items: [] });

export async function handleGetQueue(request: Request): Promise<Response> {
  return gatewayGetFailSoft({
    path: "/queue",
    route: "/queue",
    emptyPayload: EMPTY_QUEUE,
    incomingUrl: new URL(request.url),
    forwardParams: ["limit"],
  });
}
