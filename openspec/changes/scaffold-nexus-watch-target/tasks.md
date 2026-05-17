# Tasks: scaffold-nexus-watch-target

- [ ] 1.1 Create apps/swift/nexus-watch/ source layout
- [ ] 1.2 Add agent endpoint POST /commands/send-text (uses tmux send-keys)
- [ ] 1.3 Implement watchOS App + ContentView (session count + last alert)
- [ ] 1.4 Implement UNNotificationCategory with action buttons
- [ ] 1.5 Implement notification action handler that POSTs to /commands/send-text
- [ ] 1.6 [user] Provision watchOS app; pair with phone
- [ ] 1.7 End-to-end test: Notification hook → watch action → tmux
