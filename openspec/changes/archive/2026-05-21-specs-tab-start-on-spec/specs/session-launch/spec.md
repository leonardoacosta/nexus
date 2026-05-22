# session-launch Delta

## ADDED Requirements

### Requirement: spec-session-link-table
The database MUST contain a `spec_sessions` table joining specs to sessions with the following columns: `id` (primary key, identity), `project` (text, not null), `spec_name` (text, not null), `session_id` (text, not null), `created_at` (timestamptz default now()). The table MUST have a composite index on `(project, spec_name)` and a single-column index on `session_id`. Rows persist after the session ends; deletion is not part of normal lifecycle.

#### Scenario: insert on POST /session/start with spec_slug
- **Given** the table is empty and a valid spec `nx/fix-foo` exists
- **When** `POST /session/start { project: "nx", path: "/Users/leonardoacosta/dev/nx", spec_slug: "fix-foo" }` is called
- **Then** the tmux window spawn succeeds, a `spec_sessions` row is inserted with `project: "nx"`, `spec_name: "fix-foo"`, and `session_id` matching the returned session name, and the API response includes `{ session_name, started: true, spec_linked: true }`

#### Scenario: POST /session/start without spec_slug leaves the table untouched
- **Given** the table is empty
- **When** `POST /session/start { project: "nx", path: "/Users/leonardoacosta/dev/nx" }` is called (no `spec_slug`)
- **Then** the response is `{ session_name, started: true }` with no `spec_linked` field and no `spec_sessions` row is inserted

#### Scenario: insert with unknown spec_slug
- **Given** no spec at `openspec/changes/<spec_slug>` exists
- **When** `POST /session/start { project, path, spec_slug: "no-such-spec" }` is called
- **Then** the tmux window spawn proceeds, NO row is inserted, and the response carries `{ session_name, started: true, spec_linked: false, spec_link_error: "spec not found" }`. The session is real; the link silently degrades.

### Requirement: spec-session-list-endpoint
The agent MUST expose `GET /specs/{project}/{name}/sessions` returning every `spec_sessions` row for the given spec, ordered by `created_at` descending. The response shape is `{ sessions: Array<{ id, session_id, created_at, active: boolean }> }` where `active` is derived by joining against the live sessions registry.

#### Scenario: no linked sessions
- **Given** `nx/fix-foo` has zero `spec_sessions` rows
- **When** `GET /specs/nx/fix-foo/sessions` is called
- **Then** the response is `200 { sessions: [] }`

#### Scenario: one historical, one active
- **Given** `nx/fix-foo` has two `spec_sessions` rows; the first session has exited tmux, the second is still live
- **When** the endpoint is called
- **Then** the response contains both rows ordered newest-first, with `active: true` on the live one and `active: false` on the exited one

#### Scenario: unknown spec returns 404
- **Given** no spec directory exists at `openspec/changes/no-such-spec` or `openspec/changes/archive/<date>-no-such-spec`
- **When** `GET /specs/nx/no-such-spec/sessions` is called
- **Then** the response is `404 { error: "spec not found" }`
