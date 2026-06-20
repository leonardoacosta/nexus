<!-- beads:epic:nx-i4sp1 -->
<!-- beads:feature:nx-1qtn4 -->

# Tasks — Mac Presence Observer (Phase 1.5)

## API Batch

- [x] Extend `PresenceVector` in `packages/core/src/types/presence.ts` with `phonePresent`, `phoneHome`, `macIdleSec`, `macFocus` (each a TTL'd `PresenceField`) — non-breaking widening; keep Phase 1 fields intact [beads:nx-gl5ta]
- [x] Create `apps/agent/src/services/tailscale-presence.ts` — low-frequency poller shelling `tailscale status --json`, classify the phone peer (LAN-range RFC1918 direct endpoint = home; public/DERP = away; absent = not present), report `phonePresent`/`phoneHome` into presence-context [beads:nx-46rl1]
- [x] Update `apps/agent/src/notifications/presence-context.ts` to accept/merge the new phone + mac fields with per-field TTLs (phone ~2min) and `unknown`-past-TTL reads [beads:nx-mupjp]
- [x] Add Rule 4 to `apps/agent/src/notifications/rules-engine.ts` — `(NOT macActive OR macLocked) AND phonePresent AND phoneHome` → `{ tts, deliverTo:[macHost] }`; insert AFTER the bedtime rule and BEFORE the phone-away rule; apply the non-critical fail-safe when `phoneHome` is `unknown` [beads:nx-bx513]
- [x] Extend `apps/agent/src/routes/presence-report.ts` to accept the new sensor fields (macIdleSec, macFocus, inMeeting, gateway-MAC home hint) and merge them into the vector [beads:nx-e8r5x]
- [x] Wire the Tailscale poller into agent boot (start/stop with the agent lifecycle; reuse the existing read-only tailscale dependency referenced by `agent-registry.ts`) [beads:nx-qw1dc]

## UI Batch

- [ ] Create `apps/swift/NexusShared/Observers/PresenceObserver.swift` — reusable sensor (sibling to `NowPlayingController`): HID idle, `com.apple.screenIsLocked` DistNote + `CGSession` console, CMIO camera + CoreAudio mic `IsRunningSomewhere` listeners, `~/Library/DoNotDisturb` Focus + FSEvents (fail-open parse), gateway-MAC home fingerprint; AND-gated meeting `(camera OR mic) AND frontmost meeting app`; exposes a delta callback [beads:nx-it4o7]
- [ ] Create `apps/swift/nexus-presence/Sources/main.swift` — headless executable: start `PresenceObserver`, POST deltas to the local agent `/presence/report` via `NexusShared.NexusClient` (qualify the type to avoid the legacy same-target `NexusClient` footgun) [beads:nx-kyrwi]
- [ ] Add the `nexus-presence` executable target to `apps/swift/project.yml` (link NexusShared; macOS; matching deployment target + signing config of the other Mac targets) [beads:nx-3a8xm]
- [ ] Create `deploy/launchagents/dev.leonardoacosta.nexus.presence.plist` — `Label dev.leonardoacosta.nexus.presence`, `RunAtLoad=true`, `KeepAlive=true`, `ProgramArguments` → the installed `nexus-presence` binary; document the `launchctl bootstrap gui/501` install (mirror the ios-deploy plist header) [beads:nx-ekcmc]
- [ ] Wire LaunchAgent install/refresh into the Mac deploy path (bootout-then-bootstrap `gui/501` for `dev.leonardoacosta.nexus.presence`), reusing the existing swift-deploy/launchagent install seam [beads:nx-ftt2o]

## E2E Batch

- [x] Extend `apps/agent/src/notifications/rules-engine.test.ts` with Rule 4: locked Mac + phone home → tts to macHost; phone away → no match (falls through); `phoneHome` unknown → fail-safe (no room-TTS); ordering after bedtime / before phone-away [beads:nx-kle43]
- [x] Create `apps/agent/src/services/tailscale-presence.test.ts` — feed representative `tailscale status --json` fixtures, assert LAN-direct → home, public/DERP → away, absent → not present [beads:nx-9wpll]
- [x] Extend `apps/agent/src/notifications/presence-context.test.ts` — phone-field merge, phone-TTL → unknown, mac sensor fields merge [beads:nx-blgj5]
- [ ] Create `apps/swift/NexusSharedTests/PresenceObserverTests.swift` — meeting AND-gate (camera-alone does NOT set inMeeting; camera+meeting-app does), lock/idle delta emission, Focus parse fail-open [beads:nx-41qha]
