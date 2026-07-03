# Plan 008: Stop the credential watcher from re-inserting a duplicate row for the same fingerprint on every token refresh and agent restart

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` if that file exists — unless a reviewer dispatched you
> and told you they maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 64a206ff..HEAD -- apps/agent/src/credentials/pool/pool-core.ts apps/agent/src/credentials/credential-watcher.ts packages/db/src/schema/credentials.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/007-add-credential-encryption-tests.md` (land 007 first so the crypto/encryption boundary has a characterization net before pool-selection code is touched)
- **Category**: bug
- **Planned at**: commit `64a206ff`, 2026-07-03

## Why this matters

`CredentialPool.add()` unconditionally `INSERT`s a new row (fresh `randomUUID()`
id) for every credential file it processes. The watcher calls `add()` for every
`acct-*.json` on **every agent restart** (`runInitialScan`) and on **every live
file change** (`handleFileEvent`). A Claude Code OAuth **token auto-refresh**
rewrites `acct-*.json` in place — the access token changes but the *refresh
token stays the same* (the fingerprint is `SHA-256(claudeAiOauth.refreshToken)`,
which is stable across access-token refreshes). Because nothing dedupes on
fingerprint, each refresh and each restart appends yet another `credentials`
row for the same account: unbounded table growth.

Worse than bloat: `add()`'s "newest mtime wins" promotion makes each fresh
duplicate the `is_primary` (leaseable) row and demotes the prior primary. If the
demoted row was `leased`/`cooldown`, that lease / rate-limit / cooldown state is
silently dropped, and a fresh `available` clone gets handed out for an account
that is actually rate-limited — defeating the whole rate-limit rotation system.

After this plan: re-importing the **same** credential file updates the existing
row in place (preserving its `status` / `leasedBy` / `cooldownUntil` /
`rateLimitCount` / `isPrimary`), while a genuinely distinct pool file that shares
a refresh token (the legitimate duplicate-group case) still inserts a new
group member.

## Current state

Files involved:

- `apps/agent/src/credentials/pool/pool-core.ts` — `CredentialPool.add()` at
  lines 186–303; the root-cause insert is at lines 243–265. All credential
  imports (watcher + HTTP POST + active-credential rotation) route through this
  one method.
- `apps/agent/src/credentials/credential-watcher.ts` — `processCredentialFile()`
  (lines 42–105) calls `pool.add()`; `runInitialScan()` (lines 139–189) drives
  it on every start; `handleFileEvent()` (lines 210–244) drives it on live
  events. The dead dedup `catch` is at lines 95–104.
- `packages/db/src/schema/credentials.ts` — the `credentials` table; the
  fingerprint index is **non-unique** so the DB never rejects a repeat insert.
- `apps/agent/src/credentials/credentials.helpers.ts` — `computeCredentialFingerprint()`
  (lines 65–94) = lowercase-hex `SHA-256(claudeAiOauth.refreshToken)`;
  `extractCredentialMetadata()` (lines 104–147); `TEST_KEY` export (line 157).
- `apps/agent/src/credentials/store.ts` — thin query helpers; `CredentialRow` type.

### The unconditional insert (root cause) — `pool-core.ts:243-265`

```ts
await tx.insert(credentials).values({
  id: credential.id,
  name: credential.name,
  type: credential.type,
  valueEncrypted,
  encryptionKeyId: "v1",
  agentId: null,
  status: "available",
  leasedBy: null,
  leasedAt: null,
  cooldownUntil: null,
  rateLimitCount: 0,
  fingerprint,
  duplicateGroupId: fingerprint,
  isPrimary: newRowIsPrimary,
  subscriptionType: metadata.subscriptionType,
  rateLimitTier: metadata.rateLimitTier,
  expiresAt: metadata.expiresAt,
  mcpProviders: metadata.mcpProviders,
  createdAt: now,
  updatedAt: now,
});
```

### The EXISTING duplicate-group machinery (KEEP — do not break) — `pool-core.ts:212-285`

