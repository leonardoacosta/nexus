# Superseded

This change was archived as superseded on 2026-05-17 by the spine-migration
P4 sub-features:

- `swift-owns-elevenlabs-synth` (P4.5 · merged) — moves ElevenLabs API key
  ownership from the agent's encrypted-at-rest `elevenlabs_credentials`
  table into Keychain on the Mac, and synthesis from a fire-and-forget
  agent route into a direct `ElevenLabsClient` call from the Mac.
- `remove-notification-channels` (P4.7 · merged) — deletes the agent's
  `notifications/channels/{tts,desktop}.ts` so the agent no longer owns
  any side-effect dispatch. The signal-only TTS channel emits a pure
  lifecycle bus event that the Mac listener consumes via SSE.

The legacy Bun `nexus-listener.ts` was decommissioned. Its cancel-on-click
semantics (kill the active utterance when the user clicks the banner) are
ported into `deploy/nexus-notifier.sh` via a cross-process PID-file IPC
(`$HOME/Library/Application Support/nexus/current-utterance.pid`). See
the comment block at deploy/nexus-notifier.sh:67-70 for the wiring.

The five incomplete tasks at archive time (16/21) were the FIFO-listener
implementation that consolidate-mac-tts-listener proposed. Those are
moot under the spine-migration architecture — synthesis no longer lives
on the agent, so there's no FIFO to drain. The remaining behavioral
requirements (cancel-on-click, ducking, banner-only fallback) are
satisfied by deploy/nexus-notifier.sh and the swift-owns-elevenlabs-synth
+ remove-notification-channels surface.

The corresponding spec at `openspec/specs/mac-tts-listener/` documents
the listener contract that survived consolidation; future work targets
that spec rather than the archived proposal.
