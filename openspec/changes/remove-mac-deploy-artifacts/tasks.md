# Tasks: remove-mac-deploy-artifacts

- [ ] 1.1 [user] launchctl unload ~/Library/LaunchAgents/com.nexus.agent.plist
- [ ] 1.2 [user] launchctl unload ~/Library/LaunchAgents/com.nexus.notifier.plist
- [ ] 1.3 [user] launchctl unload ~/Library/LaunchAgents/com.nexus.tts-player.plist
- [ ] 1.4 [user] rm ~/Library/LaunchAgents/com.nexus.*.plist
- [ ] 1.5 git rm deploy/com.nexus.agent.plist
- [ ] 1.6 git rm deploy/com.nexus.notifier.plist deploy/com.nexus.tts-player.plist
- [ ] 1.7 git rm deploy/nexus-notifier.sh deploy/nexus-notifier-status.sh
- [ ] 1.8 git rm deploy/nexus-listener.ts deploy/nexus-stub.swift
- [ ] 1.9 Update deploy/install.sh — remove all Mac-launchd paths (P6.2 handles env-aware rewrite)
