## REMOVED Requirements

### Requirement: bash listener banner-click-cancel feature

**Reason for removal**: The `consolidate-mac-tts-listener` proposal aimed to port banner-click-cancel from the decommissioned Bun listener into the bash listener. With the entire bash listener stack being replaced by the Swift app (P4.5 + P4.7), porting to bash is wasted work. The Swift app implements banner-click-cancel natively via `UNNotificationCenter` actions.

**Migration**: close `consolidate-mac-tts-listener` proposal with reason="Superseded by spine-migration P4". Close the corresponding beads feature `nx-69d9s` with the same reason.

#### Scenario: banner click cancels playback in Swift app
- **GIVEN** P4.5 + P4.7 are merged and Swift app handles all notifications
- **WHEN** the Swift app fires a notification and the user clicks the banner mid-AVAudioPlayer playback
- **THEN** the UNNotificationCenter delegate cancels the in-flight AVAudioPlayer (no bash PID-file dance needed)