`add()` already, inside its transaction:

1. Looks up the current primary in the same group:
   `WHERE duplicate_group_id = fingerprint AND is_primary = true` (limit 1).
2. `isFirstInGroup = existingPrimary === null` → first row in a group is
   unconditionally primary.
3. If a primary already exists, "newest mtime (`updatedAt`) wins; tiebreak by
   name ascending" decides whether the NEW row outranks it (`newRowIsPrimary`).
4. Inserts the new row with `isPrimary = newRowIsPrimary`.
5. If the new row took over, demotes the old primary
   (`set is_primary=false`) in the same transaction, logging
   `event: "credential.primary_swap"`.

This machinery is **legitimate** for the case of two *distinct* pool files
(e.g. `acct-001.json` **and** `acct-002.json`) that hold the **same** refresh
token — two separate entries sharing a fingerprint, by design. The bug is
**only** the re-insert of the **same** file on re-import. This plan must
preserve the distinct-file duplicate-group path untouched.

### The dead dedup fallback — `credential-watcher.ts:87-104`

```ts
try {
  await pool.add({
    id: randomUUID(),
    name: basename(filename, ".json"),
    type: "oauth",
    value_plaintext: plaintext,
  });
  return "added";
} catch (err) {
  if (
    err instanceof Error &&
    (err.message.includes("duplicate") || err.message.includes("unique"))
  ) {
    await pool.refreshMetadata();
    return "refreshed";
  }
  throw err;
}
```

`add()` never throws a uniqueness error (non-unique index + unconditional
insert), so the `catch` branch is unreachable dead code.

### The discriminator: fingerprint + name

- `fingerprint` identifies the **account** (same refresh token → same
  fingerprint). Two different accounts can never collide (different refresh
  tokens → different SHA-256).
- `name` identifies the **file**: in the watcher, `name = basename(filename,
  ".json")` (e.g. `"acct-001"`), unique per file in a directory.

Therefore:

| Existing row match | Meaning | Action |
| --- | --- | --- |
| `fingerprint` **and** `name` both match | the SAME file re-imported (token refresh / restart) | **UPDATE in place** — preserve lifecycle state |
| `fingerprint` matches, `name` differs | a distinct pool file for the same account (by-design duplicate group) | INSERT (existing machinery, unchanged) |
| no `fingerprint` match | brand-new account | INSERT (existing machinery, unchanged) |

This cannot merge two real accounts: two real accounts have different refresh
tokens → different fingerprints → the `(fingerprint, name)` lookup returns
nothing → the insert path runs exactly as today.

### Repo conventions to honor

- **Runtime**: Bun (`bun:test`, `bun test`). Never `tsc` for execution;
  `tsc --noEmit` is the typecheck gate only.
- **Drizzle**: import `credentials`, `eq`, `and` from the same modules already
  used at the top of `pool-core.ts`. Column names in Drizzle are the camelCase
  schema keys (`credentials.fingerprint`, `credentials.name`, etc.).
- **Structured logging**: `logger.info({ ..., event: "credential.xxx" }, "...")`
  — match the existing event-string style (`credential.primary_swap`,
  `credential.added`).
- **Migration policy**: this plan needs **no** schema change and **no** migration
  (do NOT add a unique index — that would break the legitimate duplicate-group
  case). NEVER run `db:push`.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Install | `pnpm install` | exit 0 |
| Typecheck (agent) | `cd apps/agent && bun run typecheck` | exit 0, no errors |
| Unit test (watcher, no PG) | `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test src/credentials/credential-watcher.test.ts` | all pass |
| Integration test (real PG) | `cd apps/agent && NEXUS_ATTACH_SECRET=test NEXUS_PG_TESTS=1 POSTGRES_URL=<throwaway-db-url> bun test src/credentials/pool/pool-core-dedup.test.ts` | all pass, new tests included |
| Full credential unit sweep | `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test src/credentials/` | all pass |

Notes on env:

