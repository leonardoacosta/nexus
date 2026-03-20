## ADDED Requirements

### Requirement: Linux Systemd Service
The project SHALL provide a systemd user unit file (`deploy/nexus-agent.service`) that runs
`nexus-agent` as a long-lived daemon under the invoking user account.

The unit SHALL:
- Use `Type=simple` with automatic restart on failure
- Set `RUST_LOG=info` as default environment
- Depend on `network-online.target`
- Reference the binary at `%h/.local/bin/nexus-agent`

#### Scenario: Agent starts on boot
- **WHEN** the user enables the service via `systemctl --user enable nexus-agent`
- **THEN** the agent starts automatically on login and restarts on crash

#### Scenario: Agent logs to journald
- **WHEN** the agent is running as a systemd service
- **THEN** stdout/stderr are captured by journald and viewable via `journalctl --user -u nexus-agent`

### Requirement: macOS Launchd Agent
The project SHALL provide a launchd property list (`deploy/com.nexus.agent.plist`) that runs
`nexus-agent` as a user-level launch agent on macOS.

The plist SHALL:
- Set `RunAtLoad` to true
- Set `KeepAlive` to true for automatic restart
- Reference the binary at `$HOME/.local/bin/nexus-agent`
- Write stdout/stderr to `$HOME/Library/Logs/nexus-agent.{stdout,stderr}.log`

#### Scenario: Agent starts on login
- **WHEN** the user loads the agent via `launchctl load ~/Library/LaunchAgents/com.nexus.agent.plist`
- **THEN** the agent starts immediately and restarts on crash

### Requirement: CI Quality Gates
The project SHALL provide a GitHub Actions workflow (`.github/workflows/build.yml`) that runs
on every push to `main` and on every pull request.

The workflow SHALL execute these checks:
- `cargo build --workspace`
- `cargo test --workspace`
- `cargo clippy --workspace -- -D warnings`
- `cargo fmt --all --check`

#### Scenario: PR with clippy warnings is rejected
- **WHEN** a pull request introduces code that triggers clippy warnings
- **THEN** the CI check fails and the PR cannot be merged

#### Scenario: Clean PR passes all gates
- **WHEN** a pull request passes build, test, clippy, and fmt checks
- **THEN** all CI status checks report success

### Requirement: Cross-Compiled Release Artifacts
The CI workflow SHALL produce release-mode binaries for these targets:
- `x86_64-unknown-linux-gnu`
- `aarch64-apple-darwin`

Binaries SHALL be uploaded as GitHub Actions artifacts for download.

#### Scenario: Release binaries available after successful CI
- **WHEN** CI completes successfully on `main`
- **THEN** `nexus-agent` and `nexus` binaries for both targets are available as downloadable artifacts

### Requirement: Installation Script
The project SHALL provide an installation script (`deploy/install.sh`) that:
- Detects the host operating system (Linux or macOS)
- Copies the pre-built binary to `~/.local/bin/`
- Installs the appropriate service file (systemd unit or launchd plist)
- Prints instructions for enabling and starting the service
- Requires `tmux` to be present on PATH (validation check)

#### Scenario: Install on Linux
- **WHEN** the script is run on a Linux host with a built binary
- **THEN** the binary is copied to `~/.local/bin/nexus-agent`, the systemd unit is installed to `~/.config/systemd/user/`, and enable/start instructions are printed

#### Scenario: Install on macOS
- **WHEN** the script is run on a macOS host with a built binary
- **THEN** the binary is copied to `~/.local/bin/nexus-agent`, the plist is installed to `~/Library/LaunchAgents/`, and load instructions are printed

#### Scenario: Missing tmux dependency
- **WHEN** the script is run and `tmux` is not found on PATH
- **THEN** the script exits with an error message instructing the user to install tmux
