# Tasks: supersede-mac-tts-listener-spec

- [x] 1.1 Confirm P4.5 + P4.7 are fully merged and Swift app handles banner-click-cancel (deploy/nexus-notifier.sh:67-70 — cancel-on-click ported via current-utterance.pid IPC; P4.5 swift-owns-elevenlabs-synth and P4.7 remove-notification-channels both merged in wave 1+2)
- [x] 1.2 Run the project's openspec archive command on consolidate-mac-tts-listener (archived as openspec/changes/archive/2026-05-18-consolidate-mac-tts-listener/ via `pnpm openspec archive consolidate-mac-tts-listener --yes --no-validate`; 5 incomplete FIFO-listener tasks moot under the spine architecture)
- [x] 1.3 Append a SUPERSEDED.md note to the archived dir explaining the move (openspec/changes/archive/2026-05-18-consolidate-mac-tts-listener/SUPERSEDED.md — documents the P4.5+P4.7 supersession and the cancel-on-click port to nexus-notifier.sh)
- [x] 1.4 bd close nx-69d9s --reason="Superseded by spine-migration P4" (closed 2026-05-18 with full reason citing the archive path)
- [x] 1.5 bd close any open tasks under nx-69d9s with same reason (verified via `bd list --parent=nx-69d9s` — no open children; nothing to close)
