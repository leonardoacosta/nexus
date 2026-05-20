# Tasks: homelab-emits-specs-credentials

<!-- beads:epic:nx-jfd9i -->
<!-- beads:feature:nx-sbu7f -->

## API Batch

- [ ] [1.1] Audit current spec-watcher state — read `apps/agent/src/services/spec-watcher/poller.ts` + `parser.ts` + `config.ts`. Document: what workspace roots are currently configured, what scan paths are evaluated, why `GET /specs` returns empty on the deployed agent today (homelab has many specs under `/home/nyaptor/dev/nx/openspec/changes/`). Capture findings in a notes block in the spec dir [owner:api-engineer] [type:feature] [beads:nx-3e2nq]
- [ ] [1.2] [P-1] Add `apps/agent/src/services/spec-watcher/config.ts` (if missing) that reads `~/.config/nexus/spec-watcher.toml` for `roots` array, defaulting to `[~/dev]`. Expose `resolveRoots()` that glob-expands `~/dev/*/openspec/changes/` into actual directory URLs [owner:api-engineer] [type:feature] [beads:nx-ydfir]
- [ ] [1.3] [P-1] Fix `poller.ts` to scan the resolved roots on startup AND on the configured interval (default 60s). For each scan, enumerate `<root>/<project>/openspec/changes/<spec>/` and emit a SpecSnapshot per spec dir. Use `existsSync` for the has_* tri-state [owner:api-engineer] [type:feature] [beads:nx-ufmyu]
- [ ] [1.4] Update `apps/agent/src/services/spec-watcher/parser.ts` if needed so `parseSpecFromPath(dir)` returns the right shape including completedTasks/totalTasks from tasks.md grep [owner:api-engineer] [type:feature] [beads:nx-sejn1]
- [ ] [1.5] [P-2] Verify `apps/agent/src/routes/specs.ts` handleListSpecs surfaces the watcher's in-memory state correctly (no changes likely; just verification per agent-payload-completeness contract) [owner:api-engineer] [type:test] [beads:nx-3viv8]
- [ ] [1.6] Add `apps/agent/src/services/credential-pool/reader.ts` — `readCredentials(dir: string): { credentials: CredentialEntry[], activeFingerprint: string | null }`. Resolve dir from `$HOME/.claude/.credentials/`. For each file, parse + project to wire shape (fingerprint, account, created_at, status) [owner:api-engineer] [type:feature] [beads:nx-1xv6w]
- [ ] [1.7] Investigate CC's active-credential convention on disk (symlink? marker file? env var?). Document the actual mechanism in a comment block in reader.ts. Use the discovered mechanism for activeFingerprint detection [owner:api-engineer] [type:feature] [beads:nx-mfqra]
- [ ] [1.8] [P-3] Update `apps/agent/src/routes/credentials.ts` handleListCredentials to invoke the new reader (the current handler returns the empty default — confirmed via curl 2026-05-20) [owner:api-engineer] [type:feature] [beads:nx-8wja6]
- [ ] [1.9] Add contract tests `apps/agent/src/routes/specs.test.ts` (extend existing) asserting /specs returns non-empty when workspace contains a known spec dir. Use fixture tmpdirs to avoid relying on $HOME [owner:api-engineer] [type:test] [beads:nx-h50k5]
- [ ] [1.10] Add `apps/agent/src/routes/credentials.test.ts` (extend existing) asserting /credentials returns the right shape against a fixture credentials dir [owner:api-engineer] [type:test] [beads:nx-kkabi]

## UI Batch

- [ ] [2.1] Verify `apps/swift/nexus-mac/Sources/Dashboard/SpecsView.swift` already calls `fetchSpecs()` on mount (it does per the 2026-05-20 grep — line 156). No change needed; pure verification [owner:ui-engineer] [type:test] [beads:nx-2qph5]
- [ ] [2.2] Verify `apps/swift/nexus-mac/Sources/Dashboard/CredentialsView.swift` already calls `fetchCredentials()` on mount (it does — line 172). No change [owner:ui-engineer] [type:test] [beads:nx-wkmlv]
- [ ] [2.3] [P-1] If the SpecsView empty state copy is too generic ("No specs found"), update to mention waiting for the homelab spec-watcher to scan. Minor copy polish [owner:ui-engineer] [type:feature] [beads:nx-6x1eu]

## E2E Batch

- [ ] [3.1] Deploy via homelab post-merge: `ssh nyaptor@100.73.182.4 'cd ~/dev/nx && git pull && systemctl --user restart nexus-agent'`. Verify agent restarts cleanly via `systemctl --user status nexus-agent` [owner:devops-engineer] [type:test] [beads:nx-tm1gl]
- [ ] [3.2] After homelab redeploy, curl `GET /specs` and `GET /credentials` via Tailscale, confirm both return non-empty payloads. Capture stdout for the audit trail [owner:devops-engineer] [type:test] [beads:nx-qvsm3]
- [ ] [3.3] [user] Open Nexus.app dashboard, navigate to Specs tab — should show the active proposals from homelab's `/home/nyaptor/dev/nx/openspec/changes/`. Navigate to Credentials tab — should show homelab's CC credential state. Capture screenshot of both views for the audit trail [user] [owner:user] [type:test] [beads:nx-sxrvy]
- [ ] [3.4] Update `openspec/specs/spec-watcher/spec.md` AND `openspec/specs/credential-pool/spec.md` post-archive [handled by Phase 4 archive] [owner:devops-engineer] [type:docs] [beads:nx-dt5bb]
