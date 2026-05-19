## ADDED Requirements

### Requirement: No macOS nexus-agent daemon in deploy

The deploy system MUST NOT install a `com.nexus.agent` daemon on macOS. On
`Darwin`, neither `deploy/install.sh` nor the git deploy hooks
(`deploy/hooks.d/pre-push/01-deploy`, `deploy/hooks.d/post-merge/02-deploy`)
SHALL generate a `com.nexus.agent` launchd plist, write to
`~/Library/LaunchAgents/com.nexus.agent.plist`, or invoke `launchctl`
bootstrap/bootout/kickstart for `com.nexus.agent`. The `bootstrap_with_retry`
helper, whose only caller was the removed Darwin branch, MUST be removed from
both hooks. macOS deploy responsibilities are limited to the Swift app
build/install path owned by `env-aware-install-script`.

#### Scenario: pre-push hook runs on macOS

- **GIVEN** a developer pushes from a macOS machine and the pre-push deploy hook fires
- **WHEN** the hook reaches the platform branch for `Darwin`
- **THEN** no `sed` against `deploy/com.nexus.agent.plist` is attempted
- **AND** no file is written to `~/Library/LaunchAgents/com.nexus.agent.plist`
- **AND** the hook completes without error and proceeds to remote fanout

#### Scenario: homelab fans out a deploy to the macbook

- **GIVEN** the homelab agent runs its post-merge deploy and fans out to the macbook
- **WHEN** the downstream macbook deploy runs on `Darwin`
- **THEN** no `com.nexus.agent` launchd plist is generated or bootstrapped
- **AND** the fanout reports success with no `sed: … No such file or directory` error

#### Scenario: install.sh run on a clean Mac

- **GIVEN** `deploy/install.sh` is run on macOS
- **WHEN** the macOS branch executes
- **THEN** it builds/installs the Swift app only
- **AND** it does not generate `~/Library/LaunchAgents/com.nexus.agent.plist`
- **AND** `deploy/` contains no `.plist` files and no `com.nexus.agent` launchctl invocation
