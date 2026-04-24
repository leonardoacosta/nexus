# restore-tts-mac-audio-dispatch — Change Proposal

## Summary

Restore ElevenLabs TTS call on the agent side and wire the synthesized mp3 audio through the `NotificationFired` lifecycle event so the Mac-side listener (`~/bin/nexus-notifier.sh`, deployed from `deploy/mac/nexus-notifier.sh`) can render it via `afplay`. The "notifier (Mac)" role described in `project.md` becomes operational: Linux generates speech centrally, Mac plays the audio natively. Also fix the underlying bug that previously caused ElevenLabs responses to be fetched and discarded — the mp3 body was never routed anywhere playable because the homelab agent is headless.

## Motivation

**Observed (2026-04-24):** After the `/workflow:evolve` → nexus socket migration landed, a live audit of the notification pipeline revealed three stacked bugs:

1. `apps/agent/src/notifications/router.ts:44-50` — `DEFAULT_RULES` forced `channels: ["desktop"]`, causing every `channel="tts"` POST to dispatch to the desktop handler. **(Fixed in place 2026-04-24 — caller-channel fallback added.)**
2. `apps/agent/src/notifications/channels/tts.ts` (pre-2026-04-24) — fetched ElevenLabs mp3 bytes and discarded them; the agent runs headless on homelab so there is no audio sink locally.
3. `apps/agent/src/notifications/channels/tts.ts` (post-2026-04-24 refactor) — introduced a `NEXUS_TTS_USE_ELEVENLABS=1` gate that defaults OFF, which suppressed the ElevenLabs call entirely and turned TTS into a log-only signal. The Mac listener, added the same day, fell back to macOS built-in `say` because no audio reached it.

**Root cause:** The 2026-04-24 refactor confused the architectural question ("where does audio generate?") with the implementation convenience ("Mac speaks locally to avoid wasting quota"). `project.md` names the Mac as the *notifier* role — the machine with speakers, not the machine that owns the ElevenLabs contract. The agent remains the sole holder of `ELEVENLABS_API_KEY` and the sole point of quota accounting.

**Architecture decision (Option A from the 2026-04-24 design discussion):**

```
CC hook  →  POST /notifications/send  (body, channel="tts")
agent    →  ElevenLabs API  →  mp3 bytes (base64)
agent    →  lifecycleBus.emit("NotificationFired", { audioBase64, … })
agent    →  GET /events/stream  (SSE — already shipped)
Mac      →  decode base64 → /usr/bin/afplay
```

Centralization rationale:
- One API key, one quota, one point of failure to debug.
- If a second listener (iPad, iPhone) joins later, it gets the same cached bytes — no extra ElevenLabs charges.
- Mac listener stays dumb — pure transport + `afplay`, no secret, no HTTP egress.

## Requirements (ADDED)

### TTS channel MUST call ElevenLabs and attach audio to the lifecycle event

When `sendTtsNotification` is invoked with `ELEVENLABS_API_KEY` set, the channel MUST POST the composed text (project-prefixed per the existing `fix-tts-announce-project-prefix` spec) to `https://api.elevenlabs.io/v1/text-to-speech/<voiceId>`, capture the response body as binary mp3 bytes, and make those bytes available on the subsequent `NotificationFired` lifecycle event. The agent MUST NOT attempt to play the audio locally. Playback is the listener's responsibility.

When `ELEVENLABS_API_KEY` is unset, the channel MUST still mark the notification as delivered and emit `NotificationFired` without an audio attachment, so rule-only listeners (future: slack-bridge, mobile) still fire. The Mac listener in this mode MAY fall back to `say` as a best-effort render or MAY skip entirely — that choice is codified in the Mac listener spec, not the agent spec.

### NotificationFired payload MUST carry optional audio bytes

The `NotificationFiredPayload` TypeScript type MUST include an optional `audioBase64?: string` field alongside the existing `id`, `title`, `body`, `channel`, `project`, and `message` fields. When present, the value MUST be the base64 encoding of the raw mp3 bytes received from ElevenLabs. When absent, listeners MUST treat the notification as text-only.

The base64-encoded field takes precedence over any future URL-based transport — inline bytes are correct for starter-tier message sizes (ElevenLabs starter cap ≈ 500 chars → ≈ 50-80 KB mp3 → ≈ 70-110 KB base64). A URL-based transport MAY be added later (via `audioUrl?: string`) but is out of scope here.