- `NEXUS_ATTACH_SECRET=test` is required for the agent's `bun test` bootstrap.
- Live-PG integration tests are gated on `NEXUS_PG_TESTS=1 && POSTGRES_URL`
  (`apps/agent/src/testing/live-pg.ts`, exported as `hasPg`). When the gate is
  off the suite `test.skip`s cleanly. **Point `POSTGRES_URL` at a throwaway /
  local DB — never the shared homelab DB.** The integration harness
  (`createIsolatedSchema`) creates and `DROP SCHEMA ... CASCADE`s a uniquely
  named schema, so it never touches `public`, but a throwaway DB is still the
  safe default.

## Suggested executor toolkit

- Load the `bun` skill for `bun:test` idioms if unsure.
- Model the integration harness on `apps/agent/src/testing/isolated-pg-schema.ts`
  (`createIsolatedSchema(ddl, label)` → `{ db, adminSql, schema, drop() }`) and
  the usage pattern in `apps/agent/src/db/migration-0010-orphans.test.ts`
  (PG-gated `describe`, `beforeAll` create schema, `afterAll` drop).
- `TEST_KEY` for the pool's encryption key is exported from
  `apps/agent/src/credentials/credentials.helpers.ts`.

## Scope

**In scope** (the only files you should modify / create):

- `apps/agent/src/credentials/pool/pool-core.ts` — add the
  `(fingerprint, name)` lookup + update-in-place branch to `add()`; change its
  return type to a discriminant.
- `apps/agent/src/credentials/credential-watcher.ts` — consume the new return
  value in `processCredentialFile()`; remove the dead dedup `catch`.
- `apps/agent/src/credentials/pool/pool-core-dedup.test.ts` — **create**; the
  new PG-gated integration test.
- `apps/agent/src/credentials/credential-watcher.test.ts` — update the one test
  that asserted the now-removed throw-based dedup.

**Out of scope** (do NOT touch, even though they look related):

- `packages/db/src/schema/credentials.ts` — NO schema change, NO unique index.
  A unique fingerprint index would break the legitimate distinct-file
  duplicate-group case and collide with `db:migrate` replay.
- `apps/agent/src/credentials/active-credential-watcher.ts` — it already guards
  re-import with its own `poolRows.some((r) => r.fingerprint === fingerprint)`
  check before calling `add()` (rotation path); it ignores `add()`'s return
  value, so the return-type change is source-compatible. Leave it.
- `apps/agent/src/routes/credentials/handlers-crud.ts` — the HTTP POST path
  calls `add()` and ignores its return value; it stays source-compatible. Leave
  it. (It automatically inherits the dedup fix — that is the intended
  root-cause behavior.)
- `CredentialPool.refreshMetadata()`, `promote()`, `deleteById()`, `lease()` —
  unrelated; do not modify.
- The primary-promotion / demotion machinery for the INSERT path — keep exactly
  as-is.

## Git workflow

- Branch: `advisor/008-fix-credential-dup-insert` (create from current `main`).
- Conventional commits, e.g. `fix(agent): dedupe credential re-import instead of inserting duplicate rows`.
  (Match the repo style — see `git log --oneline`, e.g.
  `feat(notifications): add telegram channel ...`.)
- Do NOT push or open a PR. No merge-back.

## Steps

### Step 1: Add update-in-place to `add()` and change its return type

In `apps/agent/src/credentials/pool/pool-core.ts`, modify `add()` (lines
186–303):

1. Change the signature return type from `Promise<void>` to
   `Promise<"inserted" | "updated">`.

