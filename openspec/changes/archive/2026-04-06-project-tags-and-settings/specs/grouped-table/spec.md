## MODIFIED Requirements

### Requirement: /projects table groups rows by first tag

`ProjectsTable` MUST sort projects into groups keyed by `project.tags?.[0] ?? "uncategorized"`. Groups SHALL render in alphabetical tag order with Uncategorized last. Each group MUST render a sticky uppercase section header row showing the tag name and project count. Within each group, rows render in the existing sort order (active DESC, name ASC).

#### Scenario: tagged projects appear under their group
- GIVEN: projects "nx" (tags: ["homelab"]), "oo" (tags: ["priceless"]), "ba" (tags: ["personal"])
- WHEN: /projects table renders
- THEN: three section headers appear: "HOMELAB", "PERSONAL", "PRICELESS" (alphabetical)
- AND: "nx" row appears under "HOMELAB", "oo" under "PRICELESS", "ba" under "PERSONAL"

#### Scenario: untagged projects in Uncategorized
- GIVEN: project "cc" has `tags = null`
- WHEN: /projects table renders
- THEN: "UNCATEGORIZED" section header appears at the bottom
- AND: "cc" row appears under it

#### Scenario: empty section is not rendered
- GIVEN: no projects have tag "b&b"
- WHEN: /projects table renders
- THEN: no "B&B" section header appears
