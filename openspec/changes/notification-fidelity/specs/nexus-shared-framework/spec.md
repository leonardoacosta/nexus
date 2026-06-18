## ADDED Requirements

### Requirement: Banner presentation SHALL honor the in-app banner toggle

The `nx.notifications.bannerEnabled` user setting SHALL gate whether notification banners are
posted. When the setting is `false`, the framework's banner posters SHALL NOT post a banner;
when it is `true` or absent, banners SHALL post as before (the setting defaults to `true` for a
fresh install). The gate SHALL be applied at every banner poster — both
`TTSObserver.postBanner` and `SessionObserver.postLocalNotification` — and the macOS foreground
presentation handler (`NotificationActivationHandler.willPresent`) SHALL also honor the setting
so a suppressed notification is not force-presented in the foreground.

The setting SHALL be read directly from `UserDefaults.standard` using
`object(forKey:) as? Bool ?? true` (NOT `bool(forKey:)`, which would default an absent key to
`false` and suppress banners on a fresh install), matching the existing raw-UserDefaults read
precedent for ducking in `TTSObserver`.

Audio/TTS delivery SHALL be unaffected by the banner toggle — only the banner stage is gated.

#### Scenario: Toggle off suppresses the banner
- **WHEN** `nx.notifications.bannerEnabled` is `false` and a notification fires
- **THEN** no banner is posted by either poster
- **AND** the TTS/audio stage still plays

#### Scenario: Toggle on or absent posts the banner
- **WHEN** `nx.notifications.bannerEnabled` is `true` or has never been set
- **THEN** the banner posts as before

#### Scenario: Both posters honor the gate
- **WHEN** the toggle is off and a notification arrives via either the TTS observer or the session observer
- **THEN** neither poster posts a banner
