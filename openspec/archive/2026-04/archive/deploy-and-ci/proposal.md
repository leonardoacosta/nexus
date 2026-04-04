# Change: Add deployment and CI infrastructure

## Why
Nexus has no deployment tooling or CI pipeline. Developers must manually build, install, and
configure the agent daemon on each machine, and there is no automated quality gate to prevent
regressions from landing on `main`.

## What Changes
- Add a systemd unit file for running `nexus-agent` as a user service on Linux
- Add a launchd plist for running `nexus-agent` as a user agent on macOS
- Add a GitHub Actions workflow that runs build, test, clippy, and fmt checks on every push/PR,
  and produces cross-compiled release binaries as artifacts
- Add an installation script that copies the binary and service file into place

## Impact
- Affected specs: deployment (new capability)
- Affected code:
  - `deploy/nexus-agent.service` (NEW)
  - `deploy/com.nexus.agent.plist` (NEW)
  - `deploy/install.sh` (NEW)
  - `.github/workflows/build.yml` (NEW)
