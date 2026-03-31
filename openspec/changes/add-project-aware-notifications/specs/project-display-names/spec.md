# Spec: Project Display Names in Notifications

## MODIFIED Requirements

### Requirement: Project registry loader
The project registry loader (`get_projects()`) MUST read from
`~/.claude/scripts/config/projects.json`.

#### Scenario: Correct path resolution
Given the project registry exists at `~/.claude/scripts/config/projects.json`
When `get_projects()` is called
Then it returns all projects with their `code`, `name`, and `icon` fields populated.

#### Scenario: Missing registry file
Given `projects.json` does not exist at the expected path
When `get_projects()` is called
Then it returns an empty list and logs a warning.

---

### Requirement: Banner notification title
The macOS banner notification title MUST display the project's emoji icon and display name.

#### Scenario: Known project
Given a notification arrives with project code `"oo"`
And `projects.json` maps `"oo"` to `{ name: "Otaku Odyssey", icon: "🎯" }`
When the banner is delivered
Then the title is `"🎯 Otaku Odyssey"` and the body contains the notification message.

#### Scenario: Unknown project code
Given a notification arrives with project code `"zz"` (not in registry)
When the banner is delivered
Then the title is `"🔭 Nexus"`.

#### Scenario: Empty or global project
Given a notification arrives with project `""` or `"global"`
When the banner is delivered
Then the title is `"🔭 Nexus"`.

---

### Requirement: APNs notification title
The Apple Watch notification title MUST display the project's emoji icon and display name.

#### Scenario: Known project
Given an APNs notification for project `"tl"`
And `projects.json` maps `"tl"` to `{ name: "Tavern Ledger", icon: "📋" }`
When the notification is sent to Watch
Then the title is `"📋 Tavern Ledger"`.

#### Scenario: Unknown project
Given an APNs notification for an unrecognized project code
When the notification is sent to Watch
Then the title is `"🔭 Nexus"`.

---

### Requirement: TTS spoken prefix
The TTS message prefix MUST use the project display name (without emoji).

#### Scenario: Known project
Given a lifecycle event for project `"oo"`
When the TTS message is constructed
Then the prefix is `"Otaku Odyssey — "`.

#### Scenario: Unknown project
Given a lifecycle event for an unrecognized project code
When the TTS message is constructed
Then the prefix is `"Nexus — "`.
