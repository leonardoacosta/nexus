/**
 * Shared mx-gateway passthrough helpers.
 *
 * Eight agent routes proxy the mx gateway (cmd/mx-gateway, 127.0.0.1:8799).
 * Before this module each route re-derived the same skeleton: env-default
 * base URL, AbortController timeout, query-param allowlist forwarding, and
 * one of two failure postures. This module is the single copy of that
 * skeleton (plans/029-mx-gateway-passthrough-helper.md).
 *
 * Two postures, deliberately asymmetric:
 *  - gatewayGetFailSoft: read routes degrade to a per-route empty payload
 *    with status 200, so a down/slow/non-200 gateway renders as a graceful
 *    empty state in the clients instead of an error.
 *  - gatewayPostRelay: write routes relay the gateway status + body
 *    VERBATIM and map timeout/network failure to 504 — NEVER a fabricated
 *    success, because a swallowed capture/decision is silent data loss.
 */

import { logger } from "@nexus/core/node";

/** mx gateway base URL. Loopback on the homelab; override via env for tests. */
const GATEWAY_URL = process.env.MX_GATEWAY_URL ?? "http://127.0.0.1:8799";

/**
 * Bearer token attached to write-route (POST/PATCH/etc) requests forwarded to
 * mx-gateway (mx-izvw.1, companion to mesh's fix-gateway-writetoken-bypass /
 * mx-pwwl). mx-gateway's MX_GATEWAY_TRUST_LOOPBACK now defaults off, so its
 * write routes fail closed on a missing/invalid Authorization header even
 * over loopback — this agent must supply it.
 *
 * Fail-open here is intentional: enforcement lives on the mx-gateway side
 * (see gatewayPostRelay doc comment above). If unset, requests are still
 * forwarded with no Authorization header and mx-gateway rejects them with
 * its own 401 — never fabricated locally.
 */
const GATEWAY_TOKEN = process.env.MX_GATEWAY_TOKEN ?? "";

/**
 * Bound every upstream fetch so a hung gateway can't stall a poll or POST.
 * Unified at 10s (plan-018 convention). /triage and /thread previously used
 * 12s — recorded decision in plan 029; bump HERE (one line) if their feeds
 * ever show abort warnings under real fan-out load.
 */
const FETCH_TIMEOUT_MS = 10_000;

export interface GatewayGetOptions {
  /** Gateway path to fetch, e.g. "/queue". Appended to the base URL. */
  path: string;
  /** Route label for structured logs, e.g. "/queue". */
  route: string;
  /** Pre-serialized fail-soft payload returned (status 200) on ANY failure. */
  emptyPayload: string;
  /** Incoming URL whose query params may be forwarded. */
  incomingUrl?: URL;
  /** Allowlist of query params copied verbatim when present (!== null). */
  forwardParams?: readonly string[];
}

function emptyResponse(payload: string): Response {
  return new Response(payload, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Fail-soft GET passthrough: gateway body verbatim, or the empty payload. */
export async function gatewayGetFailSoft(
  opts: GatewayGetOptions,
): Promise<Response> {
  const { path, route, emptyPayload, incomingUrl, forwardParams } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    // URL construction lives inside the try so a malformed MX_GATEWAY_URL
    // fail-softs to the empty payload rather than throwing past the catch.
    const upstreamUrl = new URL(`${GATEWAY_URL}${path}`);
    if (incomingUrl && forwardParams) {
      for (const key of forwardParams) {
        const value = incomingUrl.searchParams.get(key);
        if (value !== null) upstreamUrl.searchParams.set(key, value);
      }
    }

    const upstream = await fetch(upstreamUrl, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });

    if (!upstream.ok) {
      logger.warn(
        { route, upstreamStatus: upstream.status },
        "mx gateway returned non-200 — serving fail-soft empty payload",
      );
      return emptyResponse(emptyPayload);
    }

    // Passthrough: return the gateway body verbatim. Re-emit as a fresh
    // Response so we control the Content-Type + drop hop-by-hop headers.
    const body = await upstream.text();
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    logger.warn(
      { route, err },
      "mx gateway unreachable — serving fail-soft empty payload",
    );
    return emptyResponse(emptyPayload);
  } finally {
    clearTimeout(timer);
  }
}

export interface GatewayPostOptions {
  /** Gateway path to POST, e.g. "/capture". Appended to the base URL. */
  path: string;
  /** Route label for structured logs, e.g. "/capture". */
  route: string;
  /** Client body, forwarded verbatim as JSON. */
  body: string;
  /** `error` value of the 504 JSON body on timeout/network failure. */
  unreachableError: string;
  /** Extra structured-log fields (e.g. { id }). */
  logContext?: Record<string, unknown>;
}

/**
 * Verbatim POST relay: gateway status + body relayed as-is (2xx/4xx/5xx
 * alike); timeout/abort/network error maps to 504 — never a fabricated 200.
 */
export async function gatewayPostRelay(
  opts: GatewayPostOptions,
): Promise<Response> {
  const { path, route, body, unreachableError, logContext = {} } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const upstreamUrl = new URL(`${GATEWAY_URL}${path}`);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    // Write routes require Bearer auth now that mx-gateway's loopback-trust
    // bypass defaults off (mx-izvw.1). Omitted entirely when unset, rather
    // than sent as "Bearer " — mx-gateway's own check is the source of truth
    // for what an empty/missing token means.
    if (GATEWAY_TOKEN) headers.Authorization = `Bearer ${GATEWAY_TOKEN}`;

    const upstream = await fetch(upstreamUrl, {
      method: "POST",
      signal: controller.signal,
      headers,
      body,
    });

    // Relay the gateway status + body VERBATIM — 2xx, 4xx, and 5xx alike.
    // Re-emit as a fresh Response so we control the Content-Type + drop
    // hop-by-hop headers, but preserve the upstream status code.
    const upstreamBody = await upstream.text();
    if (!upstream.ok) {
      logger.warn(
        { route, upstreamStatus: upstream.status, ...logContext },
        "mx gateway returned non-2xx — relaying status verbatim",
      );
    }
    return new Response(upstreamBody, {
      status: upstream.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    // Timeout / abort / network error — map to 504. NEVER a fabricated 200:
    // a dropped write must be visibly unacknowledged so the caller retries.
    logger.warn(
      { route, err, ...logContext },
      "mx gateway unreachable — returning 504",
    );
    return new Response(JSON.stringify({ error: unreachableError }), {
      status: 504,
      headers: { "Content-Type": "application/json" },
    });
  } finally {
    clearTimeout(timer);
  }
}
