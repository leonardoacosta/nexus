# Tasks: remove-macos-deploy-agent-daemon

<!-- beads:epic:nx-1hluw -->
<!-- beads:feature:nx-pvc4n -->

## API Batch

- [x] 1.1 `deploy/hooks.d/pre-push/01-deploy` — remove the `Darwin)` case body
  (PLIST assignment, the broken `sed … deploy/com.nexus.agent.plist > $PLIST`,
  and `bootstrap_with_retry "com.nexus.agent" "$PLIST"`). macOS must do nothing
  daemon-wise; leave a one-line comment pointing at `env-aware-install-script`
  for the Swift-app path. Keep the `Linux)` branch unchanged. [beads:nx-fw741]
- [x] 1.2 `deploy/hooks.d/pre-push/01-deploy` — remove the now-dead
  `bootstrap_with_retry()` function definition (only the removed Darwin branch
  called it; Linux uses `systemctl`). Confirm no remaining caller before delete. [beads:nx-7n61b]
- [x] 1.3 `deploy/hooks.d/post-merge/02-deploy` — remove the `Darwin)` case body
  (lines ~152–164: `sed` at 156, `bootstrap_with_retry` at 160) identically to 1.1. [beads:nx-0us5r]
- [x] 1.4 `deploy/hooks.d/post-merge/02-deploy` — remove the now-dead
  `bootstrap_with_retry()` function definition (same rationale as 1.2). [beads:nx-m2k6n]
- [x] 1.5 `deploy/install.sh` — remove the inline `com.nexus.agent.plist`
  generation block (the `# Agent launchd plist — generate inline` comment,
  `local PLIST=`, the `<?xml … </plist>` heredoc, and the trailing
  `launchctl bootout/bootstrap` echo instructions). Leave the macOS Swift-app
  build/install path (xcodegen/xcodebuild/copy `.app`) untouched. [beads:nx-099lf]
- [x] 1.6 Static guard: add a check (extend the existing pre-commit hook, or a
  small `deploy/` lint) asserting `deploy/` contains no `*.plist` and no
  `com.nexus.agent` `launchctl` invocation, so the drift class cannot recur.
  Keep it minimal — a `grep`-based assertion, not a framework. [beads:nx-i6at0]

## E2E Batch

- [ ] 2.1 Run the pre-push hook path on macOS (`SKIP_DEPLOY=0 git push` dry, or
  invoke the hook directly): assert exit 0, no `sed: … No such file or
  directory`, and that `~/Library/LaunchAgents/com.nexus.agent.plist` is **not**
  created (remove any pre-existing empty one first to prove non-creation). [beads:nx-0xndu]
- [ ] 2.2 Trigger a homelab→macbook remote fanout (homelab post-merge deploy):
  assert the downstream macbook deploy logs no `sed`/plist error and reports
  `deploy complete`. [beads:nx-8tcq5]
- [ ] 2.3 Assert post-state on the macbook: `launchctl list | grep
  com.nexus.agent` returns nothing, and `find deploy -name '*.plist'` is empty. [beads:nx-8x1yd]
- [ ] 2.4 [user] Confirm the macbook still has no nexus-agent process (expected —
  Mac is Swift-app + Tailnet only) and the dashboard (reading homelab) is
  unaffected. [beads:nx-hm5yk]
