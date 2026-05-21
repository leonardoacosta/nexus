# Design: fix-credential-source-divergence

## Why the nx-t2q5n one-line fix is insufficient (exploration 2026-05-19)

Three diverged subsystems, traced:
- `cc-credential-manager.ts:39` → `~/.claude/credentials.json` (no dot) — WRONG, file absent.
- `credentials/active-credential-watcher.ts:36` → `~/.claude/.credentials.json` (dot) — CORRECT, file present.
- `routes/credentials/handlers-crud.ts:83` `handleListCredentials()` → `pool.list()` → credential pool DB, fed by `credential-watcher.ts` from `~/.config/nexus/credentials/acct-*.json` — a THIRD source, unrelated to the real auth file. **This is what the dashboard reads.**

So fixing `cc-credential-manager.ts:39` alone changes a subsystem the dashboard doesn't even read. The dashboard stays empty.

## Decision

Two parts:
1. **Path correctness**: `cc-credential-manager` default → `.credentials.json`; reconcile all no-dot refs. (Necessary; fixes the active-management subsystem.)
2. **Canonical source for `/credentials`**: designate one owner so the endpoint reflects the real `~/.claude/.credentials.json`. Implementation seam: `active-credential-watcher` already reads the correct dotted file and computes a fingerprint/snapshot — wire that snapshot into what `/credentials` serves (or have `handleListCredentials` consult the active-credential snapshot in addition to the pool). Decide during API batch which is cleanest; the requirement is the endpoint reflects reality, not which table.

## Rejected

- **Only fix the path** (the original nx-t2q5n scope) — leaves the dashboard empty because `/credentials` reads the pool, not the manager.
- **Populate the pool from `~/.config/nexus/credentials/`** as the "fix" — that's a different credential-import flow; it does not represent the machine's actual active Claude Code auth, which is the dotted file.

## Out of scope

- Credential rotation/refresh logic (works once the path is correct).
- The `~/.config/nexus/credentials/acct-*.json` pool-import flow (separate feature).
