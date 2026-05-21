# Tasks: fix-credential-source-divergence

<!-- beads:epic:nx-hnkty -->
<!-- beads:feature:nx-bylxt -->

## API Batch

- [x] 1.1 `apps/agent/src/cc-credential-manager.ts` — change
  `DEFAULT_CREDENTIALS_PATH` (line ~39) and the `CC_CREDENTIALS_PATH` env
  default to `~/.claude/.credentials.json` (leading dot). Grep the credential
  subsystem for any other no-dot `credentials.json` literal and reconcile;
  keep `active-credential-watcher.ts` (already dotted) as the reference. [beads:nx-cnuba]
- [x] 1.2 Designate the canonical source for `GET /credentials`: make
  `handleListCredentials()` (`apps/agent/src/routes/credentials/handlers-crud.ts`)
  surface the real active credential read from `~/.claude/.credentials.json`
  (e.g. consult the `active-credential-watcher` snapshot/fingerprint, not only
  `pool.list()`), so the endpoint is non-empty when a valid `.credentials.json`
  exists and `activeFingerprint` is populated. Pick the minimal cleanest wiring
  per design.md; do not invent a new table. [beads:nx-lofdc]
- [x] 1.3 Ensure the schema-fingerprint check passes against the real file
  shape (`claudeAiOauth.*`); if the real `.credentials.json` is a symlink,
  resolve it (mirror `active-credential-watcher`'s realpath handling). No
  schema-drift false positive for a valid file. [beads:nx-x6wjf]

## E2E Batch

- [ ] [deferred] 2.1 Verify on the homelab agent (which has `~/.claude/.credentials.json`,
  1699 bytes): restart/redeploy the agent, then `GET /credentials` returns a
  non-empty result with non-null `activeFingerprint`; the dashboard Credentials
  view shows the real active credential. Paste the curl/JSON proof. [beads:nx-dt4rt]
  (Deferred — operator verification against a deployed homelab agent, not
  an automated test. Requires curl/dashboard inspection by Leo on the real
  deployment. /apply:all Phase 4 will file a P4 backlog issue.)
- [ ] [deferred] 2.2 Negative check: with no `~/.claude/.credentials.json`, `GET
  /credentials` returns an explicit empty result (not a 500/error). [beads:nx-c28wt]
  (Deferred — operator verification against a deployed agent in a
  no-credential configuration. /apply:all Phase 4 will file a P4 backlog
  issue.)
