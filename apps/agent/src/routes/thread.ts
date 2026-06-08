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

import { logger } from "@nexus/core/node";

/** mx gateway base URL. Loopback on the homelab; override via env for tests. */
const GATEWAY_URL = process.env.MX_GATEWAY_URL ?? "http://127.0.0.1:8799";

/** Bound the upstream fetch so a hung gateway can't stall the poll. */
const FETCH_TIMEOUT_MS = 12_000;

/** The fail-soft empty payload — a valid `{ messages: [] }` envelope. */
const EMPTY_THREAD = '{"messages":[]}';

function emptyResponse(): Response {
  return new Response(EMPTY_THREAD, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

export async function handleGetThread(url: URL): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  const upstreamUrl = new URL(`${GATEWAY_URL}/thread`);
  const source = url.searchParams.get("source");
  const id = url.searchParams.get("id");
  if (source) upstreamUrl.searchParams.set("source", source);
  if (id) upstreamUrl.searchParams.set("id", id);

  try {
    const upstream = await fetch(upstreamUrl, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });

    if (!upstream.ok) {
      logger.warn(
        { route: "/thread", upstreamStatus: upstream.status },
        "mx gateway returned non-200 — serving empty thread",
      );
      return emptyResponse();
    }

    const body = await upstream.text();
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    logger.warn(
      { route: "/thread", err },
      "mx gateway unreachable — serving empty thread",
    );
    return emptyResponse();
  } finally {
    clearTimeout(timer);
  }
}
