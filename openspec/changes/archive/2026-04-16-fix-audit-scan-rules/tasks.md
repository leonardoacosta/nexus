# Implementation Tasks

<!-- beads:epic:nx-4by3 -->

## Infra Batch

- [x] [1.1] [P-1] Patch B2 regex in ~/.claude/scripts/bin/audit-scan to require path-after-package; update finding message [owner:devops-engineer] [beads:nx-ah62]
- [x] [1.2] [P-1] Patch A9 detection in ~/.claude/scripts/bin/audit-scan to skip `void <expr>;` lines [owner:devops-engineer] [beads:nx-p5s4]
- [x] [1.3] [P-2] Add audit-scan unit test fixtures: B2 barrel (skip), B2 deep (flag), A9 void (skip), A9 then-no-catch (flag), A9 bare-async (flag) [owner:test-writer] [beads:nx-4f4p]

## E2E Batch

- [x] [2.1] [P-1] Extend packages/core/src/audit-suppressions.integration.test.ts with B2-count-zero assertion for nx repo [owner:test-writer] [beads:nx-ymtb]
- [x] [2.2] [P-1] Extend same integration test with A9-count-matches-documented-baseline assertion (expected: 3 real unhandled rejections) [owner:test-writer] [beads:nx-3r9g]
- [x] [2.3] [P-2] Run full audit-scan against nx repo; verify composite score moves; document new baseline in test comments [owner:e2e-engineer] [beads:nx-rj4d]
