import net from "node:net";

/**
 * Disable Node/Bun "Happy Eyeballs" (autoSelectFamily) multi-address
 * connection racing, process-wide.
 *
 * ── Why ──────────────────────────────────────────────────────────────────
 * The homelab agent crashed ~4x/18h with an uncaught exception (nx-veo5g.5):
 *
 *   TypeError: null is not an object (evaluating 'context')
 *     at internalConnectMultipleTimeout (node:net:1132:215)
 *
 * `internalConnectMultipleTimeout` is Bun's node:net implementation of the
 * Happy Eyeballs algorithm — the timeout callback that fires while racing a
 * connection across MULTIPLE resolved addresses for one hostname (RFC 8305).
 * Bun dereferences a null internal `context` when that timeout fires after the
 * winning socket has already connected / been destroyed (oven-sh/bun#24374;
 * cf. nodejs/node#54359 on the same racing-timeout fragility). The agent's own
 * top-level uncaughtException handler catches it and exits for a clean systemd
 * restart — fail-fast by design, but still a real, frequent crash.
 *
 * The racing timeout path is ONLY scheduled when `autoSelectFamily` is true
 * (the Node 20+ / Bun default). Turning it off removes the crash path entirely;
 * connections fall back to ordered sequential connect (no behavioral change for
 * single-address hosts, a slightly slower first-address-wins for dual-stack).
 *
 * ── What triggers it here ────────────────────────────────────────────────
 * The only outbound clients on the node:net path (Bun's `fetch` is native/Zig,
 * NOT node:net) that resolve to more than one address are:
 *   - postgres-js -> POSTGRES_URL host `homelab` (Tailscale MagicDNS returns a
 *     dual-stack IPv4 100.x + IPv6 fd7a:: pair)
 *   - the OTLP/HTTP exporter (@opentelemetry/exporter-*-otlp-http use node
 *     http/https) -> OTEL_EXPORTER_OTLP_ENDPOINT
 * The mysql2 (127.0.0.1) and VictoriaMetrics / mx-gateway (literal IPs, and
 * native fetch anyway) clients cannot trigger the race.
 *
 * Must run before any outbound node:net connection opens, so this module is the
 * FIRST import in index.ts and self-invokes on load.
 */
export function disableHappyEyeballs(): void {
  // `setDefaultAutoSelectFamily` exists in Node >=19.4 and Bun >=1.x. Guarded so
  // an older runtime without it degrades to a no-op rather than throwing at the
  // very first line of agent startup.
  const n = net as typeof net & {
    setDefaultAutoSelectFamily?: (value: boolean) => void;
  };
  n.setDefaultAutoSelectFamily?.(false);
}

disableHappyEyeballs();
