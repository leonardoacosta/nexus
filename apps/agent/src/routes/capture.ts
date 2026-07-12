/**
 * POST /capture — Capture passthrough to the mx gateway.
 *
 * The pilot capture surface is a share-sheet Apple Shortcut (see
 * docs/capture-shortcut.md) that posts a captured thought — `{title, url?}` —
 * to nexus-agent over Tailscale. This handler forwards the JSON request body
 * verbatim to `${MX_GATEWAY_URL}/capture` via POST and relays the gateway's
 * status + body back to the caller.
 *
 * NOT FAIL-SOFT (the deliberate asymmetry vs the read routes, same posture as
 * /requests/:id/decision): a swallowed capture is silent data loss, and a
 * capture that silently vanishes is worse than one that visibly fails — the
 * Shortcut shows the error and the thought stays in hand. Failures surface
 * loudly:
 *   - Gateway 2xx/4xx/5xx → status + body relayed VERBATIM (the Shortcut
 *     surfaces the created id on success, the error on failure).
 *   - Fetch timeout / abort / network error → mapped to 504 (NEVER a
 *     fabricated success). The Shortcut retry is a re-tap.
 *
 * The upstream fetch is bounded by the same 10s timeout as the read routes.
 *
 * Auth: this handler carries no per-request gate of its own — it is dispatched
 * from `createRequestHandler` AFTER the origin defense-in-depth block, so a
 * disallowed browser origin is rejected with 403 before it ever reaches here,
 * and bind-layer reach (loopback + Tailscale) is the transport-level gate. No
 * new auth mechanism is introduced (drop-attach-secret-gate removed the legacy
 * `x-nexus-secret` header).
 */

import { gatewayPostRelay } from "../lib/mx-gateway";

export async function handlePostCapture(request: Request): Promise<Response> {
  // Read the client body once, forward it verbatim to the gateway.
  const body = await request.text();
  return gatewayPostRelay({
    path: "/capture",
    route: "/capture",
    body,
    unreachableError: "capture gateway unreachable",
  });
}
