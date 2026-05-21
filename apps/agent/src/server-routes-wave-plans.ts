/**
 * Wave-plan route dispatch.
 *
 * Sub-dispatcher for `/wave-plans/*` paths. Mirrors the pattern in
 * `server-routes-specs.ts` (withCors + per-route try/catch wrapper).
 *
 * Added by `specs-tab-accordion-with-topology` (task 1.2).
 */

import { logger } from "@nexus/core/node";
import { handleGetActiveWavePlan } from "./routes/wave-plans";
import { withCors } from "./server-origin";

/**
 * Try to match and handle a wave-plan route.
 *
 * Returns a Response (or Promise<Response>) when the URL matches, else null.
 */
export function tryHandleWavePlanRoute(
  request: Request,
  url: URL,
): Response | Promise<Response> | null {
  if (url.pathname === "/wave-plans/active" && request.method === "GET") {
    return handleGetActiveWavePlan()
      .then((r) => withCors(request, r))
      .catch((err) => {
        logger.error(
          { route: "/wave-plans/active", method: "GET", err },
          "route handler failed",
        );
        return withCors(
          request,
          new Response(JSON.stringify({ error: "internal error" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          }),
        );
      });
  }

  return null;
}
