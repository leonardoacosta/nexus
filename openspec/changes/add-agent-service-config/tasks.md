## 1. Service Files
- [x] [1.1] Create deploy/nexus-agent.service (systemd unit) with Restart=on-failure, After=network.target, and Environment for RUST_LOG [owner:engineer]
- [x] [1.2] Create deploy/com.nexus.agent.plist (launchd plist) with KeepAlive=true and StandardOutPath/StandardErrorPath for logging [owner:engineer]

## 2. Install Script
- [x] [2.1] Add scripts/install-agent.sh that detects OS, copies binary to /usr/local/bin, installs service file, and enables/starts the service [owner:engineer]

## 3. Validation
- [x] [3.1] Test systemd service restart on crash (kill -9 agent, verify systemd restarts it) [owner:engineer]
- [x] [3.2] Verify systemctl status nexus-agent shows active/running after install [owner:engineer]
