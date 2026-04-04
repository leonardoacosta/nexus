## ADDED Requirements

### Requirement: agent-self-endpoint
The nexus-agent MUST expose `GET /agent/self` which SHALL return its own config: `{ name, host, port, role, projects_dir }`. `role` defaults to `"agent"` if not configured. `projects_dir` SHALL be the resolved (tilde-expanded) value of `NEXUS_PROJECTS_DIR`.

#### Scenario: self config returned
Given the agent is running with `NEXUS_PROJECTS_DIR=~/dev` and `role=primary`
When `GET /agent/self` is called
Then response is `200 { name: "homelab", host: "homelab", port: 7400, role: "primary", projects_dir: "/home/user/dev" }` (tilde expanded)

#### Scenario: defaults when env vars absent
Given no `NEXUS_PROJECTS_DIR` or role configured
When `GET /agent/self` is called
Then response contains `role: "agent"` and `projects_dir: "/home/<user>/dev"`

### Requirement: agent-management-panel
The Settings page MUST include an Agent Management section. It SHALL display each configured agent's full frontmatter (name, host, port, role, projects_dir, online/offline status). An "Add Agent" form MUST accept name, host, port, and projects_dir. Agents SHALL be removable. Changes MUST persist to `~/.config/nexus/dashboard.json` via a Next.js server action and take effect on the next client-side navigation (no service restart needed).

#### Scenario: agent list shows frontmatter
Given two agents are configured (homelab online, macbook offline)
When the Settings page loads
Then the Agent Management section shows both agents with their name, host, port, role, and projects_dir

#### Scenario: add new agent
Given the user fills the Add Agent form with `{ name: "server", host: "100.x.x.x", port: 7400, projects_dir: "~/dev" }`
When they click Save
Then `dashboard.json` is updated with the new entry and the agent appears in the list

#### Scenario: remove agent
Given the agent list shows "macbook"
When the user clicks Remove on it
Then it is removed from `dashboard.json` and disappears from the list

#### Scenario: dashboard.json merged with NEXUS_AGENTS
Given `NEXUS_AGENTS` defines "homelab" and `dashboard.json` defines "server"
When `get-client.ts` initializes
Then both agents are in the client's config, with `NEXUS_AGENTS` taking precedence if the same name appears in both

### Requirement: commands-browser-panel
The Settings page MUST include a Commands Browser section. It SHALL fetch `GET /commands` from each online agent and display commands grouped by source: **Global** (path contains `~/.claude/commands/`) and **Project** (path contains `.claude/commands/` relative to a project directory). Each command MUST show its name, description, tier, and cost.

#### Scenario: commands grouped by source
Given an agent returns 10 commands, 7 from `~/.claude/commands/` and 3 from `.claude/commands/` in a project dir
When the Commands Browser renders
Then commands are shown in two sections: "Global (7)" and "Project (3)"

#### Scenario: offline agent gracefully skipped
Given macbook agent is offline
When the Commands Browser loads
Then homelab commands are shown; macbook is listed as "offline — commands unavailable"

#### Scenario: command detail shown
Given the commands list includes `apply` with tier `Action` and cost `High`
When the Commands Browser renders
Then the entry shows name "apply", description text, and badges "Action" and "High"

### Requirement: commands-editor
The nexus-agent MUST expose `PUT /commands/:name` which SHALL accept `{ content: string }` and write the updated file content atomically (tmp file + rename) to the command's original path on disk. The endpoint MUST reject empty content with `400 { error: "content must not be empty" }`. The Settings page Commands section MUST allow selecting a command to open an inline editor showing full file content (frontmatter + body). Saving SHALL call the `PUT /commands/:name` endpoint on the owning agent.

#### Scenario: select command opens inline editor
Given the Commands Browser shows the `apply` command
When the user clicks on it
Then an inline editor panel opens showing the full markdown content of the `apply.md` file

#### Scenario: save updated command
Given the user has edited the content of `apply.md` in the inline editor
When they click Save
Then `PUT /commands/apply` is called with the new content, the file is written atomically on the agent, and the editor shows a success confirmation

#### Scenario: empty content rejected
Given the user clears all content in the inline editor
When they click Save
Then the agent returns `400 { error: "content must not be empty" }` and the editor shows the error without overwriting the file

#### Scenario: atomic write ensures no partial files
Given the agent receives valid content for `PUT /commands/apply`
Then the agent writes to a tmp file first, then atomically renames it to the target path — if the rename fails, the original file is unchanged
