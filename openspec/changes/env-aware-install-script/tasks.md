# Tasks: env-aware-install-script

- [ ] 1.1 Rewrite deploy/install.sh top-level: detect platform, branch
- [ ] 1.2 Implement Mac branch: xcodegen + xcodebuild + copy to /Applications
- [ ] 1.3 Implement Linux branch: bun build + ~/.local/bin install + systemd user unit
- [ ] 1.4 Add login-item registration prompt for Mac (optional)
- [ ] 1.5 Remove all references to deleted Mac daemons (plists, notifier.sh, etc.)
- [ ] 1.6 Update README.md install instructions
- [ ] 1.7 Test fresh install on both Mac and Linux
