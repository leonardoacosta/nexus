---
order: 0720b
---

# Proposal: Swift TTS Provider Chain (Kokoro-First Synthesis)

## Change ID
`swift-tts-provider-chain`

## Why

The Mac listener is the sole owner of macOS TTS (`mac-tts-listener`), but its synthesis path is
hard-wired to two concrete types: `ElevenLabsClient` then `SystemSpeechSynthesizer`. Making
Kokoro audible — the actual point of replacing ElevenLabs (docs/local-tts-research.md) —
requires a provider seam. Kokoro-FastAPI speaks OpenAI's `/v1/audio/speech` and returns MP3,
so the existing `Data`-in → `MP3PlayerProtocol`-out contract (ducking, AirPods cancel, banner
ordering) survives untouched; only the synthesis step becomes an ordered chain.

## What Changes

- Add `SpeechProvider` protocol to `NexusShared/Synthesis`:
  `synthesize(text: String, voice: String) async throws -> Data` (MP3 bytes).
- Add `KokoroClient` actor conforming to it: `POST {baseUrl}/v1/audio/speech` with
  `{ model: "kokoro", input, voice, response_format: "mp3" }`, 8s timeout, no auth header
  (Tailscale-only server).
- Conform `ElevenLabsClient` via a thin adapter (existing `synthesize(_:)` untouched).
- `TTSObserver.synthesise()` walks an ordered provider chain — Kokoro (when a base URL is
  configured) → ElevenLabs (when a Keychain key is present) → system speech. The existing
  undersized-payload guard (<1024 bytes → treat as failure) applies per attempt.
- Settings: `SettingsStore` gains `kokoroBaseUrl` and `kokoroVoice` (UserDefaults — no
  secret, so no Keychain entry); `SettingsTtsView` gains a Kokoro section with both fields.
- Project voice overrides (`projectVoiceCache`) continue to apply to the ElevenLabs attempt
  only in this proposal; provider-qualified per-project voices land in
  `provider-qualified-project-voices`.

## Context

- depends on: `add-kokoro-integration-provider`
- touches: `apps/swift/NexusShared/Synthesis/SpeechProvider.swift`, `apps/swift/NexusShared/Synthesis/KokoroClient.swift`, `apps/swift/NexusShared/Synthesis/ElevenLabsClient.swift`, `apps/swift/NexusShared/Observers/TTSObserver.swift`, `apps/swift/NexusShared/Storage/SettingsStore.swift`, `apps/swift/nexus-mac/Sources/Dashboard/Settings/SettingsTtsView.swift`, `apps/swift/NexusSharedTests`

Swift-only change (NexusShared + nexus-mac Settings). No agent/API/DB surface touched.
Dispatch `swift-engineer` per-spec. The dependency on `add-kokoro-integration-provider` is
soft — this compiles and runs against any reachable Kokoro-FastAPI URL — but the deploy
artifact and dashboard config it references land there.

## Impact

- Affected specs: `mac-tts-listener` (MODIFIED: fallback requirement becomes an ordered
  provider chain; ADDED: Kokoro client contract + settings surface)
- Affected code: `TTSObserver.synthesise()` (chain walk), new `KokoroClient` +
  `SpeechProvider`, `SettingsStore`/`SettingsTtsView` additions.
- `AudioPlayer`, ducking, AirPods cancel, banner ordering, `SystemSpeechSynthesizer`, and
  iOS/watchOS no-op stubs all unchanged.

## Done Means

- With a Kokoro base URL configured in Settings, a `channel="tts"` notification is spoken in
  a Kokoro voice — no ElevenLabs request occurs.
- With Kokoro unreachable (server down), the same notification falls through to ElevenLabs
  (key present) or system speech (no key), and Console.app logs the per-provider failure
  reasons.
- With no Kokoro URL and no ElevenLabs key, behavior is byte-identical to today (system
  speech).
- Operator can set/clear the Kokoro base URL and voice from Nexus.app Settings without a
  restart.

## Testing

- Unit (`NexusSharedTests`): chain ordering with a stubbed `SpeechProvider` — Kokoro success
  short-circuits ElevenLabs; Kokoro failure/undersized payload advances to ElevenLabs;
  both-fail lands on system speech; unconfigured Kokoro (empty base URL) is skipped without
  an attempt (tasks 1.5).
- Machine gate: `ssh mac` + `swiftc -typecheck` over NexusShared + nexus-mac sources passes
  with zero errors (task 1.6).
- On-device: audible verification via the User Gate task (2.1) — Kokoro voice plays with
  ducking, AirPods press cancels, fallback chain audibly degrades when the server is
  stopped.
