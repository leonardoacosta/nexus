## MODIFIED Requirements

### Requirement: install.sh SHALL branch by detected platform

`deploy/install.sh` SHALL detect the host platform via `uname -s` and execute different install paths for macOS vs Linux. Anything other than Darwin or Linux SHALL exit non-zero with "Unsupported platform: <uname-s>".

#### Scenario: Mac install branch fires on Darwin
- **GIVEN** running on macOS
- **WHEN** `deploy/install.sh` runs
- **THEN** the Mac branch executes (xcodegen + xcodebuild + .app install); no systemd commands attempted

#### Scenario: Linux install branch fires on Linux
- **GIVEN** running on Linux
- **WHEN** `deploy/install.sh` runs
- **THEN** the Linux branch executes (bun build + systemd user unit install); no xcodegen/xcodebuild attempted

### Requirement: macOS branch SHALL build + install the Swift app

The Mac branch SHALL: run `xcodegen generate` against `apps/swift/project.yml`, run `xcodebuild` for the `nexus-mac` scheme, copy the resulting `.app` to `/Applications/Nexus.app`. Optional: prompt to register as a login item.

#### Scenario: fresh Mac install produces a launchable app
- **GIVEN** a clean Mac with Xcode CLI + xcodegen + tmux + bun available
- **WHEN** `deploy/install.sh` runs
- **THEN** `/Applications/Nexus.app` exists and launches successfully; the menu bar icon appears

### Requirement: Linux branch SHALL build agent + install systemd unit

The Linux branch SHALL: `bun build` the agent in `apps/agent/`, install the binary to `~/.local/bin/nexus-agent`, copy `deploy/nexus-agent.service` to `~/.config/systemd/user/`, enable + start the unit.

#### Scenario: fresh Linux install produces a running agent
- **GIVEN** a clean Linux machine with tmux + bun + systemd available
- **WHEN** `deploy/install.sh` runs
- **THEN** `systemctl --user status nexus-agent` shows "active (running)"; the agent responds on port 7400
