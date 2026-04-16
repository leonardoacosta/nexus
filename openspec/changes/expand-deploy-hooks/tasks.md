# Implementation Tasks

<!-- beads:epic:nx-rkae -->

## DB Batch

(no DB schema changes — this spec is purely about deploy automation)

## API Batch

(no API changes)

## Ops Batch

- [x] [5.1] [P-1] Create `deploy/hooks.d/post-merge/03-migrate` script — runs `pnpm --filter @nexus/db db:push` when packages/db/ changes, sources infra/.tf-outputs.env for POSTGRES_URL [owner:devops-engineer] [beads:nx-iwar]
- [x] [5.2] [P-1] Create `deploy/hooks.d/post-merge/04-dashboard` script — builds Next.js and restarts nexus-dashboard service when apps/nextjs/, packages/db/, or packages/core/ changes (Linux only) [owner:devops-engineer] [beads:nx-w10e]
- [x] [5.3] [P-1] Create `deploy/hooks.d/post-merge/05-rust` script — runs cargo build --release when crates/ or Cargo.* changes, restarts Rust service if installed (Linux only) [owner:devops-engineer] [beads:nx-sr9b]
- [x] [5.4] [P-2] chmod +x all three new hook scripts so the dispatcher can execute them [owner:devops-engineer] [beads:nx-7wua]

## UI Batch

(no UI changes)

## E2E Batch

- [ ] [4.1] [deferred] Verify post-merge runs all hooks in order on a multi-domain merge (DB + UI + agent change) [owner:e2e-engineer] [beads:nx-96rp]
