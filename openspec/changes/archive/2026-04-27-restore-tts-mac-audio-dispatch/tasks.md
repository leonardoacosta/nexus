# Implementation Tasks

## Agent Batch (Linux, TypeScript)

- [x] [1.1] [P-1] Remove the `NEXUS_TTS_USE_ELEVENLABS` opt-in gate in `apps/agent/src/notifications/channels/tts.ts`. When `ELEVENLABS_API_KEY` is set, ElevenLabs is called by default. Restore the pre-refactor control flow. [owner:api-engineer]
- [x] [1.2] [P-1] In the same file, capture the ElevenLabs response body as `ArrayBuffer` → base64 string. Return it from `sendTtsNotification` via a structured return (not just `boolean`) so the manager can attach to `NotificationFired`. Change signature to `Promise<{ success: boolean; audioBase64?: string }>` — update router.ts callers and manager.ts consumer. [owner:api-engineer]
- [x] [1.3] [P-1] Extend `NotificationFiredPayload` in `apps/agent/src/services/lifecycle-bus.ts` with optional `audioBase64?: string`. Keep existing fields (`id`, `title`, `body`, `channel`, `project`, `message`) untouched for back-compat. [owner:api-engineer]
- [x] [1.4] [P-1] In `apps/agent/src/notifications/manager.ts` `deliverNotification`, accept per-channel payload metadata from `routeNotificationParallel` and include `audioBase64` in the `lifecycleBus.emit("NotificationFired", …)` call when the TTS channel returned audio. [owner:api-engineer]
- [x] [1.5] [P-2] Audit `apps/agent/src/services/socket-server/dispatcher.ts` for `NotificationFired` emission. Decide (and document inline) whether the socket path also carries audio or stays text-only. If text-only, ensure `audioBase64` is explicitly omitted from those emissions. [owner:api-engineer]
- [x] [1.6] [P-2] Remove dead references to the `NEXUS_TTS_USE_ELEVENLABS` env var across the repo (docs, service files, deploy scripts). [owner:api-engineer]

## E2E Batch (Linux, TypeScript)

- [x] [2.1] [P-1] Unit test `tts.ts` — mock `fetchWithTimeout` to return 60 bytes of mp3; assert returned object has `success: true` and `audioBase64` decoded-length equals 60. [owner:e2e-engineer]
- [x] [2.2] [P-1] Unit test `tts.ts` — no `ELEVENLABS_API_KEY`; assert `success: true`, `audioBase64` undefined, no fetch attempted. [owner:e2e-engineer]
- [x] [2.3] [P-1] Unit test `manager.ts` — given a channel result with `audioBase64`, assert the resulting `lifecycleBus.emit` envelope contains the field. [owner:e2e-engineer]
- [x] [2.4] [P-2] Integration test — POST `/notifications/send` with `channel: "tts"`; subscribe to `/events/stream` in the same test; assert a `NotificationFired` frame arrives within 5 s with `audioBase64` set and decodable. [owner:e2e-engineer]

## Mac Deploy Batch (bash + plist)

- [x] [3.1] [P-1] Create `deploy/mac/nexus-notifier.sh` — subscribes to `${NEXUS_URL}/events/stream` with `x-nexus-secret` header, parses SSE frames, on `NotificationFired` base64-decodes `audioBase64` to `/tmp/nexus-notifier-<uuid>.mp3`, invokes `/usr/bin/afplay` backgrounded, cleans up temp file. Reconnects with 5s backoff on stream drop. [owner:devops-engineer]
- [x] [3.2] [P-1] Create `deploy/mac/com.nexus.notifier.plist` — launchd agent definition matching the current ad-hoc version at `~/Library/LaunchAgents/com.nexus.notifier.plist`. RunAtLoad, KeepAlive, log to `~/Library/Logs/nexus-notifier.{out,err}.log`. [owner:devops-engineer]
- [x] [3.3] [P-2] Extend `deploy/install.sh` — add `--mac` flag. When invoked on Linux, SSH to a target Mac (host from `$MAC_HOST` or `$1`), scp the script, install the plist, run `launchctl load`. [owner:devops-engineer]
- [x] [3.4] [P-2] Document deploy flow in `deploy/README.md` (or create). Include secret provisioning (`ELEVENLABS_API_KEY` stays on Linux, `NEXUS_ATTACH_SECRET` on both). [owner:devops-engineer]

## Migration Batch

- [ ] [4.1] [P-1] [user] Remove the temporary Mac listener at `~/bin/nexus-notifier.sh` + `~/Library/LaunchAgents/com.nexus.notifier.plist` deployed 2026-04-24, replacing with the canonical version shipped via `deploy/install.sh --mac`. Verify launchd picks up the new plist and logs indicate successful startup. [owner:devops-engineer] **Deferred:** must run on Leo's Mac — see deploy/README.md § Migration: legacy say(1) listener → afplay listener for the four-step migration.
