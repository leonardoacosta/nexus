# Add Swift menu bar client for Nexus

## Why

Nexus already has a Next.js dashboard for deep inspection of sessions, but it lives in a browser
tab that's rarely the foreground app. The operator (Leo) spends most of the day in IDE/terminal,
not the dashboard. Three operational signals need to be glanceable without context-switching:

1. **Is homelab reachable right now?** — silent SSH failures are how we lost ~3 weeks of TTS
   delivery before debugging it (see commit `90fe06e` and the `restore-tts-mac-audio-dispatch`
   archive). A persistent menu bar indicator would have surfaced the outage on day one.

2. **What is homelab doing?** — CPU and RAM trend over the last 10 minutes tells you "build is
   running" / "build just finished" / "nothing is happening" without opening the dashboard.

3. **One-click jump to the active session.** — `open -na Ghostty.app --args -e "ssh -t … tmux
   attach …"` is the actual command Leo wants to run dozens of times per day. The menu bar
   collapses it to a click on a session row.

Today's `apps/swift/nexus/` is the unmodified Xcode SwiftUI+SwiftData template — a clean slate.
This proposal replaces the template `WindowGroup` with a `MenuBarExtra(.window)` scene and
builds a 320-pixel panel against the existing Nexus agent HTTP API.

## What Changes

**Pure UI work — zero changes to the agent, database, or notifications pipeline.** All required
endpoints already exist:

| Endpoint (existing) | Used by |
| --- | --- |
| `GET /health/history?hours=N` | Sparklines — CPU + RAM 10-min window |
| `GET /sessions` | Remote sessions list (filtered client-side to homelab origin) |
| `GET /sessions/{id}` | Resolve tmux window name before launching Ghostty |
| `GET /events/stream` (SSE) | Live updates (heartbeat, session start/end, NotificationFired) |
| `POST /notifications/settings` | TTS mute toggle |
| `POST /session/start` | `⌃⌥H` spawns a new homelab Claude Code session |

### New Swift app surface (under `apps/swift/nexus/`)

1. **Menu bar icon** — 22-px three-bar sigil with 5 state variants (active, idle, stale,
   unreachable, TTS-muted). Color encodes aggregate health.

2. **Panel scene** — 320×~440 px popover (`MenuBarExtra.window` style) with six locked regions:
   identity row, optional alert strip, metrics row (2 sparklines), remote sessions list,
   3-button action row. Wireframe locked in `docs/wireframes/nexus-menubar/index.html`.

3. **ATTACH action** — single click resolves `<sessionName>` then runs
   `open -na Ghostty.app --args -e "ssh -t nyaptor@homelab tmux attach \; select-window -t <name>"`.
   No submenu, no modifiers, no browser fallback.

4. **NOTIFY action** — popover with the in-app notification history (last 50 events, in-memory
   ring buffer fed by SSE, persisted to `NSUserDefaults` across launches).

5. **TTS action** — popover with mute / switch-provider / test-voice controls; POSTs to
   `/notifications/settings`.

6. **Hotkeys** — `⌃⌥N` summons the panel from anywhere; `⌃⌥H` opens Ghostty and spawns a fresh
   homelab Claude Code session via `POST /session/start`.

7. **Autostart** — first-run prompt to install a `com.nexus.menubar.plist` LaunchAgent so the
   app starts at login.

8. **Preferences** — separate Settings scene backed by `NSUserDefaults`. Sections: hotkeys, TTS
   defaults, autostart toggle, theme density.

## Out of Scope

- **Multi-peer federation UI.** This release assumes one remote (homelab). The wireframe is
  intentionally single-target.
- **Read-only browser-stream attach.** Dropped during refinement; ATTACH defaults straight to
  Ghostty + SSH + tmux. The dashboard `/session/[id]` page remains for deep inspection.
- **Copy attach URL action.** Dropped — there's only one transport now.
- **iOS / iPad target.** Swift project stays macOS-only.
- **New agent endpoints.** All capabilities consume the existing API surface.
- **Playwright e2e for `/session/[id]`** — already on the wishlist (see test-coverage gap noted
  in §03 of the wireframe), tracked separately.

## References

- **Wireframe** (locked): `docs/wireframes/nexus-menubar/index.html` — 4 panel states, 5 icon
  variants, 3 action-button anatomies, interaction spec.
- **Aesthetic direction**: operator-console / split-flap signage — phosphor-green accent
  (`#52FF8C`) on near-black substrate, JetBrains Mono throughout, restrained motion budget.
- **Adjacent in-progress**: `openspec/changes/consolidate-mac-tts-listener/` — operates on the
  bash listener, no overlap with this Swift client.
- **Existing tests that protect our consumption surface**:
  `apps/agent/src/terminal/stream.test.ts`, `server-websocket-*.test.ts`,
  `tests/e2e/attach-websocket.test.ts`. New Swift unit tests will cover the launcher subprocess
  invocation.
