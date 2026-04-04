# Implementation Tasks

<!-- beads:epic:nx-hvj -->

## Config Batch

- [x] [1.1] [P-1] Create `tsconfig.base.json` at workspace root with shared compilerOptions, no rootDir/outDir/include/exclude [owner:types-engineer] [beads:nx-age]
- [x] [1.2] [P-1] Rewrite root `tsconfig.json` to references-only: `files: []` + `references` array for all 6 TS packages [owner:types-engineer] [beads:nx-ej0]
- [x] [1.3] [P-2] Update `packages/core/tsconfig.json`: extends → `tsconfig.base.json`, add `composite: true` [owner:types-engineer] [beads:nx-32p]
- [x] [1.4] [P-2] Update `packages/db/tsconfig.json`: extends → `tsconfig.base.json`, add `composite: true` [owner:types-engineer] [beads:nx-p0x]
- [x] [1.5] [P-2] Update `packages/ui/tsconfig.json`: extends → `tsconfig.base.json`, add `composite: true` [owner:types-engineer] [beads:nx-590]
- [x] [1.6] [P-2] Update `apps/agent/tsconfig.json`: extends → `tsconfig.base.json`, add `composite: true` [owner:types-engineer] [beads:nx-8pg]
- [x] [1.7] [P-2] Update `apps/nextjs/tsconfig.json`: extends → `tsconfig.base.json`, add `composite: true` (retain `noEmit: true`) [owner:types-engineer] [beads:nx-whq]
- [x] [1.8] [P-2] Update `apps/nexus-register/tsconfig.json`: extends → `tsconfig.base.json`, add `composite: true` [owner:types-engineer] [beads:nx-8ji]

## Validation Batch

- [x] [2.1] [P-1] Run `pnpm typecheck` from workspace root — must exit 0 with zero errors [owner:types-engineer] [beads:nx-chv]
- [x] [2.2] [P-1] Run `tsc --build` from workspace root — must produce `.tsbuildinfo` in each package dist/ [owner:types-engineer] [beads:nx-z0e]
- [x] [2.3] [P-2] Verify LSP: open `packages/core/src/types/session.ts` — no "not under rootDir" diagnostic [owner:types-engineer] [beads:nx-87c]
- [x] [2.4] [P-2] Verify LSP: open `apps/nextjs/src/app/layout.tsx` — no "Cannot find module 'next'" diagnostic [owner:types-engineer] [beads:nx-fw5]
