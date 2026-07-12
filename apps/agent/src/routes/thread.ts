/**
 * GET /thread — on-demand conversation-history passthrough to the mx gateway.
 *
 * The comms item-detail view (TriageDetailView) fetches `GET {agent}/thread?source=&id=`
 * to render the conversation thread (CommsMessage bubbles) for a single comms
 * item. The live data is produced by the mx gateway (cmd/mx-gateway,
 * 127.0.0.1:8799 → GET /thread), which resolves the source, dials it, calls the
 * source's Get(id) (the source attaches CommsBody.messages on Get — the on-demand
 * rule, mirroring body), and serializes `{ "messages": [ { author, author_handle,
 * text, ts, self }, ... ] }` oldest→newest.
 *
 * Sibling of `/triage` (mx-rkir.1). This handler is a thin passthrough: it
 * forwards the `?source=` / `?id=` query params, fetches the gateway JSON, and
 * returns it verbatim. FAIL-SOFT: if the gateway is down / unreachable / slow /
 * non-200, it returns an empty thread `{"messages":[]}` with status 200, so the
 * detail view renders "no earlier messages" rather than surfacing an error.
 */

import { gatewayGetFailSoft } from "../lib/mx-gateway";

/** The fail-soft empty payload — a valid `{ messages: [] }` envelope. */
const EMPTY_THREAD = '{"messages":[]}';

export async function handleGetThread(url: URL): Promise<Response> {
  return gatewayGetFailSoft({
    path: "/thread",
    route: "/thread",
    emptyPayload: EMPTY_THREAD,
    incomingUrl: url,
    forwardParams: ["source", "id"],
  });
}
