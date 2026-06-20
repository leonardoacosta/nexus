# Design — Mac Presence Observer (Phase 1.5)

## Context

Extends the Phase 1 `context-aware-routing` spine (already on `main`). Additive and still gated by
`presence_aware_routing` (default off). Reference: `docs/diagrams/presence-routing-research.html`
§1 (mac signals), §7 (phase plan), Q5 (Tailscale home).

## Goals / Non-Goals

**Goals**
- A 24/7 headless Mac sensor (`nexus-presence` LaunchAgent) feeding the vector — no dashboard dependency.
- Agent-side Tailscale `phone_home` (zero iOS permission).
- Rule 4 room-TTS on the local Mac.

**Non-Goals (later phases)**
- Cross-machine delivery / fleet presence gossip / fleet-merge tie-break (Phase 1.6).
- iOS reporting, watch, Rule 0/critical, rate/digest (Phases 2-4).
- SSID-based home (needs Location TCC) — gateway-MAC is the headless-safe corroborator here.

## Key Decisions

### Headless LaunchAgent, not the Dock app, not a Bun fallback
`nexus-mac` is `LSUIElement=false` (regular Dock app, opened manually) — unsuitable as an always-on
sensor. A dedicated `nexus-presence` executable run by launchd (`RunAtLoad`+`KeepAlive`, bootstrapped
into `gui/501`) senses continuously with no UI. The Aqua session context is REQUIRED: CMIO camera /
CoreAudio mic `IsRunningSomewhere` need the GUI session (the same `gui/501` bridge the ios-deploy /
swift-deploy agents already use). This gives full sensing — including meeting detection — so the
previously-considered Bun shell fallback (which cannot read camera/mic) is unnecessary and dropped.

### Sensing lives in NexusShared
A `PresenceObserver` in `NexusShared/Observers` (sibling to `NowPlayingController`) holds the
listeners (idle, lock DistNote, CMIO/CoreAudio property listeners, Focus-DB FSEvents, gateway-MAC).
The `nexus-presence` executable is a thin `main.swift` that starts it and wires its callbacks to a
`NexusClient` POST. Keeping logic in NexusShared makes it unit-testable in `NexusSharedTests`.

### Home via gateway-MAC, not SSID
SSID (`CWWiFiClient`) needs Location Services auth — a TCC prompt with no headless UI path. The
gateway-MAC fingerprint (ARP of the default route) is permission-free and stable for a fixed home
network. It is only a corroborator anyway; the primary `phone_home` is agent-side Tailscale (Q5).

### Tailscale poller on the agent
`apps/agent/src/services/tailscale-presence.ts` shells `tailscale status --json` on a low-frequency
interval (a few seconds), classifies the phone peer (LAN-direct = home), and reports
`phonePresent`/`phoneHome` into `presence-context`. Reuses the read-only Tailscale dependency the
fleet already has (`agent-registry.ts` references it).

## Data Flow

```text
nexus-presence (LaunchAgent, gui/501)        agent (apps/agent)
  PresenceObserver (NexusShared)
    idle/lock/console/cam/mic/Focus/gw-MAC  --POST /presence/report-->  presence-context
                                            tailscale-presence poller -->  (phonePresent/phoneHome)
                                                                            |
                                            rules-engine: + Rule 4 (room-TTS to macHost)
```

## Risks / Trade-offs

- **CMIO from a LaunchAgent:** confirmed workable — LaunchAgents in `gui/501` have Aqua context
  (the swift-deploy agent already runs signed builds there). If a future macOS tightens CMIO for
  non-foreground processes, meeting detection degrades to `unknown` (fail-safe), not a crash.
- **Focus-DB schema drift:** the `~/Library/DoNotDisturb/DB` format shifts per macOS major; parse
  fail-open (don't suppress on unknown).
- **launchd install codesign gate:** the new executable must be signed; the existing `gui/501`
  swift-deploy bridge handles signed Mac builds (proven in Phase 1's UI batch). Headless SSH build
  typechecks; the signed install runs via the Aqua deploy agent.
- **Battery:** event-driven listeners + a low-frequency gateway-MAC/Tailscale poll — negligible.
