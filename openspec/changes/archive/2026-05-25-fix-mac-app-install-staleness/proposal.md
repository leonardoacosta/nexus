# fix-mac-app-install-staleness

## Why

The macOS Nexus.app build->install->run path is broken and goes stale, leaving the dashboard empty. `install.sh`'s `find -name 'Nexus.app'` misses the actual lowercase xcodebuild product `nexus.app`, so the app never installs. With no auto-deploy on Swift changes the installed app drifts stale (dead menubar -> empty dashboard), and a bundle-integrity test asserts a stale LSUIElement value.

## What Changes

Fix the install-script app-name match; add a post-commit hook that auto-runs the Swift deploy on `apps/swift/` changes (prevents staleness); update the stale bundle-integrity test to match `project.yml` intent; verify a fresh install renders a populated dashboard, diagnosing whether any remaining emptiness is stale-app vs an ATS-cleartext-block.

## Context
- touches: `deploy/install.sh`, `deploy/hooks.d/post-commit/04-swift-deploy`, `apps/swift/nexus/nexusTests/bundle-integrity.test.ts`, `apps/swift/nexus/project.yml`

## Non-Goals

- No rewrite of the Swift dashboard rendering pipeline.
- No change to the Tailscale agent discovery or socket protocol.
- No fix for the ATS -1022 cleartext block itself (nx-p2zs5) — only diagnosis of whether emptiness is caused by it vs a stale app.
