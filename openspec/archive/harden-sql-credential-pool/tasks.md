# Implementation Tasks

<!-- beads:epic:nx-c68j -->

## Security Batch

- [x] [1.1] [P-1] Replace `sql` tagged template at pool.ts:115 with `asc(credentials.rateLimitCount)` + `asc(credentials.leasedAt)` + `sql.raw('NULLS FIRST')` in `.orderBy()` [owner:security-engineer] [beads:nx-5ofw]
- [x] [1.2] [P-1] Annotate `sql` tagged template at pool.ts:230 (atomic increment) with `// SAFE: Drizzle sql tag parameterizes column ref + literal` comment [owner:security-engineer] [beads:nx-cgg1]
- [x] [1.3] [P-1] Replace `sql` tagged template at pool.ts:332 with `gt(credentials.rateLimitCount, 0)` [owner:security-engineer] [beads:nx-qtmx]
- [x] [1.4] [P-1] Replace `sql` tagged template at pool.ts:333 with `gte(credentials.leasedAt, windowStart)` [owner:security-engineer] [beads:nx-6vpv]
- [x] [1.5] [P-2] Run `bun test` on credential test suite to verify query behavior unchanged [owner:security-engineer] [beads:nx-ofpf]

## Audit Batch

- [x] [2.1] [P-2] Review and annotate `Bun.spawn()` in register.test.ts:29 with `// SAFE: array-form args, no shell interpolation, test constants only` [owner:security-engineer] [beads:nx-nfab]

## CI Batch

- [x] [3.1] [P-1] Create `scripts/lint-sql-safety.sh` grep guard scanning `apps/` and `packages/` for raw SQL interpolation patterns (exclude `// SAFE:` annotated lines) [owner:devops-engineer]
- [x] [3.2] [P-2] Add `lint:sql-safety` script to root `package.json` and wire into `turbo lint` pipeline [owner:devops-engineer]
