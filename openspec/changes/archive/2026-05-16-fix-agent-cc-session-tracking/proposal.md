# Fix agent's Claude Code session tracking

## Why

Today the Nexus agent's `/sessions` endpoint returns ~4,000 active rows on Mac
and ~30 on homelab, but **zero of them carry CC-discriminator fields** — every
row has `pid: 0`, `tmuxTarget: ""`, `cwd: ""`, `model: null`, `ccSessionId: null`,
and `sessionType: "ad_hoc"`. Meanwhile Leo's actual `claude` processes (3 on
homelab, more on Mac, verified via `pgrep -af claude`) are nowhere in the table.

This makes the menu bar client (`add-swift-menubar`) effectively blind to real
work happening. The Swift app currently ships with two compensating mechanisms:

1. **Client-side fingerprint filter** — `hasCCFingerprint` rejects stubs
   (`NexusSession.swift`). With zero real rows in the DB, the panel shows an
   empty session list.
2. **SSH probe fallback** — when the agent path returns zero CC-fingerprinted
   rows, the Swift client SSHes to homelab and runs `pgrep -af claude` to
   synthesize rows (`ProcessProbe.swift`). This works but is brittle (needs
   SSH keys, doesn't cross-machine federate, won't survive macOS networking
   sandboxes if we re-enable App Sandbox).

Both are stop-gaps. The right place to track CC processes is the agent itself.

## What Changes

The agent SHALL populate `pid`, `tmuxTarget`, `cwd`, `model`, and (when known)
`ccSessionId` on session rows when a real `claude` process is detected. The
session-creation path (`POST /session/start` in
`apps/agent/src/routes/sessions.ts:200-264`) already plumbs the tmux window
name — extend the same path to capture the spawned PID. A new
**process-watcher loop** SHALL periodically reconcile `ps`/`pgrep` against
the open session rows on the agent's machine, closing rows whose PID has
died and creating rows for newly-spawned `claude` instances that lack a row.

Telemetry-ping endpoints (`/hooks`, `/notifications/*`) SHALL NOT create new
session rows. The session ID supplied by the CC hook payload SHALL be used to
look up an existing row; if no match, the event SHALL be dropped rather than
synthesizing a stub. This is the root cause of the ~4,000-row stub flood.

### New / changed endpoints

| Endpoint | Change |
| --- | --- |
| `POST /session/start` | Capture spawned PID; populate `pid`, `cwd`, `model`, `tmuxTarget` |
| `GET /sessions` | Add `?withFingerprint=true` query param to filter to CC-real rows on the server side |
| `POST /hooks` | STOP creating session rows for unknown `sessionId` — drop instead |
| (new) `GET /sessions/probe` | Force-rescan local processes, reconcile against `/sessions` |

### Migration

One-shot cleanup: mark all `sessionType=ad_hoc AND pid IS NULL AND
tmuxTarget IS NULL AND model IS NULL` rows as `endedAt=NOW()`. This removes
the existing stub backlog without losing any meaningful data.

## Out of Scope

- **Federation propagation of session rows** — separate concern; this spec
  only ensures each agent tracks its own machine correctly.
- **Removing the Swift SSH-probe fallback** — leave it in place until this
  spec ships; only then can we delete `ProcessProbe.swift`.
- **Cross-agent session ID reconciliation** — also separate.

## References

- Adjacent: `add-swift-menubar` (already shipped) — its `hasCCFingerprint`
  filter and `ProcessProbe.swift` fallback document the workaround.
- Affected source:
  - `apps/agent/src/routes/sessions.ts`
  - `apps/agent/src/routes/hooks.ts`
  - `apps/agent/src/db/sessions.ts`
  - `packages/core/src/types/session.ts`
- touches: `apps/agent/src/routes/sessions.ts`, `apps/agent/src/routes/hooks.ts`, `apps/agent/src/db/sessions.ts`, `packages/core/src/types/session.ts`