2. Inside the `this.db.transaction(async (tx) => { ... })` block, **before** the
   existing "look for existing primary in group" query (line 214), add a lookup
   for a re-import of the SAME file:

   ```ts
   // Re-import guard: a row with the SAME fingerprint AND SAME name is the
   // same pool file re-imported (token refresh rewrites acct-*.json in place;
   // the refresh token — hence the fingerprint — is stable across access-token
   // refreshes). Update it in place so its lease / cooldown / rate-limit state
   // survives, instead of appending a duplicate row. A fingerprint match with a
   // DIFFERENT name is a distinct pool file for the same account (by-design
   // duplicate group) and MUST fall through to the insert path below.
   const sameFileRows = await tx
     .select()
     .from(credentials)
     .where(
       and(
         eq(credentials.fingerprint, fingerprint),
         eq(credentials.name, credential.name),
       ),
     )
     .limit(2); // fetch 2 so we can detect the ambiguous >1 case

   if (sameFileRows.length > 1) {
     // Data drift: more than one row already shares this (fingerprint, name).
     // Refuse to guess which to update — surface it (STOP condition).
     throw new Error(
       `credential re-import ambiguous: ${sameFileRows.length} rows share fingerprint+name for "${credential.name}"`,
     );
   }

   const existingSameFile = sameFileRows[0] ?? null;
   if (existingSameFile !== null) {
     await tx
       .update(credentials)
       .set({
         // Refresh the token material + volatile metadata only. Preserve
         // status / leasedBy / leasedAt / cooldownUntil / rateLimitCount /
         // isPrimary / duplicateGroupId / id / createdAt untouched.
         valueEncrypted,
         encryptionKeyId: "v1",
         subscriptionType: metadata.subscriptionType,
         rateLimitTier: metadata.rateLimitTier,
         expiresAt: metadata.expiresAt,
         mcpProviders: metadata.mcpProviders,
         updatedAt: now,
       })
       .where(eq(credentials.id, existingSameFile.id));

     logger.info(
       {
         id: existingSameFile.id,
         name: credential.name,
         fingerprint,
         event: "credential.reimport_updated",
       },
       "credential re-import updated existing row in place",
     );
     return "updated" as const;
   }
   ```

   Return early with `"updated"` from **inside** the transaction callback — the
   transaction resolves to that value; then have `add()` return it (see step 3).

3. Leave the entire existing duplicate-group block (existing-primary lookup,
   `newRowIsPrimary` computation, `tx.insert(...)`, demotion) **exactly as it
   is** for the insert path.

4. After the transaction resolves on the INSERT path, the existing tail
   (`emitEvent("added", ...)`, `logger.info("credential added to pool")`,
   best-effort `probeIdentity`) should still run for inserts. For the UPDATE
   path you returned early, so those side effects are skipped — that is
   correct (no "added" event for an in-place refresh). Structure `add()` so the
   transaction returns the discriminant and `add()` returns it:

   ```ts
   const outcome = await this.db.transaction(async (tx) => {
     // ... update-in-place guard returns "updated" ...
     // ... existing insert + demotion ...
     return "inserted" as const;
   });

   if (outcome === "updated") {
     return "updated";
   }

   // insert-path side effects (unchanged): emitEvent("added"), logger.info,
   // best-effort probeIdentity
   void this.emitEvent(credential.id, "added", null, { name: credential.name, fingerprint });
   logger.info({ id: credential.id, name: credential.name, fingerprint }, "credential added to pool");
   this.probeIdentity(credential.id, credential.value_plaintext).catch(/* ...unchanged... */);
   return "inserted";
   ```

**Verify**: `cd apps/agent && bun run typecheck` → exit 0, no errors.

### Step 2: Consume the return value in the watcher; delete the dead catch

In `apps/agent/src/credentials/credential-watcher.ts`, replace the
insert-with-dead-catch block in `processCredentialFile()` (lines 83–104) with a
direct call that maps the discriminant:

```ts
// add() now dedupes internally: a re-import of the same file (same
// fingerprint + same name) updates the existing row in place and returns
// "updated"; a genuinely new row returns "inserted".
const outcome = await pool.add({
  id: randomUUID(),
  name: basename(filename, ".json"),
  type: "oauth",
  value_plaintext: plaintext,
});
return outcome === "updated" ? "refreshed" : "added";
```

