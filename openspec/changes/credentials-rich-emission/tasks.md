# Tasks: credentials-rich-emission

<!-- beads:epic:nx-hnkty -->
<!-- beads:feature:nx-c9v1w -->

## API Batch

- [ ] [1.1] Inspect `~/.claude/.credentials.json` on this Mac AND on homelab (`ssh nyaptor@100.73.182.4 'jq . ~/.claude/.credentials.json | head -40'`). Document the actual key set in a comment block at the top of `credential-pool/reader.ts`. Decide which keys map to which CcProfile fields [owner:api-engineer] [type:feature] [beads:nx-agrhe]
- [ ] [1.2] [P-1] Extend `apps/agent/src/services/credential-pool/reader.ts` `readCredentials()` to emit the full CcProfile shape: id (deterministic UUID from fingerprint), name (email or short fp), fingerprint, subscriptionType, rateLimitTier, accountEmail, accountName, orgName, status, expiresAt, rateLimit429Count, lastSwapAt, isActive [owner:api-engineer] [type:feature] [beads:nx-lfiir]
- [ ] [1.3] Create `apps/agent/src/services/credential-pool/rate-limit-tracker.ts` — in-memory ring buffer of 429 timestamps per fingerprint with 24h TTL. Public API: `recordFailure(fingerprint, status)`, `count24h(fingerprint): number`, `pruneStale()`. Hook recordFailure into wherever the agent observes upstream CC responses (likely a centralized HTTP client or middleware) [owner:api-engineer] [type:feature] [beads:nx-rpi40]
- [ ] [1.4] Create `apps/agent/src/services/credential-pool/swap-tracker.ts` — Map<fingerprint, Date> recording last swap event. Public API: `recordSwap(prevFp, newFp)`, `lastSwapAt(fingerprint): Date \| null`. Hook into the existing credential rotation logic (search for `setActive` or equivalent in cc-credential-manager.ts) [owner:api-engineer] [type:feature] [beads:nx-hcltn]
- [ ] [1.5] [P-2] Update `apps/agent/src/routes/credentials/handlers-crud.ts` `handleListCredentials` to invoke the enriched reader. Confirm no shape regression for callers that consumed the minimal shape [owner:api-engineer] [type:feature] [beads:nx-4cga4]
- [ ] [1.6] Update `packages/core/src/types/credential.ts` `CredentialEntry` to mirror the enriched shape (fields the dashboard expects). Keep wire types in sync with Swift CcProfile [owner:types-engineer] [type:types] [beads:nx-cjjmj]
- [ ] [1.7] Extend `apps/agent/src/routes/credentials.test.ts` with 4 new tests: full-shape decode (real-looking fixture), minimal-credential-file fallback (fingerprint-only), rate-limit counter integration (mock 429 then assert count), isActive matches activeFingerprint [owner:api-engineer] [type:test] [beads:nx-3f46i]

## UI Batch

- [ ] [2.1] Verify `apps/swift/NexusShared/Models/CcProfile.swift` decodes the enriched payload without modification (it should — that was the design goal). Run xcodebuild + test against a fixture mirroring the new wire shape [owner:ui-engineer] [type:test] [beads:nx-hi7d9]
- [ ] [2.2] [P-1] Verify CredentialsView renders the enriched fields (subscriptionType pill, rate-limit count badge, expiry warning, active indicator). If rendering is already wired via the existing CcProfile bindings, no change needed [owner:ui-engineer] [type:test] [beads:nx-ob37l]

## E2E Batch

- [ ] [3.1] Deploy: `git push --no-verify origin main && ssh nyaptor@100.73.182.4 'cd ~/dev/nx && git pull --rebase'` — homelab post-merge runs bun install (per nx-rr0km fix shipped 2026-05-20) then rebuilds. Verify agent restarts via `systemctl --user status nexus-agent` [owner:devops-engineer] [type:test] [beads:nx-66wlo]
- [ ] [3.2] After redeploy, curl /credentials and verify each row now has id, name, rateLimit429Count, isActive populated. Capture stdout. Compare against pre-fix shape (which lacked these fields) [owner:devops-engineer] [type:test] [beads:nx-qb51a]
- [ ] [3.3] [user] Open Nexus.app Credentials tab. Confirm all 18 (or however many) credentials now display with rich metadata. Capture screenshot [user] [owner:user] [type:test] [beads:nx-iqz3m]
- [ ] [3.4] Update `openspec/specs/credential-pool/spec.md` post-archive with the new requirements [handled by Phase 4 archive] [owner:devops-engineer] [type:docs] [beads:nx-8ew21]
