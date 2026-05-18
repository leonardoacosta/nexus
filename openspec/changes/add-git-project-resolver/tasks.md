# Tasks: add-git-project-resolver

- [x] 1.1 Drizzle migration: ALTER TABLE sessions ADD git_provider (text), git_owner_repo (text)
- [x] 1.2 Implement `services/git-project.ts` — exec `git remote get-url origin`, parse 3 URL forms
- [x] 1.3 Wire into `handleSessionStart` — done via `services/process-hook-event.ts` (nx-oh0j6). Socket `session_start` invokes the helper which calls `resolveGitOrigin(cwd)` → `updateSessionGitOrigin(db, sessionId, …)`. `routes/sessions.ts:handleSessionStart` (managed-spawn endpoint) fires the same resolver after the row upsert. Both paths persist `git_provider` + `git_owner_repo` on the session row.
- [x] 1.4 Unit tests: 3 URL forms + non-git-repo case + malformed URL case
- [x] 1.5 Backfill: one-shot script to resolve git_provider+git_owner_repo for existing active sessions
