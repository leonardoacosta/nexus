# Proposal: Cleanup Residual Debt

## Change ID
`cleanup-residual-debt`

## Summary
Close the remaining 7 open beads after today's stale-bead sweeps — the real work that survived verification. Fixes: `os.hostname()` → configured agent ID (nx-hza9), `{mode: 0o600}` on nexus-status cache writes (nx-3sih), CORS server-side block (nx-xxq5), cursor pagination on /projects endpoints (nx-469c), A12 rule refinement to dismiss English-prose false positives (closes nx-mnrr + nx-9yrx), conversion of the attribution.ts credential_swaps TODO into a proper tracking bead (closes nx-fa79), and implementation of the 2 skipped session-CRUD tests that the live-PG pattern now enables (closes nx-qgnq). Explicitly defers only nx-iwu3 (B4 large-file splits, its own spec).

## Context
- Extends: `apps/agent/src/routes/projects-discovered.ts`, `apps/agent/src/routes/projects.ts`, `apps/nexus-status/src/index.ts`, `apps/agent/src/server.ts`, `apps/agent/src/db/db.test.ts`, `apps/agent/src/credentials/token-stream/attribution.ts`, `~/.claude/scripts/bin/audit-scan`, `.audit-suppressions.json`, `apps/nextjs/src/lib/agent-client.ts` (optional UI consumer updates)
- Related archives: `2026-04-17-fix-audit-scan-rules-pass2` (A9 + E7 refinements — A12 follows the same refinement pattern), `2026-04-16-fix-audit-real-debt` (filed the A5/A12 defer beads), `2026-04-16-finalize-audit-cleanup` (live-PG test infrastructure, migration-0010-orphans.test.ts pattern), `2026-04-04-fix-terminal-attach-security` (auth layer — nx-xxq5 sits on top of this)
- Related beads (all closed by this spec): nx-hza9 (P2), nx-3sih (P3), nx-xxq5 (P3), nx-469c (P3), nx-mnrr (P3), nx-9yrx (P3), nx-fa79 (P3), nx-qgnq (P3). Only nx-iwu3 (P3 B4 splits) remains after this spec — tracked as its own spec candidate.
- Session context: today closed 19 stale beads across 5 sweeps and shipped 5 specs. This spec is the final cleanup pass before the bead queue reaches a genuinely clean state (1 known-scope follow-up remaining).

## Motivation

After today's sweeps, 8 beads remain open. Three of them are not "code debt" in the usual sense and require specific treatment:

- **A12 rule false positives (nx-mnrr, nx-9yrx):** The A12 regex `^\s*//\s*(const|let|var|function|import|export|return|if|for|while)\b` matches any comment starting with a keyword — including natural English (`// return \`undefined\` so...`, `// if it needs to...`). These are not commented-out code; they're explanatory prose. The rule needs a code-syntax signal (like `=`, `()`, `;`, or `{`) in the same line to distinguish real commented-out code from English sentences.

- **nx-fa79 (credential_swaps TODO):** The TODO in `attribution.ts:42` is a deliberate placeholder for future work — when the `credential_swaps` table is added, a specific query needs to replace the current session-level fallback. This should be tracked as a proper bead for the DB schema addition, not hidden behind an A5 suppression forever. Resolve by: filing a new bead for "Add credential_swaps table", updating the comment to reference that bead, then removing the A5 suppression.

- **nx-qgnq (skipped session-CRUD tests):** The `describe.skip("requires live PG")` block predates the live-PG test harness that `migration-0010-orphans.test.ts` established. We can now implement those tests against a scratch schema like that migration test does.

The other 4 items are straightforward code fixes:
- **nx-hza9 (P2):** agent identity — `os.hostname()` is brittle under containers/k8s. Switch to the agent ID configured in `agents.toml` (same mechanism used by other agent-aware lookups).
- **nx-3sih (P3):** file permissions — add `{mode: 0o600}` to `writeFileSync` for `usage-cache.json` and `profile-cache.json` to satisfy the `credential-pool` capability spec's explicit `0o600` requirement (even though the cached data is low-sensitivity).
- **nx-xxq5 (P3):** defense-in-depth — the current `isTailscaleOrigin` check at `server.ts:108-116` only sets CORS headers conditionally; it never returns a 403 server-side. Browsers enforce CORS, but non-browser clients bypass it. The auth header is the real gate, but belt-and-suspenders is cheap here.
- **nx-469c (P3):** `GET /projects` and `GET /projects/discovered` return all rows. `projects-discovered.ts` already has a 100-cap + `truncated: true` flag — add proper cursor support alongside for callers that need it; UI consumers can adopt later.