Remove the `try/catch` that fell through to `pool.refreshMetadata()` on a
"duplicate"/"unique" error message — it is now dead. Do NOT change the
`ProcessResult` type (`"added" | "refreshed" | "skipped"`) or the
`InitialScanResult` accounting; "updated" simply maps onto the existing
"refreshed" bucket, preserving the `added + refreshed + skipped == scanned`
invariant the tests assert.

Note: `WatcherPool = Pick<CredentialPool, "add" | "refreshMetadata">`
automatically picks up `add()`'s new return type. `refreshMetadata` is no longer
called from `processCredentialFile`; leave it in the `Pick` (harmless — other
code and the fake pool still reference it) unless typecheck flags an unused
import (it will not).

**Verify**: `cd apps/agent && bun run typecheck` → exit 0, no errors.

### Step 3: Update the watcher unit test that asserted the removed throw

In `apps/agent/src/credentials/credential-watcher.test.ts`:

- The fake pool's `add()` currently returns `Promise<void>` and can `throwOnAdd`.
  Change `add()` to return the discriminant. Because the fake pool does no real
  DB dedup, drive the "updated" path explicitly: replace the `throwOnAdd` field
  with a way for a test to make `add()` return `"updated"` (e.g. an
  `addReturns?: "inserted" | "updated"` field defaulting to `"inserted"`).
- Rewrite the test `"duplicate-fingerprint add falls through to refreshMetadata"`
  (lines 146–158) as `"add returning 'updated' is counted as refreshed"`:
  make the fake pool's `add()` return `"updated"`, assert `result.added === 0`,
  `result.refreshed === 1`, and that `pool.calls` contains a single `add`
  (NOT a `refreshMetadata` call — the fall-through no longer exists).
- Update the other tests' fake `add()` to return `"inserted"` so their
  `result.added` expectations still hold.

**Verify**:
`cd apps/agent && NEXUS_ATTACH_SECRET=test bun test src/credentials/credential-watcher.test.ts`
→ all pass.

### Step 4: Add the PG-gated integration test proving the dedup + state preservation

Create `apps/agent/src/credentials/pool/pool-core-dedup.test.ts`, PG-gated on
`hasPg` (import `{ hasLivePg as hasPg } from "../../testing/live-pg"`). Use
`createIsolatedSchema` (from `../../testing/isolated-pg-schema`) to build a
throwaway schema containing the `credentials` table, construct
`new CredentialPool(iso.db, { encryptionKey: TEST_KEY })`, and drop the schema
in `afterAll`.

`ccProfileEvents` (used by `emitEvent`) is **not** required — `emitEvent`
swallows its own errors (`pool-core.ts:98-103`), so a missing events table only
produces a warning. `probeIdentity` makes a best-effort outbound request to
`api.anthropic.com` with the fixture's (fake) access token; it is `.catch()`ed
and never fails the test — no network assertion needed.

Minimal `credentials` DDL sufficient for the pool (mirrors
`packages/db/src/schema/credentials.ts`; `agent_id` FK dropped for test
isolation — the pool always writes `agentId: null`):

```sql
CREATE TABLE credentials (
  id text PRIMARY KEY,
  name text NOT NULL,
  type text NOT NULL,
  value_encrypted text,
  encryption_key_id text DEFAULT 'v1',
  agent_id text,
  status text NOT NULL DEFAULT 'available',
  leased_by text,
  leased_at timestamp,
  cooldown_until timestamp,
  rate_limit_count integer NOT NULL DEFAULT 0,
  fingerprint text NOT NULL DEFAULT '',
  duplicate_group_id text,
  is_primary boolean NOT NULL DEFAULT false,
  subscription_type text,
  rate_limit_tier text,
  expires_at timestamptz,
  account_email text,
  account_name text,
  account_uuid text,
  org_name text,
  org_uuid text,
  mcp_providers text,
  usage_5h_used integer,
  usage_5h_limit integer,
  usage_5h_reset_at timestamptz,
  usage_7d_used integer,
  usage_7d_limit integer,
  usage_7d_reset_at timestamptz,
  usage_polled_at timestamptz,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX credentials_fingerprint_idx ON credentials (fingerprint);
CREATE INDEX credentials_group_primary_idx ON credentials (duplicate_group_id, is_primary);
```

