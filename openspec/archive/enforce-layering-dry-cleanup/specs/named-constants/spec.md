# Spec: Named Constants

## MODIFIED Requirements

### Requirement: Replace magic fallback with named constant

All occurrences of the magic literal `999` used as a priority fallback MUST be replaced with a named constant `DEFAULT_PRIORITY`. The constant SHALL be defined in the shared project helper (`apps/nextjs/src/lib/projects.ts`) since it is only used by the Next.js app layer.

#### Scenario: fetchProjects uses named constant

**Given** `fetchProjects()` maps a row with a null priority
**When** the fallback is applied
**Then** `DEFAULT_PRIORITY` is used instead of the literal `999`

#### Scenario: fetchProject uses named constant

**Given** `fetchProject()` maps a row with a null priority
**When** the fallback is applied
**Then** `DEFAULT_PRIORITY` is used instead of the literal `999`

#### Scenario: API route uses named constant

**Given** `GET /api/projects` maps a row with a null priority
**When** the fallback is applied
**Then** `DEFAULT_PRIORITY` is used instead of the literal `999`

#### Scenario: grep finds no remaining magic 999

**Given** a search across `apps/nextjs/src/` for `?? 999`
**When** results are reviewed
**Then** zero matches are found
