# Implementation Tasks

<!-- beads:epic:nx-tik7 -->

## Infra Batch

- [x] [1.1] [P-1] Add A2+F2 CLI-script suppression entries to .audit-suppressions.json (apps/agent/src/scripts/**, packages/db/src/migrate.ts) with reason fields [owner:devops-engineer] [beads:nx-hfs5]
- [x] [1.2] [P-1] Add E5 boot-path suppression entries (config.ts, config-loader.ts, spec-watcher.ts, command-registry.ts, agent-registry.ts, nexus-status/src/**) with reason fields [owner:devops-engineer] [beads:nx-ylpt]
- [x] [1.3] [P-1] Add D4 trusted-exec suppression entries (safe-spawn.ts self-ref, nexus-status git probes, agent-registry tailscale) with reason fields [owner:devops-engineer] [beads:nx-5wpm]
- [x] [1.4] [P-2] Run scripts/validate-audit-suppressions.sh; assert exit 0 [owner:devops-engineer] [beads:nx-3ecj]
- [x] [1.5] [P-2] File P3 beads issue for 3 real UI F2 sites (CommandPalette.tsx:136,139 + LazyTerminalPanel.tsx:8); label audit-debt (filed as nx-agsx) [owner:devops-engineer] [beads:nx-y7r2]

## E2E Batch

- [x] [2.1] [P-1] Extend audit-suppressions.integration.test.ts with A2=0, E5=0, D4=0, F2=3 baseline assertions [owner:test-writer] [beads:nx-5de9]
- [x] [2.2] [P-1] Update integration-test score assertion threshold to composite >= 83 with documented rationale [owner:test-writer] [beads:nx-9xhb]
- [x] [2.3] [P-2] Run full audit-scan; document new composite baseline in test comments; verify suppressions counter reflects added entries [owner:e2e-engineer] [beads:nx-f1ev]
