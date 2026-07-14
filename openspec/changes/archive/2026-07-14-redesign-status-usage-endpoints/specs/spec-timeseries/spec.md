## REMOVED Requirements

### Requirement: The system MUST expose project status over HTTP

**Reason**: `GET /projects/:id/status` is absorbed into `GET /statusline?sessionId=<id>`'s
`session.project` field (`redesign-status-usage-endpoints`, `session-persistence` delta), which
resolves the same `project_status_snapshots` latest row via `sessions.projectId -> projects.name`
instead of requiring the caller to know the project code directly. The underlying persistence
(`project_status_snapshots` writes, retention, the `?history=` time-series shape) is entirely
unchanged — only the direct-by-project-code HTTP GET is retired.

**Migration**: Callers that queried `GET /projects/:id/status` for a project's latest status now
resolve a session belonging to that project and call `GET /statusline?sessionId=<id>` instead.
Callers needing the `?history=<days>` time series (unchanged, not retired by this proposal)
continue to need a project-code-keyed lookup — this proposal does not add a `?history=` mode to
`GET /statusline`; a follow-up may restore a narrow `GET /projects/:id/status?history=` route
scoped to that use case if a real caller needs it.
