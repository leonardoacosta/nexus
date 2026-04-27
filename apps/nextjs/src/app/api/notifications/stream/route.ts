/**
 * SSE proxy for `/events/stream` on the local nexus-agent.
 *
 * Same-origin proxy: the Next.js process is on the same host as the agent
 * so this route can stream the agent's SSE response straight back to the
 * client. The agent only allows Tailscale origins via CORS, but the
 * same-host proxy bypasses that gate naturally — no CORS headers needed
 * on this route, the consumer is same-origin.
 *
 * The response shape is preserved exactly: the lifecycle bus emits
 * `event: <Name>\ndata: <envelope-json>\n\n` frames; the client filters
 * for `NotificationFired` and `SettingsChanged`.
 */

import { getAgentBaseUrl } from "@/lib/agent-url";

export const dynamic = "force-dynamic";
// Force the Node.js runtime — Edge has fetch streaming quirks.
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const resolved = await getAgentBaseUrl();
  if (!resolved) {
    return new Response("agent unreachable", { status: 503 });
  }

  // Wire the client's abort signal through to the upstream fetch so a
  // browser-side EventSource close terminates the connection promptly.
  const upstream = await fetch(`${resolved.baseUrl}/events/stream`, {
    headers: {
      Accept: "text/event-stream",
    },
    signal: request.signal,
    // SSE responses are open-ended; cache must be off.
    cache: "no-store",
  }).catch(() => null);

  if (!upstream || !upstream.ok || !upstream.body) {
    return new Response("upstream SSE unavailable", { status: 502 });
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
