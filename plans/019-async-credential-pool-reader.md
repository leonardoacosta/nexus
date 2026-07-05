# Plan 019: Convert credential-pool reader.ts sync fs calls to fs/promises

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat c67ff12c..HEAD -- apps/agent/src/services/credential-pool/reader.ts`
> This file was previously touched by shipped advisor plans 008/009 — start
> from current `main` after those merged. If the diff is non-empty, compare
> the "Current state" excerpts below against the live code before proceeding;
> on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `c67ff12c`, 2026-07-05

## Why this matters

`readCredentials()` in `apps/agent/src/services/credential-pool/reader.ts` is
declared `async` but does ALL its filesystem work with synchronous `node:fs`
calls (`readdirSync`, `readFileSync`, `statSync`, `realpathSync`, `existsSync`).
The agent is a single-threaded Bun daemon: every sync fs call blocks the one
event loop, stalling every other in-flight request (WebSocket frames, hook
ingest, other HTTP routes). This function is on a hot request path — the
`/credentials` route falls back to it whenever the DB-backed pool is
null/empty/throws (`apps/agent/src/routes/credentials/handlers-crud.ts:200
`await readCredentials()``), which is the steady state on any host without an
imported pool, i.e. on every dashboard poll there. The fix is a mechanical swap
to `fs/promises`: the function and its private helper cascade become truly
async with zero caller changes (signatures are already `async`/awaited).

This is verified finding grade B, CONFIRMED (advisor read + adversarial
verifier, evidence bundle plan-019).

## Current state

All work is in ONE file: `apps/agent/src/services/credential-pool/reader.ts`
(608 lines at c67ff12c).

**Sync import block** (`reader.ts:93-99`):

```ts
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
```

**Sync call sites** (line numbers at c67ff12c):

| Lines | Function | Calls |
| --- | --- | --- |
| 348, 350, 351 | `detectActiveFingerprint` (symlink branch) | `existsSync`, `realpathSync`, `readFileSync` |
| 360, 362, 365, 366 | `detectActiveFingerprint` (marker branch) | `existsSync`, `readFileSync`, `existsSync`, `readFileSync` |
| 375, 379, 383 | `detectActiveFingerprint` (CC-file branch) | `existsSync`, `realpathSync`, `readFileSync` |
| 418, 425 | `readCredentials` (entry) | `existsSync(dir)`, `readdirSync(dir)` |
| 441, 442 | `readCredentials` (per-file loop) | `readFileSync(filePath)`, `statSync(filePath).mtime` |
| 547, 551, 561, 562 | `readActiveCcCredentialEntry` | `existsSync`, `realpathSync`, `readFileSync`, `statSync` |

**Internal call sites that must gain `await`** (both callees are
module-private, called ONLY from `readCredentials` — no external callers):

```ts
// reader.ts:493
const activeFingerprint = detectActiveFingerprint(dir);
// reader.ts:514
const synthetic = readActiveCcCredentialEntry();
```

**Exported symbols** (unchanged by this plan): `CredentialStatus`,
`CredentialEntry`, `CredentialReadResult`, `defaultCredentialsDir`,
`readCredentials`. `readCredentials` is already
`export async function readCredentials(...): Promise<CredentialReadResult>`
(`reader.ts:415-417`). Its only two consumers already `await` it:
`apps/agent/src/routes/credentials/handlers-crud.ts:200` and every call in
`apps/agent/src/routes/credentials.test.ts` (e.g. `:478`
`const result = await readCredentials(dir);`). **Zero caller changes.**

**Behavior invariants to preserve** (documented at `reader.ts:404-413`):
never throws; missing dir / unreadable dir → `{credentials: [],
activeFingerprint: null}`; malformed files skipped with warn log; keep every
existing log message string as-is; keep the per-file loop sequential (row
order follows readdir order).

**Repo facts**: Bun monorepo — never `tsc` for execution. Tests need
`NEXUS_ATTACH_SECRET=test` in env. This plan touches no DB schema — the
migration policy (`db:generate`, never `db:push`) is irrelevant here.

## Commands you will need

Run from `/home/nyaptor/dev/nx` unless noted. Baseline verified green at
c67ff12c on 2026-07-05.

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Reader test suite | `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test src/routes/credentials.test.ts` | `28 pass / 0 fail` (28 is the c67ff12c baseline; more is fine, fewer/fail is not) |
| Agent typecheck | `cd apps/agent && pnpm typecheck` | exit 0 |
| Full typecheck | `pnpm typecheck` | exit 0 (baseline greened 2026-07-03; if it fails, confirm no error names reader.ts before treating as pre-existing) |
| Lint | `pnpm lint` | exit 0, no NEW errors attributable to reader.ts |
| Sync-call gate | `grep -nE '\b(existsSync\|readdirSync\|readFileSync\|realpathSync\|statSync)\s*\(' apps/agent/src/services/credential-pool/reader.ts` | no output, exit 1 |

## Scope

**In scope** (the only file you may modify):
- `apps/agent/src/services/credential-pool/reader.ts`

**Out of scope** (do NOT touch, even though they look related):
- `apps/agent/src/routes/credentials/handlers-crud.ts` — already awaits; its
  DB-vs-filesystem fallback logic belongs to other plans.
- `apps/agent/src/routes/credentials.test.ts` — no test changes needed; the
  suite already awaits `readCredentials` with tmpdir fixtures.
- `apps/agent/src/credentials/active-credential-watcher.ts` — separate
  component; its sync reads are not this finding.
- `apps/agent/src/routes/specs.ts`, `apps/agent/src/routes/specs/handlers-status.ts`
  — their sync I/O was audited and REFUTED (subprocess-dominated,
  low-frequency); converting them is wasted effort.
- `apps/agent/src/health-push/apns-sender.ts`, `apps/nexus-emit/**` — one-shot
  init / single-shot CLI; refuted, do not convert.
- `apps/agent/src/services/credential-pool/rate-limit-tracker.ts`,
  `swap-tracker.ts` — in-memory trackers, no fs work relevant here.

## Git workflow

- Work on the current branch (no branch creation).
- Single commit at the end, targeted add only:
  `git add apps/agent/src/services/credential-pool/reader.ts .beads/ && git commit && git push`
  (omit `.beads/` if it has no changes). Never `git add .` / `-A`.
- Message style (match `git log`): `perf(agent): async fs in credential-pool reader (cc advisor-plans/019)`

## Steps

### Step 1: Swap the import block to fs/promises and add an `exists` helper

In `reader.ts`, replace the `node:fs` import (lines 93-99) with:

```ts
import { access, readdir, readFile, realpath, stat } from "node:fs/promises";
```

`fs/promises` has no `existsSync` equivalent, so add one small private helper
directly below the `ccActiveCredentialPath()` function (after line 215, in the
`// Helpers` section):

```ts
/** async replacement for existsSync — access() resolves iff the path exists. */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
```

Do not change anything else in this step. The file will not typecheck until
Steps 2-4 are done — that is expected; verify at the end of Step 4.

**Verify**: `grep -n 'from "node:fs"' apps/agent/src/services/credential-pool/reader.ts`
→ no output (the only fs import is now `node:fs/promises`).

### Step 2: Convert `detectActiveFingerprint` to async

Change the signature (line 345):

```ts
// before
function detectActiveFingerprint(dir: string): string | null {
// after
async function detectActiveFingerprint(dir: string): Promise<string | null> {
```

Inside the function body, mechanical swaps — keep every `try/catch`, log
message, and the 1→2→3→null cascade order exactly as-is:

- `if (existsSync(symlinkPath))` → `if (await exists(symlinkPath))` (line 348)
- `const resolved = realpathSync(symlinkPath);` → `const resolved = await realpath(symlinkPath);` (line 350)
- `const plaintext = readFileSync(resolved, "utf-8");` → `const plaintext = await readFile(resolved, "utf-8");` (line 351)
- `if (existsSync(markerPath))` → `if (await exists(markerPath))` (line 360)
- `const raw = readFileSync(markerPath, "utf-8").trim();` → `const raw = (await readFile(markerPath, "utf-8")).trim();` (line 362 — note the parentheses around the await before `.trim()`)
- `if (typeof parsed?.path === "string" && existsSync(parsed.path))` → `if (typeof parsed?.path === "string" && (await exists(parsed.path)))` (line 365)
- `return computeCredentialFingerprint(readFileSync(parsed.path, "utf-8"));` → `return computeCredentialFingerprint(await readFile(parsed.path, "utf-8"));` (line 366)
- `if (existsSync(ccPath))` → `if (await exists(ccPath))` (line 375)
- `resolved = realpathSync(ccPath);` → `resolved = await realpath(ccPath);` (line 379)
- `const plaintext = readFileSync(resolved, "utf-8");` → `const plaintext = await readFile(resolved, "utf-8");` (line 383)

Then update its single call site (line 493 in `readCredentials`):

```ts
const activeFingerprint = await detectActiveFingerprint(dir);
```

**Verify**: `grep -nE '\b(existsSync|readdirSync|readFileSync|realpathSync|statSync)\s*\(' apps/agent/src/services/credential-pool/reader.ts`
→ only lines inside `readCredentials` (418/425/441/442 region) and
`readActiveCcCredentialEntry` (547+) remain; none between lines 345-395.

### Step 3: Convert the `readCredentials` body

Inside `readCredentials` (lines 415-533), same mechanical swaps:

- `if (!existsSync(dir))` → `if (!(await exists(dir)))` (line 418)
- `entries = readdirSync(dir);` → `entries = await readdir(dir);` (line 425 — the surrounding try/catch already returns the empty envelope on failure; keep it)
- In the per-file loop (lines 440-446), keep it a sequential `for...of` (row order must follow readdir order; do NOT introduce `Promise.all`):

```ts
try {
  plaintext = await readFile(filePath, "utf-8");
  mtime = (await stat(filePath)).mtime;
} catch (err) {
  log.warn({ file: filename, error: err }, "credential file read failed");
  continue;
}
```

- `const synthetic = readActiveCcCredentialEntry();` → `const synthetic = await readActiveCcCredentialEntry();` (line 514 — the callee becomes async in Step 4).

**Verify**: `grep -nE '\b(existsSync|readdirSync|readFileSync|realpathSync|statSync)\s*\(' apps/agent/src/services/credential-pool/reader.ts`
→ remaining matches are ONLY inside `readActiveCcCredentialEntry` (lines 545+).

### Step 4: Convert `readActiveCcCredentialEntry` to async

Change the signature (line 545):

```ts
// before
function readActiveCcCredentialEntry(): CredentialEntry | null {
// after
async function readActiveCcCredentialEntry(): Promise<CredentialEntry | null> {
```

Body swaps:

- `if (!existsSync(ccPath)) return null;` → `if (!(await exists(ccPath))) return null;` (line 547)
- `resolvedPath = realpathSync(ccPath);` → `resolvedPath = await realpath(ccPath);` (line 551 — keep the catch that falls back to `ccPath`)
- `plaintext = readFileSync(resolvedPath, "utf-8");` → `plaintext = await readFile(resolvedPath, "utf-8");` (line 561)
- `mtime = statSync(resolvedPath).mtime;` → `mtime = (await stat(resolvedPath)).mtime;` (line 562)

**Verify (all three, in order)**:
1. `grep -cE '\b(existsSync|readdirSync|readFileSync|realpathSync|statSync)\s*\(' apps/agent/src/services/credential-pool/reader.ts` → `0` (grep exits 1)
2. `cd apps/agent && pnpm typecheck` → exit 0
3. `grep -c 'from "node:fs/promises"' apps/agent/src/services/credential-pool/reader.ts` → `1`

### Step 5: Run the gates

**Verify (all, in order)**:
1. `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test src/routes/credentials.test.ts` → `28 pass / 0 fail` (tmpdir fixtures unchanged)
2. `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test` → 0 fail (full agent suite; a failure in an unrelated file that ALSO fails on a clean checkout of `main` is pre-existing — confirm with `git stash && bun test <that file> && git stash pop` before deciding)
3. `pnpm typecheck` (repo root) → exit 0
4. `pnpm lint` → no NEW errors naming reader.ts
5. `git status --porcelain` → only `apps/agent/src/services/credential-pool/reader.ts` modified (plus `.beads/` if issue-tracking touched)

### Step 6: Commit and push

```
git add apps/agent/src/services/credential-pool/reader.ts .beads/
git commit -m "perf(agent): async fs in credential-pool reader (cc advisor-plans/019)"
git push
```

(Drop `.beads/` from the add if `git status` shows no changes there.)

**Verify**: `git push` exits 0; `git status` clean for in-scope file.

## Test plan

No new tests — the swap is signature-preserving and the existing suite already
exercises every converted branch through the public `readCredentials` API with
real tmpdir fixtures:

- `apps/agent/src/routes/credentials.test.ts` — describe blocks
  `"readCredentials — filesystem reader (task 1.10)"` (line 475: missing dir,
  empty dir/CC-synthesis fallback, malformed JSON skip, active-marker
  detection) and `"readCredentials — enriched CcProfile shape (task 1.7)"`
  (line 698: metadata projection, expiry, status tagging).

These cover: missing directory (exercises `exists`+`readdir` failure path),
per-file read loop, `detectActiveFingerprint` cascade, and the
`readActiveCcCredentialEntry` synthesis branch. If you were adding a test
anyway, model it on the `makeOAuthBlob` + `mkdtempSync` fixture pattern at
`credentials.test.ts:454-500` — but none is required for this plan.

Verification: `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test src/routes/credentials.test.ts`
→ 28 pass, 0 fail.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -cE '\b(existsSync|readdirSync|readFileSync|realpathSync|statSync)\s*\(' apps/agent/src/services/credential-pool/reader.ts` prints `0`
- [ ] `grep -c 'from "node:fs"' apps/agent/src/services/credential-pool/reader.ts` prints `0` (only `node:fs/promises` remains)
- [ ] `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test src/routes/credentials.test.ts` → 28 pass, 0 fail
- [ ] `pnpm typecheck` exits 0
- [ ] `git diff --name-only c67ff12c..HEAD -- apps/agent/src` (your commit) shows only `apps/agent/src/services/credential-pool/reader.ts` from this plan
- [ ] `plans/README.md` status row for 019 updated (add the row if plans 016-022 are not yet listed)

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check shows reader.ts changed since c67ff12c AND the sync-call
  table in "Current state" no longer matches (e.g. a function was renamed,
  a call site moved by more than comment-shift, or another session already
  converted some calls).
- The reader test suite fails after the conversion and a second look at the
  swap does not fix it — especially the
  `"empty pool dir falls back to synthesize-from-CC"` test, which is
  host-dependent (reads the real `~/.claude/.credentials.json` via
  `os.homedir()`); if it fails on BOTH the converted code and a clean stash
  of `main`, it is environmental — report, do not patch the test.
- Typecheck errors point OUTSIDE reader.ts (would mean an external caller
  depends on a sync-shaped internal — none exists at c67ff12c).
- You find yourself wanting to edit `handlers-crud.ts`, the test file, or any
  file in the out-of-scope list.

## Maintenance notes

- **Reviewer focus**: confirm the per-file loop stayed sequential (no
  `Promise.all` — row ordering and the warn-and-continue semantics depend on
  it) and that every `try/catch` boundary is unchanged (the "never throws"
  invariant at reader.ts:404-413 is the contract the `/credentials` route
  relies on).
- The `exists()` helper is intentionally local to reader.ts. If a second
  module needs it later, THAT change can hoist it (extend-before-create) —
  do not pre-hoist now.
- `computeCredentialFingerprint` (imported from
  `../../credentials/credentials.helpers`) is CPU-only sync hashing — it is
  correct that it stays synchronous.
- Deliberately deferred (other owners): the DB-vs-filesystem fallback logic in
  `handlers-crud.ts`, and all refuted sync-I/O siblings (specs routes,
  apns-sender, nexus-emit) — do not "finish the job" there.
- Optional follow-up measurement (not required): time the `/credentials`
  fallback under a 50-file pool dir before/after; expect identical wall time
  but zero event-loop blocking during the fs waits.