Fixtures — real Claude Code OAuth shape (fingerprint = `SHA-256` of
`claudeAiOauth.refreshToken`; DO NOT use real tokens):

```ts
const acct001 = JSON.stringify({
  claudeAiOauth: {
    refreshToken: "rt-plan008-0001",
    accessToken: "at-plan008-0001-v1",
    expiresAt: 1893456000000,
  },
});
const acct001Refreshed = JSON.stringify({
  claudeAiOauth: {
    refreshToken: "rt-plan008-0001",          // SAME refresh token -> same fingerprint
    accessToken: "at-plan008-0001-v2",        // rotated access token
    expiresAt: 1893456000000,
  },
});
const acct002SameToken = JSON.stringify({
  claudeAiOauth: {
    refreshToken: "rt-plan008-0001",          // same token, but imported under a DIFFERENT name
    accessToken: "at-plan008-0001-v1",
    expiresAt: 1893456000000,
  },
});
```

Assert these cases (query the table directly via `iso.db` after each `add`):

1. **Re-import yields ONE row, not two** — matches finding test (a):
   ```ts
   await pool.add({ id: randomUUID(), name: "acct-001", type: "oauth", value_plaintext: acct001 });
   await pool.add({ id: randomUUID(), name: "acct-001", type: "oauth", value_plaintext: acct001 });
   // exactly ONE row with name "acct-001"
   ```
   Expect the second `add()` returns `"updated"` and the table has exactly one
   `acct-001` row.

2. **Refresh updates in place and preserves lease/cooldown state** — matches
   finding test (b):
   - `add` `acct-001` (returns `"inserted"`).
   - Directly `UPDATE` that row to `status='cooldown'`, `cooldownUntil=<future>`,
     `rateLimitCount=3`, `leasedBy='sess-x'` to simulate an
     in-flight rate-limited credential.
   - `add` `acct-001` again with `acct001Refreshed` (rotated access token).
   - Assert: still ONE `acct-001` row; its `status` is still `'cooldown'`,
     `cooldownUntil` unchanged, `rateLimitCount` still `3`, `isPrimary`
     unchanged; and `valueEncrypted` **changed** (the new access token was
     written) — i.e. NOT reset to an `available` clone.

3. **Distinct file, same token still inserts a group member (machinery
   preserved)**:
   - `add` `acct-001` then `add` `acct-002` with `acct002SameToken` (same
     fingerprint, DIFFERENT name).
   - Assert: TWO rows share the fingerprint, exactly ONE has `is_primary=true`,
     both share `duplicate_group_id`. (The second `add()` returns `"inserted"`.)

**Verify**:
`cd apps/agent && NEXUS_ATTACH_SECRET=test NEXUS_PG_TESTS=1 POSTGRES_URL=<throwaway-db-url> bun test src/credentials/pool/pool-core-dedup.test.ts`
→ all pass (3 assertions above).

### Step 5: Full credential sweep + typecheck

**Verify**:
- `cd apps/agent && bun run typecheck` → exit 0.
- `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test src/credentials/` → all pass.
- With PG env set, the dedup integration file runs; without it, it `skip`s
  cleanly (no failures).

## Test plan

- **New file** `apps/agent/src/credentials/pool/pool-core-dedup.test.ts`
  (PG-gated), covering:
  - re-import of the same `(fingerprint, name)` yields ONE row (the core bug);
  - a refresh that rewrites the file updates the existing row and preserves
    `cooldown` / `rateLimitCount` / `isPrimary` rather than creating an
    `available` clone;
  - a distinct file sharing a refresh token still inserts a duplicate-group
    member with exactly one primary (machinery preserved).
