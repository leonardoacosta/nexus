# Proposal: SQL Injection Hardening — Credential Pool

## Change ID
`harden-sql-credential-pool`

## Summary
Replace raw `sql` tagged template interpolations in the credential pool with Drizzle's type-safe query builder methods, and add a CI grep guard to prevent future regressions.

## Context
- Extends: `apps/agent/src/credentials/pool.ts` (4 `sql` template usages at lines 115, 230, 332, 333)
- Extends: `apps/nexus-register/src/register.test.ts` (audit `Bun.spawn()` at line 29 for input validation)
- Related: [ARCHIVED] `2026-04-04-fix-credential-mgmt-security` — covered transaction safety (`SELECT FOR UPDATE`) but not SQL interpolation patterns
- Related: `openspec/specs/credential-pool/spec.md` — 8 existing requirements, none address query construction safety

## Motivation
Code audit flagged 4 instances where Drizzle's `sql` tagged template literal is used with column
references and runtime values in `pool.ts`. While Drizzle's `sql` tag does parameterize interpolated
values, the pattern is fragile: it bypasses Drizzle's type-safe query builder, making it easy to
accidentally introduce actual string concatenation in future edits. Three of the four usages can be
replaced with Drizzle's first-class `asc()`, `gt()`, `gte()` operators and `sql.raw()` for the
`NULLS FIRST` clause. The fourth (line 230) uses `sql` for an atomic increment — this is the
idiomatic Drizzle pattern for `SET col = col + 1` and is correctly parameterized, but should be
annotated with a safety comment.

Additionally, `register.test.ts` uses `Bun.spawn()` with array-form arguments (not shell string),
which is inherently safe against injection. The `command` parameter comes from test constants, not
user input. This should be documented as reviewed-and-safe.

A CI grep guard will prevent future raw SQL string concatenation from entering the codebase.

## Requirements

### Req-1: Replace raw sql tagged templates with type-safe Drizzle operators
Lines 115, 332, 333 in `pool.ts` SHALL be rewritten using Drizzle's type-safe query builder
methods (`asc()`, `gt()`, `gte()`) instead of `sql` tagged template literals. Line 230 (atomic
increment) SHALL retain the `sql` tag with an explicit `// SAFE: Drizzle sql tag parameterizes
column ref + literal` comment.

### Req-2: Add CI grep guard against raw SQL interpolation
A script or package.json task SHALL scan `apps/` and `packages/` for dangerous SQL patterns
(string concatenation inside SQL queries, `${}` inside non-tagged template strings near SQL
keywords) and fail CI if any are found.

### Req-3: Audit and document register.test.ts spawn safety
The `Bun.spawn()` call in `register.test.ts` SHALL be reviewed and annotated confirming that
arguments are array-form (not shell string) and all inputs are test constants.

## Scope
- **IN**: pool.ts query builder migration (4 sites), register.test.ts audit, CI grep guard script
- **OUT**: Drizzle schema changes, credential pool behavior changes, new test coverage for SQL injection (pool behavior is unchanged), other files outside credential domain

## Impact
| Area | Change |
|------|--------|
| `apps/agent/src/credentials/pool.ts` | Replace 3 `sql` tagged templates with type-safe operators; annotate 1 |
| `apps/nexus-register/src/register.test.ts` | Add safety annotation comment |
| `package.json` or `scripts/` | Add `lint:sql-safety` check |
| CI pipeline | Hook `lint:sql-safety` into lint task |

## Risks
| Risk | Mitigation |
|------|-----------|
| Query behavior change from operator migration | Drizzle operators produce identical SQL; verify with `bun test` on credential suite |
| NULLS FIRST not supported by Drizzle operator API | Use `sql.raw('NULLS FIRST')` (static string, no interpolation) appended to `asc()` |
| Grep guard false positives | Tune pattern to exclude Drizzle `sql` tag with column refs; allowlist annotated lines |
