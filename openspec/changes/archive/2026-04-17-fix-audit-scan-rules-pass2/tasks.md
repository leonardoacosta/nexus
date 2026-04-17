# Implementation Tasks

<!-- beads:epic:nx-1xnm -->

## Infra Batch

- [x] [1.1] [P-1] Patch A9 rule in audit-scan: expand catch lookahead to chain-terminal, recognize safeFireAndForget wrapper [owner:devops-engineer] [beads:nx-tm4f]
- [x] [1.2] [P-1] Patch E7 rule in audit-scan: skip Bun.serve fetch method-shorthand (first-arg named req/request) [owner:devops-engineer] [beads:nx-xnzd]
- [x] [1.3] [P-2] Remove stale A9 + E7 suppressions from .audit-suppressions.json (A9 for 3 paths, E7 for server.ts); verify CI lint still passes [owner:devops-engineer] [beads:nx-3nf1]

## E2E Batch

- [x] [2.1] [P-1] Add A9 fixture tests: chain-terminal catch (skip), separate chains without catch (flag both), safeFireAndForget wrapper (skip) [owner:test-writer] [beads:nx-fv4z]
- [x] [2.2] [P-1] Add E7 fixture tests: Bun.serve fetch(req) shorthand (skip), normal fetch() call (flag), non-conventional shorthand fetch(url) (conservative — flag) [owner:test-writer] [beads:nx-cdbk]
- [x] [2.3] [P-2] Run full audit-scan against nx repo; verify A9=0, E7=0, score unchanged at 99; close nx-at1t and nx-77ra [owner:e2e-engineer] [beads:nx-4uej]
