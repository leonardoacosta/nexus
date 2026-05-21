# spec-page-live Delta

## ADDED Requirements

### Requirement: spec-status-patch-endpoint
The agent MUST expose `PATCH /specs/{project}/{name}/status` accepting `{ status: "draft" | "approved" }`. The endpoint MUST update the spec's `proposal.md` frontmatter atomically via the same `.tmp + os.replace` write pattern shipped by `/triage`. Setting `approved` MUST also write `approved-by` (from `git config user.email` fallback `$USER` fallback `"unknown"`) and `approved-at` (ISO-8601 with timezone). Setting `draft` MUST remove `approved-by` and `approved-at`. The endpoint MUST emit a `SpecTransition` event on the `/specs/events` SSE stream so all connected clients re-render.

#### Scenario: flip draft to approved
- **Given** `openspec/changes/fix-foo/proposal.md` has frontmatter `status: draft`
- **When** `PATCH /specs/nx/fix-foo/status { status: "approved" }` is called
- **Then** the file's frontmatter contains `status: approved`, `approved-by: <user-email>`, and `approved-at: <iso-timestamp>`; the response is `200 { status: "approved", approved_by, approved_at }`; an SSE `SpecTransition { kind: "status_change", to: "approved" }` event fires

#### Scenario: flip approved back to draft
- **Given** the spec has `status: approved` with `approved-by` and `approved-at` populated
- **When** `PATCH /specs/nx/fix-foo/status { status: "draft" }` is called
- **Then** the frontmatter has `status: draft` and both `approved-by` and `approved-at` keys are removed; the response is `200 { status: "draft" }`; an SSE transition event fires

#### Scenario: invalid status value
- **Given** any spec
- **When** `PATCH /specs/nx/fix-foo/status { status: "merged" }` is called
- **Then** the response is `400 { error: "status must be one of: draft, approved" }` and the file is untouched

#### Scenario: archived spec is read-only
- **Given** the spec is under `openspec/changes/archive/<date>-fix-foo/`
- **When** the PATCH is called
- **Then** the response is `409 { error: "archived specs are read-only" }` and the file is untouched

### Requirement: spec-frontmatter-readback
The agent MUST expose the parsed frontmatter on `GET /specs/{project}/{name}` so the Swift dashboard renders a metadata pane without re-reading the markdown. The response MUST include `frontmatter: Record<string, string>` containing every top-level YAML key. Keys MUST be preserved verbatim (no case normalisation). Missing frontmatter block returns `frontmatter: {}`.

#### Scenario: spec with full frontmatter
- **Given** the spec has `status: approved`, `approved-by: leo@host`, `approved-at: 2026-05-21T11:02:40-05:00`, `capability: cron-persistence`
- **When** `GET /specs/nx/fix-foo` is called
- **Then** the response includes `frontmatter: { status: "approved", "approved-by": "leo@host", "approved-at": "...", capability: "cron-persistence" }`

#### Scenario: spec with no frontmatter
- **Given** the spec's `proposal.md` does not begin with `---`
- **When** the endpoint is called
- **Then** the response includes `frontmatter: {}`
