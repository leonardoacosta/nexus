## MODIFIED Requirements

### Requirement: CanonicalProject exposes tags and description

`CanonicalProject` in `packages/core/src/types/project.ts` MUST include `tags: string[] | null` and `description: string | null`. `fetchProjects()` MUST select these columns from the `projects` DB table and populate them on each `CanonicalProject` entry.

#### Scenario: fetchProjects returns tags
- GIVEN: project "nx" has `tags = ["homelab"]` and `description = "Nexus monorepo"` in DB
- WHEN: `fetchProjects()` is called
- THEN: the returned `CanonicalProject` for "nx" has `tags: ["homelab"]` and `description: "Nexus monorepo"`

#### Scenario: project with no tags returns null
- GIVEN: project "ba" has `tags = null` in DB
- WHEN: `fetchProjects()` is called
- THEN: `project.tags` is `null` (not undefined, not [])

## ADDED Requirements

### Requirement: fetchProject by name

A `fetchProject(name: string): Promise<CanonicalProject | null>` server action MUST query the DB for a single project by name (case-sensitive match on `projects.name`). It SHALL return `null` if not found.

#### Scenario: known project
- GIVEN: project "ba" exists in registry
- WHEN: `fetchProject("ba")` is called
- THEN: returns `CanonicalProject` with locations, tags, description populated

#### Scenario: unknown project
- GIVEN: no project named "xyz" in registry
- WHEN: `fetchProject("xyz")` is called
- THEN: returns `null`

### Requirement: updateProject persists tags and description

An `updateProject(id: string, data: { tags?: string[]; description?: string }): Promise<void>` server action MUST issue a Drizzle `UPDATE` on `projects` setting only the provided fields. Tags MUST be normalized (trimmed, lowercased) before write.

#### Scenario: updating tags
- GIVEN: project id "abc-123" exists
- WHEN: `updateProject("abc-123", { tags: ["  Homelab ", "Personal"] })` is called
- THEN: DB row has `tags = ["homelab", "personal"]`
- AND: next `fetchProject` call returns the updated tags
