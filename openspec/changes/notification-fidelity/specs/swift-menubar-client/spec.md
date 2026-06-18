## ADDED Requirements

### Requirement: The macOS app SHALL log its notification authorization state at launch

At launch, after requesting notification authorization, the macOS app SHALL re-read the live
authorization state via `getNotificationSettings` and log both `authorizationStatus` and
`alertStyle`. This makes a reset or denied grant — for example after a re-sign resets the OS
alert style to `None` — visible in the launch trace instead of failing silently, so banner
invisibility can be diagnosed without GUI access.

The log SHALL NOT attempt to force a re-prompt: once a user has denied authorization the OS will
not re-display its dialog, and re-granting remains a System Settings action. The requirement is
diagnostic visibility, not auto-remediation.

#### Scenario: Grant denied is logged at launch
- **WHEN** the macOS app launches and the notification authorization status is `denied`
- **THEN** the launch log records `authorizationStatus = denied` and the current `alertStyle`

#### Scenario: Grant authorized is logged at launch
- **WHEN** the macOS app launches and authorization is `authorized`
- **THEN** the launch log records `authorizationStatus = authorized` and the `alertStyle` (e.g. `banner` or `none`)
