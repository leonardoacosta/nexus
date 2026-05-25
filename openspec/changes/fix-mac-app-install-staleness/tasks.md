<!-- beads:epic:nx-rxlbi -->
<!-- beads:feature:nx-est01 -->

# Tasks: fix-mac-app-install-staleness

## UI Batch
- [x] [1.1] Fix `deploy/install.sh` macOS branch so it locates the xcodebuild product regardless of case (`nexus.app`/`Nexus.app`) and actually installs it [owner:devops-engineer] [type:ci-cd] [beads:nx-5ws74]
- [x] [1.2] Add a post-commit hook `deploy/hooks.d/post-commit/04-swift-deploy` that rebuilds+installs the Swift app when `apps/swift/` changed, so the installed app never goes stale [owner:devops-engineer] [type:ci-cd] [beads:nx-2pzu2]
- [x] [1.3] Update the stale `bundle-integrity.test.ts` LSUIElement assertion to match the intentional `project.yml` value (menu-bar app config) [owner:devops-engineer] [type:testing] [beads:nx-9sigd]

## E2E Batch
- [ ] [2.1] [user] After a fresh install, verify the dashboard renders populated; diagnose whether any remaining emptiness is stale-app vs the ATS -1022 cleartext block (nx-p2zs5) and record the determination [owner:e2e-engineer] [type:testing] [beads:nx-tjp5p]