## Requirements

### Requirement: A12 rule distinguishes commented code from English prose
The A12 rule SHALL require a code-syntax signal in the same line (one of: `=` for assignment, `()` for a call, `;` for statement terminator, or `{` for block opener) before flagging a comment as commented-out code. Comments that begin with a keyword but contain only natural-language text SHALL NOT be flagged.

### Requirement: nx-fa79 converted to proper tracking
The TODO at `apps/agent/src/credentials/token-stream/attribution.ts:42` SHALL be replaced with a comment that references a new bead tracking the `credential_swaps` table addition. After the comment update lands, the A5 suppression entry for that file path SHALL be removed.

### Requirement: Skipped session-CRUD tests implemented
The two `describe.skip("requires live PG")` tests in `apps/agent/src/db/db.test.ts:29` SHALL be implemented using the same scratch-schema pattern that `migration-0010-orphans.test.ts` uses. Tests SHALL cover: insert-and-retrieve-by-id, and null-return-for-nonexistent-id. The A5 suppression for that file SHALL be removed once tests pass.

### Requirement: Agent identity via configured agent ID
`apps/agent/src/routes/projects-discovered.ts:54` and any other sites using `os.hostname()` for agent lookups SHALL switch to reading the agent ID from configuration (same mechanism that `packages/core/src/config.ts` uses to expand `agents.toml`). Behavior SHALL be unchanged when hostname happens to match the configured ID; fixed when it doesn't (containers, k8s, custom hostnames).

### Requirement: Restrictive permissions on nexus-status cache files
`apps/nexus-status/src/index.ts` lines 266 and 304 SHALL pass `{mode: 0o600}` to `writeFileSync` for `usage-cache.json` and `profile-cache.json`. This matches the explicit requirement in `openspec/specs/credential-pool/spec.md` lines 13/54/80.

### Requirement: CORS server-side defense-in-depth
Requests from non-Tailscale origins SHALL receive a `403 Forbidden` response from the agent HTTP server, not just a missing CORS header. Auth (via `x-nexus-secret`) remains the primary gate; this check is belt-and-suspenders for non-browser clients. CORS preflight (OPTIONS) requests SHALL remain exempt from the origin check so browsers can negotiate headers.

### Requirement: Cursor pagination on project endpoints
`GET /projects` and `GET /projects/discovered` SHALL accept optional `cursor` and `limit` query parameters (default `limit=50`, max `limit=200`). Responses SHALL include `nextCursor` when more results are available. The existing `truncated: true` flag on `/projects/discovered` SHALL be preserved as a simpler fallback for callers that don't paginate; callers using `cursor` get accurate windowed results.

### Requirement: Suppression cleanup after fixes
After the A12 rule refinement lands and after the A5 resolutions, the corresponding entries in `.audit-suppressions.json` SHALL be removed: A5 for `attribution.ts` (replaced by bead-referenced comment), A5 for `db.test.ts` (tests implemented), A12 for `socket-server.test.ts` (rule no longer false-flags), A12 for `session-manager.ts` (same).

## Scope

- **IN**: All 7 bead closures (nx-hza9, nx-3sih, nx-xxq5, nx-469c, nx-mnrr, nx-9yrx, nx-fa79, nx-qgnq); A12 rule refinement + fixture tests; file credential_swaps tracking bead; implement 2 session-CRUD tests; update .audit-suppressions.json to remove now-unneeded entries; update integration test baselines
- **OUT**: nx-iwu3 (B4 large-file production splits — its own spec candidate); UI consumer updates for cursor pagination (follow-up if needed — server-side support unblocks them); any changes to the `credential_swaps` table itself (new bead filed, not implemented)

## Impact

