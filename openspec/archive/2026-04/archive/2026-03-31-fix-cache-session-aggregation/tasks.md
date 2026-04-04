# Implementation Tasks

<!-- beads:epic:TBD -->

## UI Batch

- [ ] [1.1] [P-1] Add `cached_sessions: Vec<SessionRow>` and `cached_project_summaries: Vec<ProjectSummary>` fields to the App struct with empty initial values [owner:ui-engineer]
- [ ] [1.2] [P-1] Extract the body of `all_sessions()` into a private `recompute_sessions(&self) -> Vec<SessionRow>` method [owner:ui-engineer]
- [ ] [1.3] [P-1] Extract the body of `project_summaries()` into a private `recompute_project_summaries(&self) -> Vec<ProjectSummary>` method [owner:ui-engineer]
- [ ] [1.4] [P-2] Call `recompute_sessions` and `recompute_project_summaries` at the end of `update_agents` to populate the cache fields [owner:ui-engineer]
- [ ] [1.5] [P-2] Add `pub fn cached_sessions(&self) -> &[SessionRow]` and `pub fn cached_project_summaries(&self) -> &[ProjectSummary]` accessors [owner:ui-engineer]
- [ ] [1.6] [P-3] Update all call sites in app.rs, main.rs, screens/dashboard.rs, and screens/projects.rs to use the cached accessors instead of `all_sessions()` / `project_summaries()` [owner:ui-engineer]
- [ ] [1.7] [P-3] Remove or deprecate the public `all_sessions()` and `project_summaries()` methods [owner:ui-engineer]
