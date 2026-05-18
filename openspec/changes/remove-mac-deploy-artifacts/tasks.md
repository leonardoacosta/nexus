# Tasks: remove-mac-deploy-artifacts

- [x] 1.1 [ops-agent] launchctl unload ~/Library/LaunchAgents/com.nexus.agent.plist — closed via nx-r1hzr (3 plists unloaded locally; menubar.plist out of scope)
- [x] 1.2 [ops-agent] launchctl unload ~/Library/LaunchAgents/com.nexus.notifier.plist — closed via nx-r1hzr
- [x] 1.3 [ops-agent] launchctl unload ~/Library/LaunchAgents/com.nexus.tts-player.plist — closed via nx-r1hzr
- [x] 1.4 [ops-agent] rm ~/Library/LaunchAgents/com.nexus.*.plist — closed via nx-r1hzr
- [x] 1.5 git rm deploy/com.nexus.agent.plist
- [x] 1.6 git rm deploy/com.nexus.notifier.plist deploy/com.nexus.tts-player.plist
- [ ] 1.7 git rm deploy/nexus-notifier.sh deploy/nexus-notifier-status.sh — BLOCKED: audit found active consumer at deploy/hooks.d/post-merge/02-deploy lines 167-174 (installs to ~/bin/) plus 3 test files in deploy/tests/. Tracked: bd:nx-eop6z
- [x] 1.8 git rm deploy/nexus-listener.ts deploy/nexus-stub.swift
- [x] 1.9 Update deploy/install.sh — [deferred-to-wave-7] env-aware-install-script rewrites deploy/install.sh wholesale.
