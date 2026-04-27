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

import { BUILD_SHA, BUILT_AT } from "../version.gen";

// ---------------------------------------------------------------------------
// Route type
// ---------------------------------------------------------------------------
//
// `Route` lives here because the version builder is the only surviving
// consumer of the typed-route shape — the `router.ts` factory, `routes.ts`
// orchestrator, and 13 `*-builder.ts` modules were deleted by
// `apply-4-findings` (tasks 2.5–2.8) once the legacy if/else dispatch in
// `server-request-handler.ts` became the source of truth.
//
// The legacy `requiresAuth` field was removed (the secret gate was retired
// by `drop-attach-secret-gate`; reach is now constrained at the bind layer).
// `requiresDb` is kept as an optional documentary field — the legacy
// dispatcher does not consume it, but it accurately describes which routes
// the if/else chain skips when `db` is undefined.

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

export interface Route {
  /** HTTP method to match. */
  method: HttpMethod;
  /**
   * Path pattern.
   *
   * - Exact string: "/health", "/sessions"
   * - Parameterised: "/sessions/:id", "/credentials/:id/release"
   */
  path: string;
  /** Route handler. Receives the original request and any captured path params. */
  handler: (req: Request, params: Record<string, string>) => Response | Promise<Response>;
  /**
   * When true, the route is only reachable when a DB connection is available.
   * @default false
   */
  requiresDb?: boolean;
}

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
