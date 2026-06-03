/**
 * Agent target resolution.
 *
 * The web app attaches to a SINGLE Nexus agent, identified by the public env
 * var `NEXT_PUBLIC_NEXUS_AGENT_URL` (e.g. `http://100.73.182.4:7400` over the
 * tailnet). It is `NEXT_PUBLIC_*` so the value is inlined at build time and
 * available in the browser (the WS/REST clients run client-side).
 *
 * When the var is unset the app MUST render a "configure agent URL" message
 * rather than crashing (spec: web-dashboard § Next.js Web App Scaffold,
 * scenario "Missing agent URL is surfaced"). Callers therefore use
 * `getAgentBaseUrl()` which returns `null` instead of throwing.
 */

/** The configured agent base URL, or `null` when unset/blank. */
export function getAgentBaseUrl(): string | null {
  const raw = process.env.NEXT_PUBLIC_NEXUS_AGENT_URL;
  if (!raw || raw.trim() === "") return null;
  return raw.trim().replace(/\/+$/, "");
}

/** True when an agent URL is configured. */
export function isAgentConfigured(): boolean {
  return getAgentBaseUrl() !== null;
}

/**
 * Rewrite an `http(s)` agent base URL to its `ws(s)` equivalent and append a
 * path. Mirrors the Swift `consumePtyStream` / `interactURL` scheme rewrite
 * (`http`->`ws`, `https`->`wss`). Returns `null` on an unconstructable URL or
 * an unsupported scheme so callers can degrade ("input disabled") instead of
 * handing a bad scheme to the `WebSocket` constructor.
 *
 * @param base    agent base URL (`http://…` / `https://…` / `ws://…` / `wss://…`)
 * @param path    path to append, e.g. `/sessions/abc/stream` (leading slash optional)
 */
export function toWsUrl(base: string, path: string): string | null {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return null;
  }
  switch (url.protocol) {
    case "http:":
    case "ws:":
      url.protocol = "ws:";
      break;
    case "https:":
    case "wss:":
      url.protocol = "wss:";
      break;
    default:
      return null;
  }
  // Join the base path with the requested path, collapsing the seam slash.
  const basePath = url.pathname.replace(/\/+$/, "");
  const tail = path.startsWith("/") ? path : `/${path}`;
  url.pathname = `${basePath}${tail}`;
  return url.toString();
}

/**
 * Build an HTTP(S) URL against the agent base for REST calls. Returns `null`
 * on an unconstructable base. Unlike `toWsUrl` this preserves the http/https
 * scheme (REST endpoints are plain HTTP).
 *
 * The `path` MAY include a query string (e.g. `/sessions?withFingerprint=true`).
 * It is split off before assigning to `url.pathname`, because the WHATWG URL
 * `pathname` setter percent-encodes `?` (yielding `/sessions%3F…`, which the
 * agent 404s); the query is routed through `url.search` instead.
 */
export function toHttpUrl(base: string, path: string): string | null {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return null;
  }
  const basePath = url.pathname.replace(/\/+$/, "");
  const qIdx = path.indexOf("?");
  const rawPath = qIdx === -1 ? path : path.slice(0, qIdx);
  const rawQuery = qIdx === -1 ? "" : path.slice(qIdx); // includes leading '?'
  const tail = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  url.pathname = `${basePath}${tail}`;
  url.search = rawQuery;
  return url.toString();
}
