# swift-menubar-client

## ADDED Requirements

### Requirement: Install script SHALL locate and install the xcodebuild app product regardless of case

The macOS install path MUST find the xcodebuild product whether it is named `nexus.app` or `Nexus.app` and copy it into place, and a post-commit hook MUST auto-redeploy the Swift app when `apps/swift/` changes so the installed bundle never goes stale.

#### Scenario: install finds the lowercase product
- **WHEN** `deploy/install.sh` runs on macOS and xcodebuild produced `nexus.app`
- **THEN** the script locates the product via a case-insensitive match and installs it into the applications path

#### Scenario: post-commit hook redeploys on Swift changes
- **WHEN** a commit touches files under `apps/swift/`
- **THEN** the `deploy/hooks.d/post-commit/04-swift-deploy` hook rebuilds and reinstalls the Swift app so the installed bundle is fresh

### Requirement: Bundle-integrity test SHALL assert the intended menu-bar config and a fresh install SHALL render a populated dashboard

The bundle-integrity test MUST assert the LSUIElement value declared in `project.yml` (menu-bar app intent), and a fresh install MUST render a populated dashboard or record whether remaining emptiness is a stale app vs the ATS cleartext block.

#### Scenario: integrity test matches project.yml intent
- **WHEN** `bundle-integrity.test.ts` runs against the built bundle
- **THEN** the LSUIElement assertion matches the intentional value declared in `apps/swift/nexus/project.yml`

#### Scenario: fresh install renders populated dashboard
- **WHEN** the app is freshly installed and launched after the install fix
- **THEN** the dashboard renders populated, or the determination of stale-app vs ATS -1022 cleartext block is recorded
