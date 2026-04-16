# Proposal: Expand Deploy Hooks for Full-Stack Coverage

## Change ID
`expand-deploy-hooks`

## Summary
Add three hooks.d/post-merge scripts to cover DB migrations, Next.js dashboard, and Rust agent — currently only the Bun agent and beads import are auto-deployed.

## Context
- Extends: `deploy/hooks.d/post-merge/` (currently has 01-beads, 02-deploy)
- Related: `remote-deploy-fanout` spec (Bun agent fanout pattern)

## Why
The post-merge dispatcher already covers the Bun agent (`apps/agent/`) and beads import. But three other layers require manual deploy steps after every merge:

1. **DB migrations**: When `packages/db/` changes (new schema, new column), `pnpm db:push` must be run manually. We just hit this — the `credential_events` migration was applied manually after we noticed it didn't run automatically.
2. **Next.js dashboard**: When `apps/nextjs/` changes, `pnpm build` and `systemctl restart nexus-dashboard` must be run manually. We hit this twice this session.
3. **Rust agent**: When `crates/` changes, `cargo build --release` and `systemctl restart nexus-agent` (Rust binary) are manual. The `pre-push` hook builds Rust before push but doesn't restart on merge.

Each is a one-off frustration that compounds — every merge with a DB+UI change requires three manual steps to fully deploy.

## Requirements

### Requirement: DB migration hook
A new `deploy/hooks.d/post-merge/03-migrate` script MUST run `drizzle-kit push` (via `pnpm --filter @nexus/db db:push`) when files under `packages/db/` change between `ORIG_HEAD` and `HEAD`. Failures MUST log a warning but not block subsequent hooks.

### Requirement: Dashboard rebuild hook
A new `deploy/hooks.d/post-merge/04-dashboard` script MUST run `pnpm --filter @nexus/nextjs build` and then `systemctl --user restart nexus-dashboard` when files under `apps/nextjs/`, `packages/db/`, or `packages/core/` change. Skips on macOS (Linux-only service).

### Requirement: Rust agent rebuild hook
A new `deploy/hooks.d/post-merge/05-rust` script MUST run `cargo build --release -p nexus-agent` and restart the Rust agent service when files under `crates/` or `Cargo.toml` change. Skips on macOS (uses launchd, handled separately).

## Scope
- **IN**: Three new hooks.d scripts (DB migration, dashboard, Rust), path-conditional execution, fail-soft behavior
- **OUT**: Pre-push hook changes, install.sh changes, remote fanout for new hooks (defer to existing 02-deploy pattern), TUI rebuild

## What Changes
| Area | Change |
|------|--------|
| `deploy/hooks.d/post-merge/03-migrate` | New: drizzle-kit push when packages/db/ changes |
| `deploy/hooks.d/post-merge/04-dashboard` | New: build + restart Next.js when apps/nextjs/ changes |
| `deploy/hooks.d/post-merge/05-rust` | New: cargo build + restart Rust agent when crates/ changes |

## Risks
| Risk | Mitigation |
|------|-----------|
| `drizzle-kit push` could destructively alter production tables | Requires Postgres credentials in env; user must opt in to having infra/.tf-outputs.env loaded. Failures log warnings, don't block. |
| Dashboard rebuild adds 30s to merge time | Path-gated: only runs if apps/nextjs/ changed. Fire-and-forget restart so user sees prompt fast. |
| Cargo build is slow (~2-3min cold) | Path-gated to crates/ changes only. Most merges won't trigger it. |
