## ADDED Requirements

### Requirement: /projects/[name] always renders a settings panel

`/projects/[name]` MUST call `fetchProject(name)` and render `<ProjectSettingsPanel project={project} />` unconditionally at the top of the page. If `fetchProject` returns `null`, the page SHALL render a "Project not found in registry" message and no sessions section.

#### Scenario: project exists with no sessions
- GIVEN: project "ba" exists in registry but has no sessions
- WHEN: /projects/ba is loaded
- THEN: settings panel renders with name, paths, description, tags
- AND: sessions section shows "No sessions for this project"

#### Scenario: unknown project
- GIVEN: no project "xyz" in registry
- WHEN: /projects/xyz is loaded
- THEN: page shows "Project not found in registry" message
- AND: no settings panel renders

### Requirement: ProjectSettingsPanel component

`ProjectSettingsPanel` MUST display:
- Project name as a read-only heading (monospace, `var(--font-mono)`)
- Per-location rows: agent name badge + filesystem path (read-only, monospace)
- Description: a `<textarea>` pre-filled with `project.description ?? ""`; changes are local until Save
- Tags: a chip input showing existing tags as removable chips; new tags added via text input + Enter or comma
- A "Save" button that calls `updateProject(project.id, { tags, description })` and shows inline success/error feedback

#### Scenario: user edits description and saves
- GIVEN: project "nx" has description "Nexus monorepo"
- WHEN: user changes textarea to "Nexus — agent + TUI monorepo" and clicks Save
- THEN: `updateProject` is called with the new description
- AND: a success indicator ("Saved") briefly appears

#### Scenario: user adds a new tag
- GIVEN: project "nx" has tags ["homelab"]
- WHEN: user types "personal" in the tag input and presses Enter
- THEN: a new chip "personal" appears
- AND: clicking Save persists `tags: ["homelab", "personal"]`

#### Scenario: user removes a tag
- GIVEN: project "nx" has tags ["homelab", "personal"]
- WHEN: user clicks the × on the "personal" chip
- THEN: the chip is removed from the input
- AND: clicking Save persists `tags: ["homelab"]`
