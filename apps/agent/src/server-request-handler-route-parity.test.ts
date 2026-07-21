/**
 * Route-registry parity test (mechanize-route-registry-parity, GOD-01).
 *
 * `LEGACY_DISPATCH_ROUTES` in `server-request-handler.ts` is the source-of-truth
 * for `GET /version`'s `capabilities` array. It had already drifted from the
 * live dispatch chain (POST /apns/register + POST /capture were dispatched but
 * missing from the array). This test statically parses the source text of
 * `server-request-handler.ts` — the dispatcher has no runtime route table — and
 * asserts the array exactly equals the set of routes actually reachable through
 * `handleRequestInner`, so a future added/removed route without a matching array
 * update fails locally and in CI instead of silently shipping a wrong /version.
 *
 * The "actual dispatched" set is assembled from three sources:
 *   1. Inline routes wrapped by the shared `dispatchRoute(request, "path",
 *      "METHOD", ...)` helper — mechanically extracted (the churny majority,
 *      already normalized to `:param` labels). This is the live drift detector:
 *      a new `dispatchRoute` call not in the array shows up as `extra`.
 *   2. `NON_WRAPPED_INLINE` — inline routes dispatched without `dispatchRoute`
 *      (sync `withCors`, direct return, or a `.then` with no `.catch` to
 *      dedupe), so there's no helper call to extract. Pinned explicitly.
 *   3. `DELEGATED` — routes dispatched by `tryHandle*Route` sub-dispatchers in
 *      OTHER files, represented in the capability array but not inline here.
 *
 * See design.md ## Section: Parity test design.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(
  join(import.meta.dir, "server-request-handler.ts"),
  "utf8",
);

type RouteKey = string; // "METHOD /path"
const key = (method: string, path: string): RouteKey => `${method} ${path}`;

/** Parse the LEGACY_DISPATCH_ROUTES array literal (the DECLARED capability set). */
function parseDeclaredRoutes(): Set<RouteKey> {
  const set = new Set<RouteKey>();
  const re = /\{\s*method:\s*"([A-Z]+)",\s*path:\s*"([^"]+)"\s*\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(SRC)) !== null) set.add(key(m[1]!, m[2]!));
  return set;
}

/** Extract routes dispatched inline via the shared `dispatchRoute` helper. */
function parseDispatchRouteCalls(): Set<RouteKey> {
  const set = new Set<RouteKey>();
  // dispatchRoute(request, "<path>", "<METHOD>", ...) OR
  // dispatchRoute(request, url.pathname, "<METHOD>", ...)
  const re = /dispatchRoute\(request,\s*(?:"([^"]+)"|url\.pathname),\s*"([A-Z]+)",/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(SRC)) !== null) {
    const path = m[1];
    const method = m[2]!;
    if (path === undefined) {
      // The only dynamic-label dispatch: `url.pathname` covers the
      // /session/start + /sessions/start alias pair (same handleSessionStart).
      set.add(key(method, "/session/start"));
      set.add(key(method, "/sessions/start"));
    } else {
      set.add(key(method, path));
    }
  }
  return set;
}

/**
 * Inline routes dispatched WITHOUT `dispatchRoute` (sync `withCors`, direct
 * return, or a `.then` with no `.catch`) — no helper call to extract, so pinned
 * here. A new one must be added to BOTH the array and this list.
 */
const NON_WRAPPED_INLINE: RouteKey[] = [
  key("GET", "/version"),
  key("GET", "/health"),
  key("GET", "/health/processes"),
  key("POST", "/health/ingest"),
  key("POST", "/meeting/start"),
  key("GET", "/meeting/status"),
  key("GET", "/events/stream"),
];

/**
 * Routes dispatched by delegated `tryHandle*Route` sub-dispatchers in other
 * files — present in the capability array but not inline-dispatched here, so
 * not mechanically extractable from this source. Pinned explicitly; a new
 * delegated route must be added to BOTH the array and this list.
 */
const DELEGATED: RouteKey[] = [
  // session-context (tryHandleSessionContextRoute)
  key("GET", "/sessions/:id/context"),
  key("PATCH", "/sessions/:id/context"),
  // project-status / pulse (tryHandleGitEventsRoute / tryHandlePulseRoute)
  key("GET", "/projects/:id/git-events"),
  key("GET", "/projects/:code/pulse"),
  // credentials (tryHandleCredentialRoute)
  key("GET", "/credentials"),
  key("POST", "/credentials"),
  key("GET", "/credentials/active"),
  key("POST", "/credentials/lease"),
  key("POST", "/credentials/:id/release"),
  key("POST", "/credentials/:id/report-rate-limit"),
  key("GET", "/credentials/:id/health"),
  key("GET", "/credentials/status"),
  // elevenlabs (tryHandleElevenlabsRoute)
  key("GET", "/elevenlabs/credentials"),
  key("PATCH", "/elevenlabs/credentials"),
  key("DELETE", "/elevenlabs/credentials"),
  key("POST", "/elevenlabs/credentials/test"),
  key("GET", "/elevenlabs/voices"),
  // integrations (tryHandleIntegrationCredentialsRoute)
  key("GET", "/integrations/:provider/credentials"),
  key("PATCH", "/integrations/:provider/credentials"),
  key("DELETE", "/integrations/:provider/credentials"),
  key("POST", "/integrations/:provider/credentials/test"),
  key("GET", "/integrations/:provider/voices"),
  // specs (tryHandleSpecRoute)
  key("GET", "/specs/:project/:name/:file"),
  key("GET", "/specs/:project/:name/sessions"),
  key("PATCH", "/specs/:project/:name/status"),
  // wave-plans (tryHandleWavePlanRoute)
  key("GET", "/wave-plans/active"),
  // /recommend: listed in the capability array but composed into /statusline
  // (no live standalone HTTP dispatch). Pinned as a known non-inline entry —
  // removing it is a /version capability change out of scope for this proposal.
  key("GET", "/recommend"),
];

describe("LEGACY_DISPATCH_ROUTES parity", () => {
  it("matches the live dispatch chain exactly (no missing, no extra)", () => {
    const declared = parseDeclaredRoutes();
    const actual = new Set<RouteKey>([
      ...parseDispatchRouteCalls(),
      ...NON_WRAPPED_INLINE,
      ...DELEGATED,
    ]);

    // `missing`: in the array but nothing dispatches it (stale capability).
    // `extra`:   dispatched but absent from the array (unadvertised route).
    const missing = [...declared].filter((r) => !actual.has(r)).sort();
    const extra = [...actual].filter((r) => !declared.has(r)).sort();

    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
  });

  it("includes the two routes GOD-01 flagged as drifted", () => {
    const declared = parseDeclaredRoutes();
    expect(declared.has(key("POST", "/apns/register"))).toBe(true);
    expect(declared.has(key("POST", "/capture"))).toBe(true);
  });

  it("sanity: parsers found a non-trivial route set", () => {
    expect(parseDeclaredRoutes().size).toBeGreaterThan(50);
    expect(parseDispatchRouteCalls().size).toBeGreaterThan(30);
  });
});
