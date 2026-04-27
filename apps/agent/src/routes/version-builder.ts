/**
 * Version route builder for the nexus-agent HTTP API.
 *
 * Exposes `GET /version` returning `{ buildSha, builtAt, capabilities }`.
 *
 * - `buildSha` / `builtAt` come from the build-time generated `version.gen.ts`.
 * - `capabilities` is auto-introspected from the live `Route[]` table passed in
 *   by the caller. Each entry is `"<METHOD> <path>"`, deduplicated and
 *   alphabetically sorted. The list is computed ONCE at builder construction
 *   and cached in the closure — never recomputed per request.
 *
 * The caller (see routes.ts) is responsible for including the `/version`
 * route itself in `allRoutes` so it appears in its own capability list.
 *
 * Auth bypass for `/version` is handled at the server-auth layer; this
 * builder does not perform any auth check inside the handler.
 */

import type { Route } from "../router";
import { BUILD_SHA, BUILT_AT } from "../version.gen";

export function buildVersionRoutes(allRoutes: Route[]): Route[] {
  // Compute capabilities ONCE at construction time — captured by closure.
  const capabilities = Array.from(
    new Set(allRoutes.map((r) => `${r.method.toUpperCase()} ${r.path}`)),
  ).sort();

  const payload = { buildSha: BUILD_SHA, builtAt: BUILT_AT, capabilities };
  const body = JSON.stringify(payload);

  return [
    {
      method: "GET",
      path: "/version",
      handler() {
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  ];
}