### Mac listener MUST decode and play audio via `afplay`

The Mac-side listener (`deploy/mac/nexus-notifier.sh`) MUST on receipt of a `NotificationFired` SSE frame with `channel === "tts"` and `audioBase64` present:
- Base64-decode the payload to a tmp file (`/tmp/nexus-notifier-<uuid>.mp3`)
- Invoke `/usr/bin/afplay` on that file, backgrounded so the SSE reader continues
- Delete the tmp file after `afplay` completes (cleanup via trap or child-process-cleanup loop)

When `audioBase64` is absent on a `channel="tts"` event, the listener MUST skip playback silently — no fallback to `say`. A separate proposal (`add-notification-control-dashboard`) will introduce a user toggle to re-enable `say` as an opt-in fallback.

### Agent deploy assets ship the Mac listener canonically

The Mac listener script MUST live at `deploy/mac/nexus-notifier.sh` in the nx repo with a companion `deploy/mac/com.nexus.notifier.plist`. `install.sh` MUST be extended with a `--mac` flag (or a sibling `install-mac.sh`) that scp's the script to `~/bin/nexus-notifier.sh` on the target Mac, installs the plist to `~/Library/LaunchAgents/`, and runs `launchctl load`. This gives the Mac listener the same deploy parity as the Linux systemd unit already enjoys.

## Scope

**IN:**
- `apps/agent/src/notifications/channels/tts.ts` — restore ElevenLabs call; default to ON when key is set; capture mp3 bytes; pass through to `NotificationFired` payload.
- `apps/agent/src/notifications/manager.ts` — thread the `audioBase64` field from the channel result into `lifecycleBus.emit("NotificationFired", …)`. Current code emits with fixed fields; needs extension.
- `apps/agent/src/services/lifecycle-bus.ts` — extend `NotificationFiredPayload` with optional `audioBase64?: string`.
- `apps/agent/src/notifications/channels/tts.test.ts` — extend coverage: ElevenLabs called, mp3 body captured, bytes surface in lifecycle emit.
- `apps/agent/src/services/socket-server/dispatcher.ts` — audit the legacy socket-notification path for audio-bytes consistency. (The socket-server path still constructs `NotificationFired` with a stub row; decide whether the socket path also participates in audio dispatch or stays text-only.)
- `deploy/mac/nexus-notifier.sh` — new file. Subscribes to `/events/stream`, decodes base64 audio, pipes to `afplay`.
- `deploy/mac/com.nexus.notifier.plist` — new file. launchd agent definition.
- `deploy/install.sh` — extend with Mac deploy path.
- Remove `NEXUS_TTS_USE_ELEVENLABS` env var — no longer opt-in, ElevenLabs is the default when the key is present.

**OUT:**
- Notification dashboard page and settings controls — separate proposal `add-notification-control-dashboard`.
- ElevenLabs voice selection, model, prosody — stays at current defaults (`21m00Tcm4TlvDq8ikWAM` / `eleven_monolingual_v1`).
- `afplay` volume ducking, muting, half-level — deferred to the dashboard proposal where the setting originates.
- Slack channel changes — already correct.
- Caller migration in cc (`~/.claude/commands/*/*.md`, `~/.claude/skills/deploy-and-env/SKILL.md`) — tracked in cc repo as `migrate-socat-to-nx-notify`.
- Audio caching by body hash — a nice-to-have follow-up but not blocking.

## Impact

- **Behavioral:** TTS notifications audibly play on Mac via ElevenLabs voice (regression fix). No behavior change when the key is unset; no behavior change for the desktop or slack channels.
- **Wire:** Each TTS `NotificationFired` SSE frame grows by ~50-80 KB of base64 audio. Measured against the current `NotificationFired` frame (~300 bytes), this is a ~200x size increase per event. Event volume remains low (~dozens/day), so daily Tailscale traffic grows by <10 MB. Acceptable.
- **Security:** ElevenLabs key stays on homelab. No expansion of Mac's secret surface — Mac's `~/.env` gains `NEXUS_ATTACH_SECRET` only (already provisioned 2026-04-24).
- **Compatibility:** SSE subscribers written against the pre-2026-04-24 schema continue to work — the new `audioBase64` field is additive.
- **Rollback:** Revert is a single commit that removes the `audioBase64` field and the ElevenLabs call. Mac listener tolerates missing-field payloads; no data-layer changes.
