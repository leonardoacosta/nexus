# Tasks: homelab-emits-specs-credentials

<!-- beads:epic:nx-jfd9i -->
<!-- beads:feature:nx-sbu7f -->

## API Batch

- [x] [1.1] Audit current spec-watcher state — read `apps/agent/src/services/spec-watcher/poller.ts` + `parser.ts` + `config.ts`. Document: what workspace roots are currently configured, what scan paths are evaluated, why `GET /specs` returns empty on the deployed agent today (homelab has many specs under `/home/nyaptor/dev/nx/openspec/changes/`). Capture findings in a notes block in the spec dir [owner:api-engineer] [type:feature] [beads:nx-3e2nq]
- [x] [1.2] [P-1] Add `apps/agent/src/services/spec-watcher/config.ts` (if missing) that reads `~/.config/nexus/spec-watcher.toml` for `roots` array, defaulting to `[~/dev]`. Expose `resolveRoots()` that glob-expands `~/dev/*/openspec/changes/` into actual directory URLs [owner:api-engineer] [type:feature] [beads:nx-ydfir]
- [x] [1.3] [P-1] Fix `poller.ts` to scan the resolved roots on startup AND on the configured interval (default 60s). For each scan, enumerate `<root>/<project>/openspec/changes/<spec>/` and emit a SpecSnapshot per spec dir. Use `existsSync` for the has_* tri-state [owner:api-engineer] [type:feature] [beads:nx-ufmyu]
- [x] [1.4] Update `apps/agent/src/services/spec-watcher/parser.ts` if needed so `parseSpecFromPath(dir)` returns the right shape including completedTasks/totalTasks from tasks.md grep [owner:api-engineer] [type:feature] [beads:nx-sejn1]
- [x] [1.5] [P-2] Verify `apps/agent/src/routes/specs.ts` handleListSpecs surfaces the watcher's in-memory state correctly (no changes likely; just verification per agent-payload-completeness contract) [owner:api-engineer] [type:test] [beads:nx-3viv8]
- [x] [1.6] Add `apps/agent/src/services/credential-pool/reader.ts` — `readCredentials(dir: string): { credentials: CredentialEntry[], activeFingerprint: string | null }`. Resolve dir from `$HOME/.claude/.credentials/`. For each file, parse + project to wire shape (fingerprint, account, created_at, status) [owner:api-engineer] [type:feature] [beads:nx-1xv6w]
- [x] [1.7] Investigate CC's active-credential convention on disk (symlink? marker file? env var?). Document the actual mechanism in a comment block in reader.ts. Use the discovered mechanism for activeFingerprint detection [owner:api-engineer] [type:feature] [beads:nx-mfqra]
- [x] [1.8] [P-3] Update `apps/agent/src/routes/credentials.ts` handleListCredentials to invoke the new reader (the current handler returns the empty default — confirmed via curl 2026-05-20) [owner:api-engineer] [type:feature] [beads:nx-8wja6]
- [x] [1.9] Add contract tests `apps/agent/src/routes/specs.test.ts` (extend existing) asserting /specs returns non-empty when workspace contains a known spec dir. Use fixture tmpdirs to avoid relying on $HOME [owner:api-engineer] [type:test] [beads:nx-h50k5]
- [x] [1.10] Add `apps/agent/src/routes/credentials.test.ts` (extend existing) asserting /credentials returns the right shape against a fixture credentials dir [owner:api-engineer] [type:test] [beads:nx-kkabi]

## UI Batch

- [x] [2.1] Verify `apps/swift/nexus-mac/Sources/Dashboard/SpecsView.swift` already calls `fetchSpecs()` on mount (it does per the 2026-05-20 grep — line 156). No change needed; pure verification [owner:ui-engineer] [type:test] [beads:nx-2qph5]
- [x] [2.2] Verify `apps/swift/nexus-mac/Sources/Dashboard/CredentialsView.swift` already calls `fetchCredentials()` on mount (it does — line 172). No change [owner:ui-engineer] [type:test] [beads:nx-wkmlv]
- [x] [2.3] [P-1] If the SpecsView empty state copy is too generic ("No specs found"), update to mention waiting for the homelab spec-watcher to scan. Minor copy polish [owner:ui-engineer] [type:feature] [beads:nx-6x1eu]

## E2E Batch

- [x] [3.1] Deploy via homelab post-merge: pushed `2da8aac` to origin/main, `ssh nyaptor@100.73.182.4 'cd ~/dev/nx && git pull --rebase'` fast-forwarded b5097c3..2da8aac. Hook chain ran but `02-deploy` failed initial pass (`smol-toml` not yet installed). Recovered: `ssh ... 'cd ~/dev/nx && bun install'` pulled the new dep, then `./deploy/hooks.d/post-merge/02-deploy --force` rebuilt, installed `~/.local/bin/nexus-agent`, and restarted the unit. Status post-restart: `active (running) since Wed 2026-05-20 17:02:29 CDT` with BUILD_SHA=2da8aac [owner:devops-engineer] [type:test] [beads:nx-tm1gl]
- [x] [3.2] Curl evidence (homelab Tailscale, 2026-05-20 17:02:40 CDT, agent BUILD_SHA=2da8aac):
  - `GET /specs` → 154 rows, 16 projects. Breakdown: xx=38, tl=31, nx=28, ws=26, tc=5, ss=4, nv=4, hl=3, gd=3, oo=2, la=2, lv=2, if=2, dc=2, cc=1, fb=1. First row: `{name: reorg-dev-by-org, project: cc, ...}`. nx rows include `homelab-emits-specs-credentials` itself.
  - `GET /credentials` → `{credentials: [18 entries], activeFingerprint: null}`. First entry: `{fingerprint: 5a7d85db..., account: acct-319cae46, created_at: 2026-04-01T01:11:35.290Z, status: expired}`.
  - Both payloads non-empty — fail-loud gate cleared [owner:devops-engineer] [type:test] [beads:nx-qvsm3]
- [x] [3.3] [user] **Verification recipe for Leo**: (1) Open Nexus.app menubar dashboard. (2) Switch source toggle to **homelab** (Tailscale agent `100.73.182.4:7400`). (3) Navigate to the **Specs** tab — expect ~154 rows across 16 projects, including `nx` with 28 active proposals. The `homelab-emits-specs-credentials` proposal should be listed under nx with completedTasks reflecting current state. (4) Navigate to the **Credentials** tab — expect 18 credential entries with mixed `active`/`expired` status. Note `activeFingerprint` may be `null` on homelab (no live CC session running). (5) Capture two screenshots (Specs view + Credentials view) and attach to the audit trail for this proposal. If either view shows empty, fall back to the curl evidence in 3.2 to triage whether it's a server-side regression or a client-side fetch bug. Do NOT verify via screenshot inside this batch — that's Leo's gate [user] [owner:user] [type:test] [beads:nx-sxrvy]
- [x] [3.4] Update `openspec/specs/spec-watcher/spec.md` AND `openspec/specs/credential-pool/spec.md` post-archive [handled by Phase 4 archive] [owner:devops-engineer] [type:docs] [beads:nx-dt5bb]
