## 1. Service Files
- [x] 1.1 Create `deploy/nexus-agent.service` — systemd user unit for Linux
- [x] 1.2 Create `deploy/com.nexus.agent.plist` — launchd user agent for macOS

## 2. CI Workflow
- [x] 2.1 Create `.github/workflows/build.yml` — GitHub Actions with cargo build, test, clippy, fmt
- [x] 2.2 Add cross-compilation matrix: `x86_64-unknown-linux-gnu`, `aarch64-apple-darwin`
- [x] 2.3 Upload release binaries as workflow artifacts

## 3. Installation Script
- [x] 3.1 Create `deploy/install.sh` — detect OS, copy binary, install service file, print next steps