- **Updated** `apps/agent/src/credentials/credential-watcher.test.ts`: the
  former "duplicate throw → refreshMetadata" test becomes "add returns 'updated'
  → counted as refreshed"; other tests' fake `add()` returns `"inserted"`.
- Structural pattern to model the integration test on:
  `apps/agent/src/db/migration-0010-orphans.test.ts` (PG-gated `describe`,
  isolated-schema create/drop) + `apps/agent/src/testing/isolated-pg-schema.ts`.
- Verification: the commands in Step 4 and Step 5 pass, including the 3 new
  integration assertions.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `cd apps/agent && bun run typecheck` exits 0.
- [ ] `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test src/credentials/credential-watcher.test.ts` passes (updated test included).
- [ ] With `NEXUS_PG_TESTS=1 POSTGRES_URL=<throwaway>`, `bun test src/credentials/pool/pool-core-dedup.test.ts` passes with the 3 new assertions.
- [ ] `add()`'s return type is `Promise<"inserted" | "updated">` and the update-in-place branch exists (`grep -n 'reimport_updated' apps/agent/src/credentials/pool/pool-core.ts` returns a match).
- [ ] The dead dedup `catch` is gone: `grep -n 'refreshMetadata' apps/agent/src/credentials/credential-watcher.ts` returns no match inside `processCredentialFile` (the `err.message.includes("duplicate")` block is removed).
- [ ] No schema/migration change: `git status` shows `packages/db/` untouched.
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row updated (if that file exists).

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" doesn't match the excerpts (the
  codebase drifted since commit `64a206ff`).
- The `(fingerprint, name)` lookup in `add()` ever returns **more than one** row
  at runtime (the guard in Step 1 throws) — this means two rows already share a
  fingerprint AND name, which the `name`-as-file-identity assumption forbids.
  Do NOT pick one to update; report the ambiguity.
- You discover `name` is NOT a reliable per-file identity in some caller (e.g.
  the HTTP POST path or a future caller passes duplicate names for genuinely
  different accounts) — do not fall back to fingerprint-only dedup, which would
  risk merging two real accounts. Report and ask.
- You find the assumption "the refresh token is stable across access-token
  refreshes" is false (a refresh rotates the refresh token, changing the
  fingerprint) — then re-import would NOT match by fingerprint and the fix
  wouldn't fire; report so the discriminator can be reconsidered.
- A step's verification fails twice after a reasonable fix attempt.
- The fix appears to require touching an out-of-scope file (especially
  `packages/db/src/schema/credentials.ts` — adding a unique index is explicitly
  forbidden here).

## Maintenance notes

For the human/agent who owns this code after the change lands:

- **The discriminator is `(fingerprint, name)`.** `fingerprint` = account,
  `name` = file. If a future change makes `name` non-unique per credential file,
  or introduces a caller that supplies arbitrary names for distinct accounts,
  the re-import guard must be revisited — fingerprint-only dedup would merge
  accounts.
- **No unique index was added on purpose.** The non-unique fingerprint index is
  load-bearing for the legitimate duplicate-group case (two pool files, one
  refresh token). Do not "tighten" it.
- **Refresh-token rotation is an open edge.** This fix relies on the refresh
  token being stable across access-token refreshes (documented in
  `computeCredentialFingerprint`). If Anthropic starts rotating refresh tokens
  on refresh, a rewritten file would carry a NEW fingerprint, the guard would
  miss, and a new row would be inserted (orphaning the old). That is a separate
  follow-up (fingerprint-churn reconciliation), deliberately out of scope here.
- **What a reviewer should scrutinize**: that the UPDATE branch preserves
  `status` / `leasedBy` / `leasedAt` / `cooldownUntil` / `rateLimitCount` /
  `isPrimary` / `duplicateGroupId` / `id` / `createdAt` (only token material +
  metadata + `updatedAt` change), and that the INSERT-path
  promotion/demotion machinery is byte-for-byte unchanged.
