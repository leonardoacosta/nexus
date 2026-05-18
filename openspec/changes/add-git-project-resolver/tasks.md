# Tasks: add-git-project-resolver

- [x] 1.1 Drizzle migration: ALTER TABLE sessions ADD git_provider (text), git_owner_repo (text)
- [x] 1.2 Implement `services/git-project.ts` — exec `git remote get-url origin`, parse 3 URL forms
- [x] 1.3 Wire into `handleSessionStart` in `routes/hooks.ts`
- [x] 1.4 Unit tests: 3 URL forms + non-git-repo case + malformed URL case
- [x] 1.5 Backfill: one-shot script to resolve git_provider+git_owner_repo for existing active sessions
