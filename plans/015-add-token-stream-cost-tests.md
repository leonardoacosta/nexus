# Plan 015: Unit tests pin the token-stream cost + attribution logic (the money path)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` (only if that file exists) — unless a reviewer
> dispatched you and told you they maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 64a206ff..HEAD -- apps/agent/src/credentials/token-stream/ apps/agent/src/credentials/model-pricing.ts`
> If any of `cost-calculator.ts`, `model-pricing.ts`, `attribution.ts`, or
> `transcript-locator.ts` changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `64a206ff`, 2026-07-03

## Why this matters

The per-session dollar and token figures shown on every Nexus dashboard come
from `apps/agent/src/credentials/token-stream/` — code that reconstructs cost
by tailing `~/.claude/projects/**.jsonl` transcripts. Of its six modules only
`tail-watcher.ts` has a test. The pricing math (`cost-calculator.ts` ->
`model-pricing.ts`), the credential attribution (`attribution.ts` — "which
account got charged"), and the transcript-path resolver
(`transcript-locator.ts`) are entirely untested. A silent pricing-table typo
or mis-attribution surfaces only when a user notices a wrong dollar figure.
This path is also slated for a future OTel/InfluxDB migration (the
`read-cc-telemetry-from-influxdb` proposal); these tests pin current, correct
behavior as a characterization baseline before that fork. This plan is
purely additive — new test files only, no source changes.

## Current state

The three units under test, inlined so you do not need to re-read the source.

### 1. `cost-calculator.ts` (48 lines) + `model-pricing.ts` (89 lines) — pure, no DB

`cost-calculator.ts` exports `computeCost(model, usage, sessionId): number | null`.
It is a thin warn-once wrapper around `computeTokenCost` from `../model-pricing`:
it returns whatever `computeTokenCost` returns, and additionally logs a single
WARN per unique `(sessionId, model)` pair when the result is `null`. The signature
takes `usage` with the LONG field names: `inputTokens`, `outputTokens`,
`cacheReadInputTokens`, `cacheCreationInputTokens`.

`model-pricing.ts` holds the pricing table and the pure math. **Rates are $ per
1,000,000 tokens.** The cost formula (`computeTokenCost`, `model-pricing.ts:71-89`)
is: `(input*inputRate + output*outputRate + cacheRead*cacheReadRate +
cacheCreation*cacheCreationRate) / 1_000_000`, and it returns `null` when
`MODEL_PRICING[model]` is undefined.

Table entries you will assert against (from `MODEL_PRICING`, `model-pricing.ts:12-68`):

| model | inputRate | outputRate | cacheReadRate | cacheCreationRate |
|-------|-----------|------------|---------------|-------------------|
| `claude-sonnet-4-6`         | 3   | 15 | 0.3  | 3.75 |
| `claude-opus-4-6`           | 15  | 75 | 1.5  | 18.75 |
| `claude-haiku-4-5-20251001` | 0.8 | 4  | 0.08 | 1 |

Worked expectations (compute with the formula above):
- `claude-sonnet-4-6`, `{input:1_000_000, output:0, cacheRead:0, cacheCreation:0}` -> `3`
- `claude-sonnet-4-6`, `{input:1000, output:1000, cacheRead:0, cacheCreation:0}` -> `0.018`
- `claude-opus-4-6`, `{input:0, output:1_000_000, cacheRead:0, cacheCreation:0}` -> `75`
- `claude-sonnet-4-6`, all-zero usage -> `0` (known model, NOT null)
- unknown model `"gpt-4o"` -> `null`

### 2. `transcript-locator.ts` (103 lines) — filesystem, no DB

Exports `locateTranscript(cwd, ccSessionId): Promise<string | null>`. Path
convention and fast path (`transcript-locator.ts:30-43`): it computes
`encodedCwd = cwd.replaceAll("/", "-")` (so `/home/u/dev/nx` becomes
`-home-u-dev-nx` — the leading `/` becomes a leading `-`, kept by convention),
then `parentDir = path.join(homedir(), ".claude", "projects", encodedCwd)` and
`filePath = path.join(parentDir, ccSessionId + ".jsonl")`. If `existsSync(filePath)`
it returns `filePath` immediately (fast path). Otherwise it `mkdir`s the parent,
`fs.watch`es it for `WATCH_TIMEOUT_MS = 5000` ms, and resolves `null` on timeout.

Load-bearing facts:
- The encoding `cwd.replaceAll("/", "-")` is the actual bug surface — a wrong
  encoding yields a wrong path and silently disables cost tracking.
- `homedir()` (`node:os`) resolves `$HOME` on POSIX, so a test redirects it by
  setting `process.env.HOME` to a temp dir before the call.
- Missing file -> waits 5 s then resolves `null`; a missing-file test therefore
  takes ~5 s and needs an extended per-test timeout.

### 3. `attribution.ts` (80 lines) — needs a DB; use a fake

Exports `attributeTurnToCredential(db, sessionId, _turnTs): Promise<AttributionResult>`
where `AttributionResult = { credentialId: string | null; credentialFingerprint: string | null }`.
`_turnTs` is currently unused (the `credential_swaps` table does not exist yet).
Branch behavior to characterize (`attribution.ts:37-80`):

- It runs `db.select({credentialId, credentialFingerprint}).from(sessions).where(eq(sessions.id, sessionId)).limit(1)` -> `sessionRows`.
- **(A)** If `sessionRows[0]` is undefined (session not found) -> returns `{credentialId: null, credentialFingerprint: null}`.
- **(B)** If the session has a truthy `credentialId` but a falsy `credentialFingerprint`, it runs a second query `db.select({fingerprint}).from(credentials).where(eq(credentials.id, session.credentialId)).limit(1)` and returns `{credentialId: session.credentialId, credentialFingerprint: credRows[0]?.fingerprint ?? null}`.
- **(C)** Otherwise returns `{credentialId: session.credentialId, credentialFingerprint: session.credentialFingerprint}` as-is. A session with a null `credentialId` skips branch B (falsy id) and falls through here, yielding `{null, null}`.

The DB calls use drizzle's `db.select(...).from(table).where(...).limit(1)` chain,
which resolves to an array of rows. `.from()` receives the real `sessions` or
`credentials` table object (imported from `@nexus/db`), so a fake can route on
table identity. **A minimal fake Db is the intended approach — no source change,
no real Postgres.** (See Step 3 for the exact fake.)

### Repo conventions

- Runtime is **Bun**; tests run via `bun test` (never `tsc`/`vitest`).
- Structural pattern to match: `apps/agent/src/credentials/token-stream/tail-watcher.test.ts`.
  It imports `{ describe, expect, it, beforeEach, afterEach }` from `bun:test`
  (this file uses `it`, and per-test temp dirs via `mkdtempSync(join(tmpdir(), ...))`).
- Fixtures are SYNTHETIC: fabricate token counts and credential ids inline. NEVER
  read, copy, or reference a real user transcript or a real credential value.

## Commands you will need

| Purpose   | Command                                                                 | Expected on success |
|-----------|-------------------------------------------------------------------------|---------------------|
| Install   | `pnpm install`                                                          | exit 0              |
| Run these tests | `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test src/credentials/token-stream/` | all pass, 0 fail |
| Run one file    | `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test src/credentials/token-stream/cost-calculator.test.ts` | pass |
| Typecheck | `pnpm typecheck`  (root, turbo — or `cd apps/agent && pnpm typecheck`)   | exit 0, no errors   |

Notes:
- `NEXUS_ATTACH_SECRET=test` is set defensively per the repo's test convention
  (the agent harness may read it); none of these three modules read it, and no
  test here touches a real DB or the network.

## Scope

**In scope** (the only files you should create/modify):
- `apps/agent/src/credentials/token-stream/cost-calculator.test.ts` (create)
- `apps/agent/src/credentials/token-stream/transcript-locator.test.ts` (create)
- `apps/agent/src/credentials/token-stream/attribution.test.ts` (create)
- `plans/README.md` (status row update only, IF the file exists)

**Out of scope** (do NOT touch, even though they look related):
- Every `.ts` source file under `token-stream/` and `model-pricing.ts` — this is
  characterization of EXISTING behavior. If a test fails against current source,
  the test is wrong or the code drifted (a STOP condition), NOT the source.
- `lifecycle.ts` and `events.ts` — orchestration + bus glue with heavy DB/bus
  wiring; out of scope for this pass (see Maintenance notes).
- `tail-watcher.ts` / `tail-watcher.test.ts` — already tested; read for pattern only.

## Git workflow

- Branch: `advisor/015-token-stream-cost-tests`
- Commit style: conventional commits, e.g.
  `test(agent): add unit tests for token-stream cost + attribution`
- Do NOT push or open a PR.

## Steps

### Step 1: Branch + cost-calculator test file (money path first)

Create the branch `advisor/015-token-stream-cost-tests`, then create
`apps/agent/src/credentials/token-stream/cost-calculator.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { computeCost } from "./cost-calculator";
import { computeTokenCost } from "../model-pricing";

// The long-name usage object computeCost expects.
const usage = (i: number, o: number, cr = 0, cc = 0) => ({
  inputTokens: i,
  outputTokens: o,
  cacheReadInputTokens: cr,
  cacheCreationInputTokens: cc,
});

describe("computeCost — known-model pricing", () => {
  it("prices 1M sonnet input tokens at $3", () => {
    expect(computeCost("claude-sonnet-4-6", usage(1_000_000, 0), "s1")).toBe(3);
  });
  it("prices a mixed sonnet turn (input+output)", () => {
    expect(computeCost("claude-sonnet-4-6", usage(1000, 1000), "s1")).toBeCloseTo(0.018, 9);
  });
  it("prices 1M opus output tokens at $75", () => {
    expect(computeCost("claude-opus-4-6", usage(0, 1_000_000), "s1")).toBe(75);
  });
  it("includes cache read + cache creation rates", () => {
    // haiku: cacheRead 0.08, cacheCreation 1 per 1M
    expect(computeCost("claude-haiku-4-5-20251001", usage(0, 0, 1_000_000, 1_000_000), "s1"))
      .toBeCloseTo(0.08 + 1, 9);
  });
  it("returns 0 (not null) for a known model with zero usage", () => {
    expect(computeCost("claude-sonnet-4-6", usage(0, 0), "s1")).toBe(0);
  });
  it("handles a very large token count", () => {
    expect(computeCost("claude-sonnet-4-6", usage(1_000_000_000, 0), "s1")).toBe(3000);
  });
});

describe("computeCost — unknown model", () => {
  it("returns null for an unrecognized model", () => {
    expect(computeCost("gpt-4o", usage(1000, 1000), "s1")).toBeNull();
  });
});

describe("computeTokenCost — pure math", () => {
  it("matches computeCost for a known model", () => {
    expect(computeTokenCost("claude-sonnet-4-6", usage(1_000_000, 0)))
      .toBe(computeCost("claude-sonnet-4-6", usage(1_000_000, 0), "s1"));
  });
  it("returns null for an unknown model", () => {
    expect(computeTokenCost("nope", usage(1, 1))).toBeNull();
  });
});
```

**Verify**: `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test src/credentials/token-stream/cost-calculator.test.ts`
-> all pass, 0 fail. If an expected number is off, DO NOT edit the source —
recompute with the formula in "Current state"; if the source truly disagrees,
treat it as a STOP condition (pricing may have drifted).

### Step 2: transcript-locator test file (path encoding + fast path)

Create `apps/agent/src/credentials/token-stream/transcript-locator.test.ts`.
Redirect `homedir()` by setting `process.env.HOME` to a temp dir, and build the
expected path with the SAME `homedir()` the code uses so both agree:

```ts
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { locateTranscript } from "./transcript-locator";

let home: string;
let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "nexus-locator-"));
  process.env.HOME = home;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

describe("locateTranscript — fast path (file exists)", () => {
  it("resolves the encoded projects/<enc>/<id>.jsonl path", async () => {
    const cwd = "/home/user/dev/nx";
    const id = "11111111-2222-3333-4444-555555555555";
    const enc = "-home-user-dev-nx"; // cwd.replaceAll("/", "-")
    const dir = join(homedir(), ".claude", "projects", enc);
    mkdirSync(dir, { recursive: true });
    const expected = join(dir, id + ".jsonl");
    writeFileSync(expected, "{}\n");

    const got = await locateTranscript(cwd, id);
    expect(got).toBe(expected);
    // Pin the encoding convention (leading "/" -> leading "-").
    expect(got).toContain(enc);
  });
});

describe("locateTranscript — missing file", () => {
  it("resolves null after the watch timeout when the transcript never appears", async () => {
    const got = await locateTranscript("/home/user/dev/nowhere", "does-not-exist-uuid");
    expect(got).toBeNull();
  }, 8000); // WATCH_TIMEOUT_MS is 5000ms — allow headroom over Bun's 5s default.
});
```

**Verify**: `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test src/credentials/token-stream/transcript-locator.test.ts`
-> both pass (the missing-file test takes ~5 s — expected). If the fast-path test
returns `null` instead of the expected path, the `homedir()` redirect did not take
effect — see STOP conditions.

### Step 3: attribution test file — fake Db + branch cases

Create `apps/agent/src/credentials/token-stream/attribution.test.ts`. The fake Db
routes on table identity (no real Postgres, no source change):

```ts
import { describe, expect, it } from "bun:test";
import type { Db } from "@nexus/db";
import { sessions, credentials } from "@nexus/db";
import { attributeTurnToCredential } from "./attribution";

type SessionRow = { credentialId: string | null; credentialFingerprint: string | null };
type CredRow = { fingerprint: string | null };

// Minimal fake of the drizzle chain used by attributeTurnToCredential:
// db.select(...).from(table).where(...).limit(1) resolving to an array of rows.
// .from() receives the real sessions/credentials table object, so we route on it.
function fakeDb(opts: { sessionRows?: SessionRow[]; credRows?: CredRow[] }): Db {
  return {
    select: () => {
      let rows: unknown[] = [];
      const b = {
        from(table: unknown) {
          rows = table === credentials ? (opts.credRows ?? []) : (opts.sessionRows ?? []);
          return b;
        },
        where() { return b; },
        limit() { return Promise.resolve(rows); },
      };
      return b;
    },
  } as unknown as Db;
}

describe("attributeTurnToCredential", () => {
  const ts = new Date("2026-07-03T00:00:00.000Z"); // _turnTs is currently unused

  it("(C) passes through when the session has id + fingerprint", async () => {
    const db = fakeDb({ sessionRows: [{ credentialId: "cred-1", credentialFingerprint: "fp-abc" }] });
    expect(await attributeTurnToCredential(db, "sess-1", ts))
      .toEqual({ credentialId: "cred-1", credentialFingerprint: "fp-abc" });
  });

  it("(B) looks up the fingerprint when the session has an id but no fingerprint", async () => {
    const db = fakeDb({
      sessionRows: [{ credentialId: "cred-2", credentialFingerprint: null }],
      credRows: [{ fingerprint: "fp-looked-up" }],
    });
    expect(await attributeTurnToCredential(db, "sess-2", ts))
      .toEqual({ credentialId: "cred-2", credentialFingerprint: "fp-looked-up" });
  });

  it("(B) returns null fingerprint when the credential row is missing", async () => {
    const db = fakeDb({
      sessionRows: [{ credentialId: "cred-3", credentialFingerprint: null }],
      credRows: [], // no matching credential
    });
    expect(await attributeTurnToCredential(db, "sess-3", ts))
      .toEqual({ credentialId: "cred-3", credentialFingerprint: null });
  });

  it("(A) returns nulls when the session is not found", async () => {
    const db = fakeDb({ sessionRows: [] });
    expect(await attributeTurnToCredential(db, "missing", ts))
      .toEqual({ credentialId: null, credentialFingerprint: null });
  });

  it("returns nulls when the session has no credential assigned", async () => {
    const db = fakeDb({ sessionRows: [{ credentialId: null, credentialFingerprint: null }] });
    expect(await attributeTurnToCredential(db, "sess-4", ts))
      .toEqual({ credentialId: null, credentialFingerprint: null });
  });
});
```

**Verify**: `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test src/credentials/token-stream/attribution.test.ts`
-> all pass, 0 fail. If the fake does not satisfy `as unknown as Db` at typecheck,
see STOP conditions (optional seam fallback).

### Step 4: Full-suite + typecheck + commit

Run the whole directory and typecheck, then commit:

```
cd apps/agent && NEXUS_ATTACH_SECRET=test bun test src/credentials/token-stream/
pnpm typecheck
git checkout -b advisor/015-token-stream-cost-tests
git add apps/agent/src/credentials/token-stream/cost-calculator.test.ts apps/agent/src/credentials/token-stream/transcript-locator.test.ts apps/agent/src/credentials/token-stream/attribution.test.ts
git commit -m "test(agent): add unit tests for token-stream cost + attribution"
```

(If you created the branch already in Step 1, skip the `git checkout -b` line.)
Also stage `plans/README.md` only if it exists and you updated the status row.
Do NOT push or open a PR.

## Test plan

Three new test files under `apps/agent/src/credentials/token-stream/`, modeled
structurally on `tail-watcher.test.ts` (`bun:test`, `describe`/`it`/`expect`,
temp dirs for filesystem fixtures):

- `cost-calculator.test.ts` — known-model exact prices (sonnet/opus/haiku),
  cache-rate inclusion, zero usage -> 0, large counts, unknown model -> null;
  plus two `computeTokenCost` pure-math assertions. (Step 1)
- `transcript-locator.test.ts` — fast path returns the correctly-encoded path
  (pins the `/`->`-` convention), missing file resolves null after the 5 s watch.
  (Step 2)
- `attribution.test.ts` — a fake Db routing on table identity; the four branch
  cases (pass-through, fingerprint lookup, missing credential row, missing
  session) plus the null-credential fall-through. (Step 3)

Verification: `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test src/credentials/token-stream/`
-> all pass (existing `tail-watcher.test.ts` still green + the new suites), and
`pnpm typecheck` -> exit 0.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] The three test files exist under `apps/agent/src/credentials/token-stream/`.
- [ ] `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test src/credentials/token-stream/` exits 0, all pass, 0 fail.
- [ ] `pnpm typecheck` exits 0.
- [ ] No source `.ts` under `token-stream/` or `model-pricing.ts` is modified
      (`git diff --stat` shows only the three new `*.test.ts` files, plus
      `plans/README.md` if updated).
- [ ] No real transcript, credential value, or real token/dollar figure appears
      in any test file (all fixtures are synthetic).
- [ ] `plans/README.md` status row for 015 updated (only if that file exists).

## STOP conditions

Stop and report back (do not improvise) if:

- The source at the "Current state" locations does not match the description
  (pricing table, `computeCost` signature, attribution branches, or the path
  encoding drifted since this plan was written).
- A `computeCost` expected value fails against current source — that means the
  pricing table changed; report the new rates rather than editing the test to pass.
- The `transcript-locator` fast-path test returns `null` — the `homedir()` /
  `$HOME` redirect is not taking effect in this Bun version. Report it; do NOT
  work around it by writing into the real `~/.claude/projects`.
- The `fakeDb` cannot be made to satisfy `as unknown as Db`, or the attribution
  calls throw on the fake. The OPTIONAL, clearly-flagged fallback is a minimal
  seam extraction: add an exported pure helper to `attribution.ts`, e.g.
  `resolveAttribution(session, credFingerprint)` holding branches (A)/(B)/(C),
  and unit-test THAT directly — but this touches source, so STOP and get approval
  first (it is outside this plan's additive-tests-only scope).
- Any step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

For the human/agent who owns this code after the change lands:

- These are CHARACTERIZATION tests. When the `read-cc-telemetry-from-influxdb`
  migration replaces the transcript-tail path, they will fail — that is the
  signal to port or retire them deliberately alongside that change, not to
  silently delete them.
- `attribution.ts` has a documented future branch: when the `credential_swaps`
  table lands (bead nx-wce7), per-turn attribution replaces the session-level
  fallback and `_turnTs` becomes load-bearing. The current tests pin only the
  fallback; add swap-lookup cases when that branch is implemented.
- A reviewer should scrutinize: (a) no real token/dollar values or credentials
  in fixtures; (b) the `fakeDb` routes on the real `sessions`/`credentials` table
  identity (not by call order — order-based routing breaks if the source reorders
  queries); (c) cost expectations were recomputed from the rate table, not copied.
- Deferred out of this plan (and why): `lifecycle.ts` (needs a real/faked DB
  transaction + bus assertions — a much larger fixture surface) and `events.ts`
  (bus emit glue); the warn-once LOG side effect in `computeCost` (asserting it
  requires a logger spy for near-zero value — the null return is what matters).
