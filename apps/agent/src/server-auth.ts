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
 * WebSocket auth still uses a token (header or query-string) and lives in
 * `server-websocket.ts` — that surface is untouched by the HTTP-gate removal.
 */

// ── Credential ID validation ────────────────────────────────────────────────
export const CREDENTIAL_ID_RE = /^[a-zA-Z0-9_-]+$/;
