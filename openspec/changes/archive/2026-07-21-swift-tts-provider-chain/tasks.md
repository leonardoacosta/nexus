---
stack: t3
---

# Tasks: Swift TTS Provider Chain

## UI Batch

- [x] 1.1 Add `apps/swift/NexusShared/Synthesis/SpeechProvider.swift` — `public protocol SpeechProvider: Sendable { func synthesize(text: String, voice: String) async throws -> Data }` returning MP3 bytes, plus a `SpeechProviderError` enum mirroring `ElevenLabsError`'s cases (`notConfigured`, `http(Int, String)`, `decoding`).
- [x] 1.2 Add `apps/swift/NexusShared/Synthesis/KokoroClient.swift` — actor conforming to `SpeechProvider`; reads `kokoroBaseUrl` from `SettingsStore` per call (throws `.notConfigured` when empty); `POST {baseUrl}/v1/audio/speech` with JSON `{ "model": "kokoro", "input": text, "voice": voice, "response_format": "mp3" }`, `Accept: audio/mpeg`, 8s `URLRequest` timeout, no auth header; non-200 → `.http(status, snippet)`.
- [x] 1.3 Conform `ElevenLabsClient` to `SpeechProvider` via an extension that maps `synthesize(text:voice:)` onto the existing `ElevenLabsSynthRequest` path (default model id unchanged; existing API untouched).
- [x] 1.4 Rework `TTSObserver.synthesise()` (`apps/swift/NexusShared/Observers/TTSObserver.swift`) to walk an ordered provider chain: `[kokoro, elevenLabs]` filtered by configuration (Kokoro: non-empty base URL; ElevenLabs: Keychain key + resolved voice id per the existing resolution chain). Per attempt: undersized payload (<1024 bytes) or throw → log reason, next provider; success → `playMP3(data:)`; chain exhausted → `speakSystem(body:)`. Kokoro's voice argument resolves `settings.kokoroVoice` falling back to `"af_heart"`; the existing project/Keychain/Settings voice resolution keeps applying to the ElevenLabs attempt only. Add `kokoroBaseUrl`/`kokoroVoice` (UserDefaults-backed, keys `nx.tts.kokoro.baseUrl` / `nx.tts.kokoro.voice`) to `apps/swift/NexusShared/Storage/SettingsStore.swift` and a Kokoro section (two text fields, inline caption noting the Tailscale URL) to `apps/swift/nexus-mac/Sources/Dashboard/Settings/SettingsTtsView.swift`.
- [x] 1.5 Unit tests in `apps/swift/NexusSharedTests`: with stubbed `SpeechProvider`s — Kokoro success short-circuits ElevenLabs; Kokoro throw and Kokoro undersized payload each advance to ElevenLabs; both providers failing lands on system speech; empty base URL skips the Kokoro attempt entirely (no request); `KokoroClient` request body/URL shape golden test via a stubbed `URLProtocol`.
- [x] 1.6 Typecheck gate: from Linux, run the headless Mac typecheck (`ssh mac` + `swiftc -typecheck` over NexusShared and nexus-mac sources per the swift-engineer contract) and paste passing output; zero errors.

## User Gate

- [ ] 2.1 [user:post] On-device verification on the Mac (audio-bound): configure the homelab Kokoro base URL in Settings, fire a test notification, confirm the Kokoro voice plays with ducking and an AirPods press cancels; stop the Kokoro container and confirm audible fallback to ElevenLabs (key present) and to system speech (key removed); clear the base URL and confirm behavior matches today's. searched: nx open beads + mac-tts-listener spec scenarios + archived swift-owns-elevenlabs-synth for an existing multi-provider audio verification checklist; existing checklists cover the ElevenLabs-only path, none exercises a provider chain — new manual step required.
