# Mac Presence Observer — Phase 1.5

## Why

Phase 1 (`context-aware-routing`, archived) shipped the presence *spine* — the `PresenceVector`,
the rules engine, the durable held queue — but nothing actually *senses* the Mac. Presence only
arrives via the `POST /presence/report` endpoint, so Rule 1 (active-Mac TTS) and Rule 2
(meeting-hold) never fire on their own. The vector also has no `phone_home` signal, so Rule 4
(speak into the room when the Mac is locked but you're home) cannot exist yet.

This phase makes the engine *react*. It adds:
1. A real Mac sensor that auto-populates the vector (idle, lock, console, camera/mic meeting
   detection, Focus, home-network fingerprint).
2. Agent-side home detection via Tailscale — `phone_home` with **zero iOS permission** (decision
   Q5), running on always-on agent hardware.
3. Rule 4 — room-TTS on the local Mac when it's locked/idle but you're present at home.

**The sensor is a dedicated headless LaunchAgent, not the dashboard app.** `nexus-mac` is a
regular Dock app (`LSUIElement=false`) the user opens manually — presence must not depend on it
being open. A small `nexus-presence` Swift executable, run by launchd (`RunAtLoad` + `KeepAlive`)
inside the user's Aqua session (`gui/501` — required for CMIO camera/mic access), senses
continuously and POSTs to the local agent. No Dock, no window, 24/7.

Cross-machine delivery (a notification from Mac A reaching you at Mac B) is **deferred to Phase
1.6** — it needs fleet presence gossip and is a separable chunk.

## What Changes

- **`nexus-presence` LaunchAgent** (new Swift executable) — senses on the local Mac: idle
  (`CGEventSource`/`ioreg`), lock + console (`com.apple.screenIsLocked` DistNote / `CGSession`),
  camera + mic in-use (CMIO / CoreAudio `IsRunningSomewhere`), Focus/Sleep (`~/Library/DoNotDisturb`
  + FSEvents), and a permission-free **gateway-MAC** home fingerprint (NOT SSID — that needs a
  Location TCC prompt that's awkward headless). Meeting = `(camera OR mic) AND (frontmost meeting
  app)` AND-gated (Q2). It POSTs deltas to the local agent's `/presence/report`.
- **Sensing in `NexusShared`** — a reusable `PresenceObserver` (sibling to the existing
  `NowPlayingController`/`SessionObserver`) the executable drives, so the logic is testable.
- **Tailscale home detection** (agent-side) — a poller reads `tailscale status --json`; a phone
  peer with a LAN-range direct endpoint = home, public/DERP = away. Sets `phone_present` /
  `phone_home`. No iOS permission, no battery cost.
- **Presence vector phone fields** — extend `PresenceVector` with `phonePresent`, `phoneHome`
  (and `macIdleSec`, `macFocus`) — a non-breaking widening (the Phase 1 vector comment already
  anticipates this).
- **Rule 4** — `(NOT macActive OR macLocked) AND phonePresent AND phoneHome` → `{ tts,
  deliverTo:[macHost] }` (room-TTS on the local Mac). Slots between Rule 3 and Rule 5 per the
  locked rule order.
- **launchd install** — a `dev.leonardoacosta.nexus.presence` plist (`RunAtLoad`+`KeepAlive`,
  bootstrapped into `gui/501`) + deploy wiring to install/refresh it.

**Decisions implemented:** cross-machine DEFERRED to 1.6 · Mac sensing via a headless launchd
LaunchAgent (not the Dock app, not a Bun fallback) · home via agent-side Tailscale (Q5) · Rule 4
room-TTS · gateway-MAC over SSID (permission-free headless).

## Impact

- Affected capability: `context-aware-routing` (existing — extends Phase 1)
- New always-on process on each Mac (`nexus-presence` LaunchAgent). Lightweight (event-driven
  listeners + low-frequency poll); respawned by launchd if killed.
- New runtime dependency: the agent shells `tailscale status --json` (read-only, already a fleet
  dependency).
- Behavioral change only when `presence_aware_routing` is ON (still default off) — Rule 4 begins
  firing room-TTS. No change to the default path.
- The Mac sensor only emits presence; it never delivers — delivery stays in the agent.

## Context
- depends on:
- touches: `packages/core/src/types/presence.ts`, `apps/agent/src/notifications/rules-engine.ts`, `apps/agent/src/notifications/presence-context.ts`, `apps/agent/src/services/tailscale-presence.ts`, `apps/agent/src/routes/presence-report.ts`, `apps/swift/NexusShared/Observers/PresenceObserver.swift`, `apps/swift/nexus-presence/Sources/main.swift`, `apps/swift/project.yml`, `deploy/launchagents/dev.leonardoacosta.nexus.presence.plist`, `apps/swift/NexusSharedTests/PresenceObserverTests.swift`
