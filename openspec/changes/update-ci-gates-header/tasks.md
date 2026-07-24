---
stack: t3
---
<!-- beads:epic:nx-yn00u -->
<!-- beads:feature:nx-xapdr -->

# Tasks — update-ci-gates-header

## API Batch

- [x] 1.1 Enumerate current warnings: run `eslint .` in each workspace with a `lint` script (`apps/web`, `packages/core`, `packages/db`, `apps/nexus-emit`, `apps/nexus-statusline`; confirm the list via `grep -l '"lint"' */*/package.json`). Record the warning inventory in the commit message. [type:api] [beads:nx-lpaoy]
- [x] 1.2 Fix the enumerated warnings — known: `apps/web/src/hooks/useMobileKeyboardBridge.ts:32`. If any warning fix requires a behavior change, STOP and file it as a separate bead instead of suppressing. [type:api] [beads:nx-263si]
  - touches: `apps/web/src/hooks/useMobileKeyboardBridge.ts`
- [x] 1.3 Add `--max-warnings 0` to each workspace `lint` script that is bare `eslint .`. [type:config] [beads:nx-brxpt]
  - touches: `apps/web/package.json`, `packages/core/package.json`, `packages/db/package.json`, `apps/nexus-emit/package.json`, `apps/nexus-statusline/package.json`
- [x] 1.4 Replace the `PRE-EXISTING RED GATES` header block (`.github/workflows/ci.yml:8-19` at base) with a short note: all gates blocking and green as of this change; do not add `continue-on-error`. [type:config] [beads:nx-9auh8]
  - touches: `.github/workflows/ci.yml`

## E2E Batch

- [ ] 2.1 Verify: push branch, confirm the CI run is green with the ratchet active; paste the run summary. `grep -n 'PRE-EXISTING RED' .github/workflows/ci.yml` returns nothing. [type:testing] [beads:nx-rz3q2]