| Area | Change |
|------|--------|
| `~/.claude/scripts/bin/audit-scan` (A12 block) | Tighten regex: require `=`, `()`, `;`, or `{` present on same line after keyword |
| `apps/agent/src/credentials/token-stream/attribution.ts:42` | Update TODO comment to reference newly-filed tracking bead (e.g., "// See nx-XXXX for credential_swaps table implementation") |
| `apps/agent/src/db/db.test.ts:29` | Implement 2 session-CRUD tests using scratch-schema pattern from `migration-0010-orphans.test.ts` |
| `apps/agent/src/routes/projects-discovered.ts:54` | Replace `os.hostname()` with config-sourced agent ID lookup |
| `apps/nexus-status/src/index.ts:266,304` | Add `{mode: 0o600}` to both `writeFileSync` calls |
| `apps/agent/src/server.ts` (`isTailscaleOrigin`) | Add server-side 403 for non-Tailscale origins on non-OPTIONS requests; preserve header-setting behavior for Tailscale |
| `apps/agent/src/routes/projects.ts`, `apps/agent/src/routes/projects-discovered.ts` | Accept `cursor` + `limit` query params; return `nextCursor` in response |
| `.audit-suppressions.json` | Remove 4 stale entries (A5×2, A12×2) after their underlying issues are resolved |
| `packages/core/src/audit-suppressions.integration.test.ts` | Update baselines: A12=0 (was suppressed), A5 in production code=0 (was suppressed), fixture tests for A12 refinement |
| `.beads/` | File 1 new bead (credential_swaps table tracking, P3 audit-debt) |

## Risks

| Risk | Mitigation |
|------|-----------|
| A12 rule refinement miss-classifies a real commented-out code block (false negative) | Add positive fixture: `// const x = 1;` (has `=` and `;`) must still flag. Add negative fixture: `// if the user clicks...` (English prose) must NOT flag. The refinement is strictly tighter than before, so false-negative risk is bounded by the signal-syntax requirement |
| `os.hostname()` → configured agent ID breaks existing single-machine deploys | Fall back to `os.hostname()` when no agent ID is configured in `agents.toml`. This preserves current behavior for default setups while fixing container/k8s cases |
| CORS 403 blocks legitimate non-browser tooling | `x-nexus-secret` auth remains the real gate; the 403 only fires when Origin header is set AND non-Tailscale. curl without Origin header passes through. Document this precisely — non-browser auth clients that set arbitrary Origin will 403 |
| Cursor pagination default limit=50 is too low for some callers | `truncated: true` flag remains for callers that don't paginate; clients get either the paginated window OR the capped 100-item array — never a breaking change |
| Skipped session-CRUD tests require specific PG state that the scratch-schema pattern can't provide | Use the same `mkdtemp`-style scratch-schema approach the migration test uses; if the tests need production-like data, fall back to seeding via the test helper. Failure mode: if PG isn't available, tests skip cleanly (existing pattern) |
| credential_swaps TODO conversion creates a bead that never gets worked | That's fine — the bead is better tracking than a comment. P3 + audit-debt label keeps it discoverable. If it's not valuable enough to do, the bead itself can be closed with reason |
| Removing .audit-suppressions.json entries too early breaks the integration test | Sequence in apply: fix code FIRST (A12 rule patch, TODO resolution, test implementation), verify audit-scan output is clean, THEN remove suppression entries, THEN update test baselines. Infra and Cleanup tasks sequenced accordingly |

## Open Questions

- **Cursor pagination shape** — opaque-token cursor (base64-encoded offset or ID) vs explicit `offset`+`limit`? Recommend opaque-token for API evolvability; document that current implementation uses base64(project.id) for `/projects` and base64(relative_path) for `/projects/discovered`, but callers should treat as opaque.
- **CORS 403 preflight exemption** — preflight passes when `x-nexus-secret` is not required on OPTIONS (current behavior). Confirm in implementation that the 403 adds after the existing preflight exemption so preflight still works.
- **A12 signal list tightness** — `= () ; {` covers most commented TS code patterns. Does `[` (array access / destructuring) need inclusion? Probably rare in commented-out lines; skip unless a fixture miss shows up.
