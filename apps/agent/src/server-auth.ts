/**
 * REST ID validation helpers extracted from server.ts.
 *
 * Encapsulates:
 * - Credential ID regex used across route pre-validation
 *
 * The legacy `x-nexus-secret` header gate (`requireSecret`, `AUTH_EXEMPT_PATHS`,
 * `isAuthExemptPath`, and the `ATTACH_SECRET` constant) was removed by the
 * `drop-attach-secret-gate` change. Network-level trust (loopback + Tailscale
 * bind) supersedes the soft header gate; see `server.ts` for the bind logic.
 *
 * The WebSocket `?token=` / header gate was ALSO removed (by
 * `drop-attach-secret-gate`); `server-websocket.ts` now only format-checks the
 * session id and caps concurrent connections. WS reachability, like the HTTP
 * routes, rests entirely on the network bind layer (loopback + Tailscale).
 * Restoring a WS token is a separate maintainer decision, not implied here.
 */

// ── Credential ID validation ────────────────────────────────────────────────
export const CREDENTIAL_ID_RE = /^[a-zA-Z0-9_-]+$/;
