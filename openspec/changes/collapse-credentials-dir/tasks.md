# Tasks: collapse-credentials-dir

- [ ] 1.1 Inventory current `apps/agent/src/credentials/*` files and consumers
- [ ] 1.2 Create placeholder `apps/agent/src/cc-credential-manager.ts` with stub for CC profile tracking (full impl in P4.6)
- [ ] 1.3 Migrate any active-credential-watcher / token-stream logic the agent still needs into the placeholder
- [ ] 1.4 `git rm -r apps/agent/src/credentials/`
- [ ] 1.5 Update imports across `apps/agent/src/` via `safe-rename` for affected symbols
- [ ] 1.6 Run typecheck + test suite — green
