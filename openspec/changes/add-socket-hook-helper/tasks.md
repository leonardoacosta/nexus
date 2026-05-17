# Tasks: add-socket-hook-helper

- [ ] 1.1 Decide: small Bun-compiled binary OR shell wrapper using `nc -U` (prefer binary for robustness)
- [ ] 1.2 Implement helper at `apps/nexus-emit/src/index.ts` (or shell at `deploy/nexus-emit.sh`)
- [ ] 1.3 Add to deploy hooks (post-merge / pre-push) so it gets installed alongside nexus-agent
- [ ] 1.4 Install path: `~/.local/bin/nexus-emit`
- [ ] 1.5 Unit test: payload-to-socket frame round-trip
- [ ] 1.6 Integration test: invoke helper, verify agent receives + dispatches event
