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

import { gatewayPostRelay } from "../lib/mx-gateway";

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

  return gatewayPostRelay({
    path: `/requests/${encodeURIComponent(id)}/decision`,
    route: "/requests/:id/decision",
    body,
    unreachableError: "decision gateway unreachable",
    logContext: { id },
  });
}
