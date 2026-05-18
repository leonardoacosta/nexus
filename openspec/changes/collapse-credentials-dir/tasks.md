# Tasks: collapse-credentials-dir

- [x] 1.1 Inventory current `apps/agent/src/credentials/*` files and consumers
- [x] 1.2 Create placeholder `apps/agent/src/cc-credential-manager.ts` with stub for CC profile tracking (full impl in P4.6)
- [x] 1.3 Migrate any active-credential-watcher / token-stream logic the agent still needs into the placeholder
- [ ] 1.4 `git rm -r apps/agent/src/credentials/` — DEFERRED to follow-up
- [ ] 1.5 Update imports across `apps/agent/src/` via `safe-rename` for affected symbols — DEFERRED to follow-up
- [ ] 1.6 Run typecheck + test suite — green — DEFERRED to follow-up

> Wave-1 status (2026-05-17): tasks 1.3–1.6 blocked. The `apps/agent/src/credentials/` tree has ~40
> external import sites (db/index.ts, index.ts, server.ts, routes/credentials/**, routes/elevenlabs-*,
> notifications/channels/tts.ts, scripts/{import,probe,backfill}-*). Most are ElevenLabs-coupled and
> are owned by `swift-owns-elevenlabs-synth` (P4.5) + `add-cc-credential-manager` (P4.6), which must
> land first. Task 1.2 placeholder is in place; the full collapse should be re-batched after P4.5 + P4.6.

> Wave-2 status (2026-05-17, post-P4.5+P4.6):
> Task 1.3 closed — `cc-credential-manager.ts` is now the full active manager (active OAuth refresh,
> 429 swap, schema-drift). It re-exports `getActiveCredentialSnapshot` from
> `./credentials/active-credential-watcher` so existing consumers (Mac settings page, statusline)
> keep working without import-site changes.
>
> Tasks 1.4–1.6 remain deferred. Removing `credentials/` outright in this batch would orphan ~16
> elevenlabs-* import sites (`routes/elevenlabs-credentials.ts`, `routes/elevenlabs-voices.ts`,
> `server-routes-elevenlabs.ts`, `notifications/channels/tts.ts`, several tests + scripts) — those
> belong to follow-up specs that retire the agent-side ElevenLabs surface entirely. Filed under
> "spine-migration cleanup" — see `remove-notification-channels` (P4) which removes the TTS channel
> consumer and unblocks `credentials/elevenlabs-*` removal.
