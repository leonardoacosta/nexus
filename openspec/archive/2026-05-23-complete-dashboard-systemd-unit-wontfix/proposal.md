# Proposal: Complete the Dashboard systemd Unit + Traefik Wiring

## Why

The `systemd-service` capability spec mandates a hardened `nexus-dashboard.service` unit and a build-preflight reminder in `install.sh --dashboard`. The flag exists in `deploy/install.sh` but the two files it tries to copy do not:

- `deploy/nexus-dashboard.service` — missing; install prints `warn "nexus-dashboard.service not present — legacy dashboard retired."`
- `deploy/traefik/nexus-dashboard.yml` — missing; install prints `warn "Traefik dynamic dir or config not found — skipping reverse proxy install."`

So `--dashboard` is dead code — it advertises a deploy path that silently no-ops. Either the spec is wrong, or these files need to ship. The spec is correct (the homelab still serves the Next.js dashboard at `nexus.leonardoacosta.dev` for browser-only clients that can't run the Swift dashboard), so the gap is real and the artifacts must land. This proposal closes that gap.

## What Changes

- Author `deploy/nexus-dashboard.service` — hardened systemd user unit mirroring `nexus-agent.service` style, running `next start --port 3100` from `apps/nextjs/` with `Restart=always`, restart-loop bounds, and `ProtectSystem=strict` + scoped `ReadWritePaths` for the Next.js `.next/` cache and runtime dirs.
- Author `deploy/traefik/nexus-dashboard.yml` — Traefik file-provider config declaring a TLS router for `Host("nexus.leonardoacosta.dev")` forwarding to `http://localhost:3100`, parameterized cert resolver, suitable for the homelab's `/etc/traefik/dynamic/` watch directory.
- Wire the `--dashboard` branch of `deploy/install.sh` end-to-end (Linux only): copy the unit, copy the Traefik config (when the dynamic dir exists), run `systemctl --user daemon-reload`, print the `pnpm --filter @nexus/nextjs build` preflight reminder, and print the `systemctl --user enable --now nexus-dashboard.service` next-step. macOS branch prints "Dashboard unit Linux-only; macOS reads from agent over Tailscale" and remains a no-op so `deploy/check-no-mac-daemon.sh` keeps passing.

## Context

- depends on: (none)
- touches: `deploy/nexus-dashboard.service`, `deploy/traefik/nexus-dashboard.yml`, `deploy/install.sh`

## Impact

| Area | Change |
|------|--------|
| `deploy/nexus-dashboard.service` | New file — hardened Next.js systemd user unit |
| `deploy/traefik/nexus-dashboard.yml` | New file — Traefik dynamic router + service for the dashboard host |
| `deploy/install.sh` | `--dashboard` branch becomes functional; warns become installs; preflight reminder printed |
| Drift guard | `deploy/check-no-mac-daemon.sh` MUST continue to pass — no plists, no `launchctl` invocations added |

**Breaking?** No. Opt-in via the existing `--dashboard` flag. Hosts that don't pass it are unaffected. The agent unit (`nexus-agent.service`) is untouched.
