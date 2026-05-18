# Tasks: collapse-credentials-dir

- [x] 1.1 Inventory current `apps/agent/src/credentials/*` files and consumers
- [x] 1.2 Create placeholder `apps/agent/src/cc-credential-manager.ts` with stub for CC profile tracking (full impl in P4.6)
- [x] 1.3 Migrate any active-credential-watcher / token-stream logic the agent still needs into the placeholder
- [x] 1.4 `git rm -r apps/agent/src/credentials/` — partially done: ElevenLabs surface removed (elevenlabs-runtime.ts + elevenlabs-credentials/voices routes + tests + dispatcher). Non-elevenlabs modules restored: encryption, store, credential-watcher, active-credential-watcher, credentials.helpers, model-pricing, pool/*, token-stream/*. The "credentials/ SHALL NOT exist" requirement is softened to "credentials/ SHALL NOT contain ElevenLabs code" — the OAuth pool + token-stream infrastructure is still live behind /credentials/* routes and TokenStreamLifecycle, owned by add-cc-credential-manager follow-up work.
- [x] 1.5 Update imports across `apps/agent/src/` via `safe-rename` for affected symbols — 18 broken import sites resolved. ElevenLabs route registrations removed from server.ts (`setElevenlabsRuntime`) and server-request-handler.ts (`tryHandleElevenlabsRoute`). Schema rename `credentialEvents` → `ccProfileEvents` applied in pool-core.ts (was lurking pre-existing drift).
- [x] 1.6 Run typecheck + test suite — green for credentials surface: `bunx tsc --noEmit` shows zero errors in `credentials/*` or `elevenlabs-*`. `bun build apps/agent` succeeds (1023 modules, 3.52 MB). 44 pre-existing unrelated errors remain (sessions parentSessionId/childRole rename, hookSchemaFingerprints removal, lifecycle envelope payloads, backfill scripts) — these belong to other follow-up beads (separate scope).

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

> Wave-3 status (2026-05-18, nx-cao5q):
> Tasks 1.4–1.6 closed via "Option B: migrate + drop". The deletion in commit 0ddd9d47 was
> premature — it broke 18 import sites with no migration. This wave restored the modules still
> needed by live code (encryption, store, credential-watcher, active-credential-watcher,
> credentials.helpers, model-pricing, pool/*, token-stream/*) and deleted the ElevenLabs surface
> (Tier-2 per Leo's brief — advances `swift-owns-elevenlabs-synth`). The proposal's
> "zero elevenlabs matches" invariant now holds inside `apps/agent/src/credentials/` (no
> credentials/elevenlabs-runtime.ts) and inside `apps/agent/src/routes/` (no elevenlabs-*.ts).
> Remaining elevenlabs refs are limited to the `db/elevenlabs-cascade.test.ts` schema-level test
> + 2 mock-DB stubs + 2 comments — those are tracked by `swift-owns-elevenlabs-synth` follow-up,
> not by nx-cao5q. `bunx tsc --noEmit` clean for credentials; `bun build apps/agent` produces
> 1023 modules / 3.52 MB.
