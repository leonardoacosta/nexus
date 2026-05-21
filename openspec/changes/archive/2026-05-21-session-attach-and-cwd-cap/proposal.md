# Proposal: Session attach (click-to-tmux) + CAP_SYS_PTRACE for cwd resolution

## Change ID

session-attach-and-cwd-cap

## Why

The Sessions tab still shows `— · claude · 49m` for every row despite
session-row-enrichment-v1 shipping the Swift redesign and agent-side
resolver. Root cause split across two domains:

1. **Agent's `readProcessCwd` silently fails** for CC processes
   spawned outside nexus-agent.service. `kernel.yama.ptrace_scope=1`
   on the homelab kernel restricts `readlink /proc/PID/cwd` to direct
   ancestors of the target PID. Shell `readlink` succeeds because the
   ssh session is an ancestor of CC processes Leo launched. The
   nexus-agent.service is NOT an ancestor (it runs under user.slice
   alongside, not as parent), so its in-process readlinkSync gets
   EACCES — confirmed via reproduction with `systemd-run --user
   --property=...`. Filed as nx-cvyxt P3 during nx-lebux triage,
   now elevated to blocker for the Sessions view UX.

2. **No way to enter a session interactively from the dashboard.**
   PtyViewer reads the byte stream and renders ANSI via SwiftTerm,
   but discards keystrokes (`Input is captured by SwiftTerm but
   discarded — the dashboard surface does not allow typing back`).
   Leo's mental model: click a managed session row, end up in a
   live tmux pane and type. Today: read-only preview at best,
   nothing at worst.

Both bugs serve the same UX goal — "see and act on active CC
sessions" — so they bundle into one spec.

## What Changes

### Agent (deploy + watcher)

1. **Add `AmbientCapabilities=CAP_SYS_PTRACE`** to
   `deploy/nexus-agent.service`. This grants the agent the capability
   to read /proc/PID/cwd for any same-user process regardless of
   ancestry. Narrower than `kernel.yama.ptrace_scope=0` (which would
   disable Yama LSM globally); narrower than ProtectSystem changes
   (orthogonal). The capability is set-on-exec, doesn't propagate to
   spawned children unless explicitly inherited.
   `CapabilityBoundingSet` already includes it; only AmbientCapabilities
   needs adding for it to actually take effect at runtime.

2. **Sanity-check `readProcessCwd`** in
   `apps/agent/src/services/process-watcher.ts` — should now succeed
   without code changes after the cap is granted. Add an os_log info
   line on first successful readlink after agent start (one-shot
   confirmation, not per-call).

3. **Verify `POST /commands/send-text` endpoint** is reachable and
   forwards input via `tmux send-keys -t <session> <text> Enter`.
   File exists at `apps/agent/src/routes/commands-send-text.ts`. No
   changes expected; this task is verification + smoke.

### Swift (Sessions click-to-attach + PTY input)

4. **SessionRow becomes tappable** for managed sessions
   (`sessionType == "managed"`). Tap action: navigate to PtyViewer
   with the session's id, label (`gitOwnerRepo` or projectId), and
   tmuxTarget. Non-managed rows show a muted "untracked" badge and
   don't respond to taps.

5. **PtyViewer gains input forwarding.** Flip the SwiftTerm
   `terminalDelegate` from no-op send to a real `send()` that calls
   `NexusClient.sendText(sessionId:, text:)` — which POSTs to
   `/commands/send-text`. Keep ANSI escape handling in the
   client-side terminal (SwiftTerm already does it).

6. **Add `sendText(sessionId:, text:)`** to `NexusShared/Networking/NexusClient.swift`
   if not already exposed. NexusAggregateClient: pick the agent
   matching the session's `originAgent` (homelab today, future-proof).

7. **PtyViewer detail view replaces the hidden "untracked" detail**
   — when a managed session is tapped, the dashboard's right pane
   shows PtyViewer with that session's stream + input forwarding.
   Header includes session label + a "Close" affordance returning
   to the spec/project default view.

### Tests

8. Agent contract test for `/commands/send-text` (likely already
   exists; verify).
9. Swift PtyViewer input test — assert that typing a character
   triggers a `sendText` call (mock NexusClient).

## Context

- depends on: (none — session-row-enrichment-v1 + specs-tab-accordion-with-topology archived 2026-05-21)
- touches: `deploy/nexus-agent.service`, `apps/agent/src/services/process-watcher.ts`, `apps/swift/nexus-mac/Sources/Dashboard/SessionsView.swift`, `apps/swift/nexus-mac/Sources/Dashboard/PtyViewer.swift`, `apps/swift/NexusShared/Networking/NexusClient.swift`, `apps/swift/NexusShared/Networking/NexusAggregateClient.swift`, `apps/swift/NexusSharedTests/PtyAttachTests.swift`

## Motivation

The Sessions tab is the highest-traffic surface but currently provides
zero clickable affordance. Leo opens Nexus.app dozens of times per day
to glance at active CC work; making rows tappable into a live tmux
pane converts the dashboard from "passive observer" to "control
surface". The cwd-cap fix is a prerequisite — without it, even the
visual labels stay empty.

## Locked Decisions

- **CAP_SYS_PTRACE > ptrace_scope=0** — capability is scoped to the
  unit, doesn't affect other system processes.
- **Managed-only tap** — non-managed rows lack tmuxTarget; attaching
  to a raw PID isn't well-defined. Muted "untracked" badge surfaces
  the distinction without ceremony.
- **PtyViewer is the single attach surface** — don't add a parallel
  PtyAttachView. Flip the existing delegate to send-on-input.
- **External terminal (Ghostty) is OUT OF SCOPE** — Leo's preference
  was inline PtyViewer with input. Ghostty deeplink can come later as
  a per-row context menu action.
- **Stream + send share the session id** — same identity, just
  bidirectional. No new identifiers.

## Out of Scope

- Multi-session split-pane PtyViewer (one at a time for now).
- Scrollback persistence (SwiftTerm scrollback is per-mount).
- Mouse forwarding to tmux.
- Session creation from the dashboard (spec endpoint exists; UI is
  a separate spec).
- Sessions tab on iOS/watchOS (terminal infra exists; routing UX is
  cross-platform follow-up).
