/**
 * Declarative route table and request dispatcher.
 *
 * Replaces the monolithic if/else chain in server.ts with a typed route
 * table and centralized error handling. Each route declares its method,
 * path pattern, handler, and optional flags (requiresDb, requiresAuth).
 *
 * Designed for Bun's native HTTP server (Request -> Response).
 */

import { logger } from "@nexus/core";

// ---------------------------------------------------------------------------
// Route type definition
// ---------------------------------------------------------------------------

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

export interface Route {
  /** HTTP method to match. */
  method: HttpMethod;
  /**
   * Path pattern.
   *
   * - Exact string: "/health", "/sessions"
   * - Parameterised: "/sessions/:id", "/credentials/:id/release"
   *
   * Named parameters (`:name`) capture the path segment into `params`.
   */
  path: string;
  /** Route handler. Receives the original request and any captured path params. */
  handler: (req: Request, params: Record<string, string>) => Response | Promise<Response>;
  /**
   * When true, the route is only reachable when a DB connection is available.
   * Requests to DB-guarded routes without a DB fall through to 404.
   * @default false
   */
  requiresDb?: boolean;
  /**
   * When true (default), the route requires the `x-nexus-secret` header.
   * Set to false for unauthenticated endpoints (e.g. health probes).
   * @default true
   */
  requiresAuth?: boolean;
}

// ---------------------------------------------------------------------------
// Path pattern compilation
// ---------------------------------------------------------------------------

/**
 * Compiled representation of a route's path pattern.
 * Pre-compiling avoids re-parsing on every request.
 */
interface CompiledRoute {
  route: Route;
  regex: RegExp;
  paramNames: string[];
}

/**
 * Compile a path pattern string into a regex and param-name list.
 *
 * Supports:
 * - Exact paths: "/health" -> /^\/health$/
 * - Named params: "/sessions/:id" -> /^\/sessions\/([^/]+)$/
 * - Multiple params: "/specs/:project/:name/approve"
 */
function compilePath(path: string): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];

  // Escape regex-special chars except for `:param` segments
  const pattern = path
    .split("/")
    .map((segment) => {
      if (segment.startsWith(":")) {
        paramNames.push(segment.slice(1));
        return "([^/]+)";
      }
      // Escape any regex-special characters in literal segments
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");

  return { regex: new RegExp(`^${pattern}$`), paramNames };
}

/**
 * Pre-compile an array of routes for fast matching.
 */
function compileRoutes(routes: Route[]): CompiledRoute[] {
  return routes.map((route) => {
    const { regex, paramNames } = compilePath(route.path);
    return { route, regex, paramNames };
  });
}

// ---------------------------------------------------------------------------
// Route matching
// ---------------------------------------------------------------------------

export interface RouteMatch {
  route: Route;
  params: Record<string, string>;
}

/**
 * Find the first route matching the given method and pathname.
 *
 * @param method  - HTTP method (uppercase)
 * @param pathname - URL pathname (e.g. "/sessions/abc-123")
 * @param compiled - Pre-compiled route array
 * @param hasDb   - Whether a DB connection is available
 * @returns The matched route and extracted params, or null
 */
export function matchRoute(
  method: string,
  pathname: string,
  compiled: CompiledRoute[],
  hasDb: boolean,
): RouteMatch | null {
  for (const { route, regex, paramNames } of compiled) {
    // Skip DB-required routes when no DB is available
    if (route.requiresDb && !hasDb) continue;

    // Method must match
    if (route.method !== method) continue;

    const match = pathname.match(regex);
    if (!match) continue;

    // Extract named params from capture groups
    const params: Record<string, string> = {};
    for (let i = 0; i < paramNames.length; i++) {
      params[paramNames[i]!] = decodeURIComponent(match[i + 1]!);
    }

    return { route, params };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Error handler wrapper
// ---------------------------------------------------------------------------

/**
 * Wrap a route handler with unified error handling.
 *
 * Replaces the ~30 duplicated `.catch()` blocks in server.ts. On error it:
 * 1. Logs the error with route name, method, and error details
 * 2. Returns a CORS-safe 500 JSON response
 *
 * The `corsWrapper` parameter lets the caller inject the existing `withCors`
 * function without duplicating CORS logic here.
 */
export async function withErrorHandler(
  routeName: string,
  handler: () => Response | Promise<Response>,
  request: Request,
  corsWrapper: (req: Request, res: Response) => Response,
): Promise<Response> {
  try {
    const response = await handler();
    return corsWrapper(request, response);
  } catch (err) {
    logger.error(
      { route: routeName, method: request.method, err },
      "route handler failed",
    );
    return corsWrapper(
      request,
      new Response(JSON.stringify({ error: "internal error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export interface RouterOptions {
  /** Array of route definitions. */
  routes: Route[];
  /**
   * CORS wrapper function. Applied to every response (success and error).
   * Signature matches the existing `withCors(request, response)` in server.ts.
   */
  corsWrapper: (req: Request, res: Response) => Response;
  /**
   * Auth check function. Returns null on success, or a Response (e.g. 401)
   * on failure. Matches the existing `requireSecret(request)` in server.ts.
   */
  authCheck: (req: Request) => Response | null;
  /** Whether a DB connection is available. */
  hasDb: boolean;
}

export interface Router {
  /** Pre-compiled routes for external inspection/testing. */
  compiled: CompiledRoute[];
  /**
   * Handle an incoming HTTP request.
   * Returns a Response, or null if no route matched (caller handles 404).
   */
  handle: (request: Request, url: URL) => Response | Promise<Response> | null;
}

/**
 * Create a request dispatcher from a declarative route table.
 *
 * The returned `handle` function:
 * 1. Matches the request method + pathname against compiled routes
 * 2. Enforces auth when `requiresAuth !== false`
 * 3. Wraps the handler in `withErrorHandler` for unified error logging
 * 4. Returns null when no route matches (caller is responsible for 404)
 *
 * WebSocket upgrades, CORS preflight (OPTIONS), and inline routes like
 * /health that need special state access remain in server.ts. The router
 * handles the "long tail" of REST routes.
 */
export function createRouter(options: RouterOptions): Router {
  const { routes, corsWrapper, authCheck, hasDb } = options;
  const compiled = compileRoutes(routes);

  function handle(
    request: Request,
    url: URL,
  ): Response | Promise<Response> | null {
    const match = matchRoute(request.method, url.pathname, compiled, hasDb);
    if (!match) return null;

    const { route, params } = match;

    // Auth gate (default: required)
    if (route.requiresAuth !== false) {
      const authErr = authCheck(request);
      if (authErr) return authErr;
    }

    // Build a display name for logging: "GET /sessions/:id"
    const routeName = route.path;

    return withErrorHandler(
      routeName,
      () => route.handler(request, params),
      request,
      corsWrapper,
    );
  }

  return { compiled, handle };
}
