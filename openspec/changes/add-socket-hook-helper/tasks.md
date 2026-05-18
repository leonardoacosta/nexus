# Tasks: add-socket-hook-helper

- [x] 1.1 Decide: small Bun-compiled binary OR shell wrapper using `nc -U` (prefer binary for robustness)
- [x] 1.2 Implement helper at `apps/nexus-emit/src/index.ts` (or shell at `deploy/nexus-emit.sh`)
- [x] 1.3 Add to deploy hooks (post-merge / pre-push) so it gets installed alongside nexus-agent
- [x] 1.4 Install path: `~/.local/bin/nexus-emit`
- [x] 1.5 Unit test: payload-to-socket frame round-trip
- [x] 1.6 Integration test: invoke helper, verify agent receives + dispatches event
