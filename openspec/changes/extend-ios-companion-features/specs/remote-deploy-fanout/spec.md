## ADDED Requirements

### Requirement: GUI-agent deploy SHALL extend to headless iOS device install

iOS deploys SHALL route through the same GUI-agent kickstart mechanism the macOS deploy already uses (`dev.leonardoacosta.nexus.deploy`, gui/501 LaunchAgent, `deploy/hooks.d/*/04-swift-deploy` + `deploy/lib/macos-swift-deploy.sh`), extended to build `nexus-ios` and run `xcrun devicectl device install app` against the paired iPhone — a headless SSH attempt fails at codesign (requires an Aqua session) and even `git push` from SSH fails with keychain error -25308.

#### Scenario: iOS device install completes without manual devicectl intervention

- **GIVEN** a merge lands changing files under `apps/swift/nexus-ios/`
- **AND** a paired iPhone is reachable via `devicectl`
- **WHEN** the post-merge deploy dispatcher runs the extended `04-swift-deploy` hook
- **THEN** the GUI-agent LaunchAgent builds `nexus-ios` in an Aqua session (real codesign
  succeeds)
- **AND** `xcrun devicectl device install app` installs the signed build to the paired device
- **AND** no manual `devicectl` command from the operator is required
