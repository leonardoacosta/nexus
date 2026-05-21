/**
 * Shared internals for credential route handlers.
 *
 * Houses the singleton `CredentialPool` ref plus small cross-cutting helpers
 * (audit logger, caller IP extraction, TLS enforcement, jsonResponse).
 *
 * These are intentionally NOT exported from the barrel — the public surface
 * is defined by `./index.ts`.
 */

import { createLogger } from "@nexus/core/node";
import type { Db } from "@nexus/db";
import type { CredentialPool } from "../../credentials/pool";

// ── Audit logger ────────────────────────────────────────────────────────────

const auditLogger = createLogger("audit.credential");

/** Structured audit log entry for credential operations. */
export type CredentialAuditEntry = {
  event: string;
  credential_id: string;
  actor: string;
  ip: string;
  timestamp_iso: string;
  detail?: Record<string, unknown>;
};

export function emitAudit(entry: CredentialAuditEntry): void {
  auditLogger.info(entry, entry.event);
}

/** Extract caller IP from request headers or socket. */
export function extractCallerIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0]?.trim() ?? "unknown";
  }
  try {
    const { hostname } = new URL(request.url);
    return hostname || "unknown";
  } catch {
    return "unknown";
  }
}

// ── Singleton pool ──────────────────────────────────────────────────────────
//
// Holds the process-global `CredentialPool` instance. A single mutable ref
// pattern (rather than a bare `let`) lets every handler module observe the
// current pool without re-exporting a getter from each file.

export const poolRef: { current: CredentialPool | null } = { current: null };

/**
 * Shared DB handle for handlers that need direct schema access without going
 * through the pool. Populated by `initCredentialRoutes(db, ...)`.
 *
 * Today this is used by the refresh-identity handlers (added in
 * `credentials-account-resolve-and-usage`) which need to read/update the
 * `credentials` row directly after invoking `pool.probeIdentity()`.
 */
export const dbRef: { current: Db | null } = { current: null };

// ── Loopback address detection ──────────────────────────────────────────────

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function isLoopbackRequest(request: Request): boolean {
  try {
    const { hostname } = new URL(request.url);
    return LOOPBACK_HOSTS.has(hostname);
  } catch {
    return false;
  }
}

/**
 * TLS enforcement for credential submission (task 6.1).
 *
 * Requests arriving over http:// from non-loopback hosts are rejected with
 * 426 Upgrade Required. Loopback addresses (127.0.0.1, ::1, localhost) are
 * exempt for local integration tests and homelab deployments.
 *
 * The agent normally sits behind Traefik/Caddy with TLS termination, so
 * external traffic arrives with an https:// scheme in the forwarded URL.
 */
export function checkTlsEnforcement(request: Request): Response | null {
  const { protocol } = new URL(request.url);
  if (protocol === "http:" && !isLoopbackRequest(request)) {
    return new Response(
      JSON.stringify({ error: "credentials must be submitted over TLS" }),
      {
        status: 426,
        headers: {
          "Content-Type": "application/json",
          Upgrade: "TLS/1.2, HTTPS",
        },
      },
    );
  }
  return null;
}

export function jsonResponse(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
