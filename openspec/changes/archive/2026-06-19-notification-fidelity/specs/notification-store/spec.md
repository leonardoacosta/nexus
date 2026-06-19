## ADDED Requirements

### Requirement: Notification titles SHALL compose project code and session name

Notification titles SHALL be composed as `<project> · <session>` (middot-separated) when both
a project code and a session name are present, so the recipient can identify both the project
and the specific session at a glance. The composition SHALL degrade gracefully: session name
alone, then project code alone, then the notification's own title, then a default of `Nexus`.

The rule SHALL be applied consistently across every delivery surface: the iOS APNS push
(server-built by the agent), the macOS desktop banner (client-built from the `NotificationFired`
event), and the iOS in-app stored-notification list. Because the APNS push title is built by the
agent and the banner / in-app titles are built by the Swift clients, the rule is expressed once
in TypeScript and once in Swift; both expressions SHALL produce identical output for the same
inputs.

#### Scenario: Both project and session present
- **WHEN** a session-originated notification fires with project `oo` and session name `fix-login-flow`
- **THEN** the notification title is `oo · fix-login-flow`
- **AND** the same title appears on the iOS push, the macOS banner, and the iOS in-app list

#### Scenario: Session name only
- **WHEN** a notification fires with a session name but no project code
- **THEN** the title is the session name alone (no leading separator)

#### Scenario: Neither project nor session present
- **WHEN** a notification fires with neither a project code nor a session name
- **THEN** the title falls back to the notification's own title, or `Nexus` if that is also absent

#### Scenario: Body is unaffected
- **WHEN** the composed title changes
- **THEN** the notification body still carries the original message text unchanged
