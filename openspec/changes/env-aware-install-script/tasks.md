# Tasks: env-aware-install-script

- [x] 1.1 Rewrite deploy/install.sh top-level: detect platform, branch (uname -s -> install_linux / install_macos)
- [x] 1.2 Implement Mac branch: xcodegen + xcodebuild (scheme nexus-mac) + copy Nexus.app to /Applications + generate launchd plist inline
- [x] 1.3 Implement Linux branch: bun build + ~/.local/bin install + systemd user unit + daemon-reload
- [x] 1.4 Add login-item registration prompt for Mac — stubbed as TODO comment (osascript path); tracked via nx-eop6z scope
- [x] 1.5 Remove all references to deleted Mac daemons — install.sh no longer references com.nexus.{notifier,tts-player}.plist, nexus-notifier.sh, nexus-listener.ts, or nexus-stub.swift
- [x] 1.6 Update README.md install instructions — Install as Service section updated to reflect env-aware behaviour + flags table
- [ ] 1.7 Test fresh install on both Mac and Linux — bd:nx-43tz3 (cannot smoke-test inline without uninstalling first)
