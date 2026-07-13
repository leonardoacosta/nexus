# Plan 032: Give TmuxPtySource's 11 spawn call sites safeSpawn's allowlist guarantee

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 089e0338..HEAD -- apps/agent/src/terminal/tmux-pty-source.ts apps/agent/src/terminal/tmux-pty-source.test.ts packages/core/src/safe-spawn.ts .audit-suppressions.json`
> If the diff is non-empty, compare the "Current state" excerpts below against
> the live code before proceeding; on a mismatch, treat it as a STOP condition.
> (Verified at authoring time: this diff is empty — `HEAD` is one commit ahead
> of `089e0338`, an unrelated `bun.lock` regeneration, so none of the four
> files above have moved.)

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (touches the core terminal-attach spawn path; mitigated by the
  existing `SpawnFns` injection seam meaning production behavior only changes
  at the single default-construction choke point, not at each call site)
- **Depends on**: none
- **Category**: security (spawn-wrapper coverage gap)
- **Planned at**: commit `089e0338`, 2026-07-13

## Why this matters

`TmuxPtySource` (`apps/agent/src/terminal/tmux-pty-source.ts`) is the PTY
harness behind every lazy-attach terminal session — the core "attach to a
`claude` session over Tailscale" capability. Its 11 spawn/`spawnSync` call
sites bind straight to raw `Bun.spawn`/`Bun.spawnSync` by default, never
through `safeSpawn` (`packages/core/src/safe-spawn.ts`), whose own header
comment states "every production call site that spawns a child process MUST
go through this wrapper." Worse, the file's own doc comments assert a
protection that isn't wired up ("the spawn will reject with a
DisallowedBinaryError... even though safeSpawn already does"), and
`.audit-suppressions.json`'s D4 entry that was clearly meant to cover this gap
names a different file (`terminal/pty-source.ts`, a node-pty-based file with
nothing to do with `Bun.spawn`) plus a glob (`services/pty*`) that matches
zero files on disk. The net effect: the repo's own audit tooling believes this
gap is covered, and it is not. This plan closes the gap at its real choke
point and repoints the suppression at the file it was always meant to cover.

## Current state

Files (all paths repo-relative):

- `apps/agent/src/terminal/tmux-pty-source.ts` (700 lines) — the class. All 11
  spawn/`spawnSync` calls route through `this.spawn.spawn(...)` /
  `this.spawn.spawnSync(...)`, an injectable adapter (`SpawnFns`, exported)
  whose **production default** is raw Bun functions.
- `apps/agent/src/terminal/tmux-pty-source.test.ts` (Tier 1 unit tests, no
  live tmux) — every existing test constructs `TmuxPtySource` with an injected
  recording mock (`new TmuxPtySource(TARGET, { spawn: rec.adapter })`); none
  exercise the production default path. Confirmed by fresh run at
  `089e0338`: `bun test apps/agent/src/terminal/tmux-pty-source.test.ts` →
  `11 pass, 0 fail`.
- `packages/core/src/safe-spawn.ts` (the sanctioned wrapper) — `ALLOWED_BINARIES`
  (lines 27–41) already lists `"tmux"` (line 28) and `"cat"` (line 34), but
  **not** `"mkfifo"`.
- `.audit-suppressions.json` — the misdirected D4 entry (lines 4–10):
  ```json
          {
              "id": "D4",
              "paths": [
                  "apps/agent/src/terminal/pty-source.ts",
                  "apps/agent/src/services/pty*"
              ],
              "reason": "tmux harness management is the product — spawn is core capability, wrapped by safeSpawn"
          },
  ```
  `apps/agent/src/terminal/pty-source.ts` is confirmed to exist and confirmed
  to spawn via `pty.spawn(shell, args, ...)` — node-pty's own method, a
  completely different mechanism from `Bun.spawn`. `apps/agent/src/services/pty*`
  matches **zero files** (confirmed: `apps/agent/src/services/` has no `pty*`
  entries at all).

**Constructor default** (`tmux-pty-source.ts:196-210`):

```ts
  private readonly spawn: SpawnFns;

  constructor(
    private readonly target: string,
    opts: TmuxPtySourceOptions = {},
  ) {
    this.spawn = opts.spawn ?? { spawn: Bun.spawn, spawnSync: Bun.spawnSync };
    const capacity = opts.scrollbackCapacity ?? DEFAULT_SCROLLBACK_CAPACITY;
    this.scrollback = new RingBuffer(capacity);
    this.seedScrollback();
    this.sampleGeometry();
    this.startPipePane();
  }
```

**The 11 call sites** (all confirmed present at these exact lines; all already
route through `this.spawn.spawn`/`this.spawn.spawnSync` — none of these
individual lines need to change, see Design decision below):

| Line | Method | Call |
|------|--------|------|
| 219 | `seedScrollback()` (ctor) | `spawnSync(["tmux","capture-pane",...])` |
| 288 | `sampleGeometry()` (ctor + read loop) | `spawnSync(["tmux","display-message",...])` |
| 362 | `startPipePane()` (ctor) | `spawnSync(["mkfifo", fifoPath])` |
| 376 | `startPipePane()` (ctor) | `spawn(["cat", fifoPath], ...)` |
| 392 | `startPipePane()` (ctor) | `spawnSync(["tmux","pipe-pane","-O",...])` |
| 514 | `doWrite()` (async) | `spawn(["tmux","send-keys",...])` |
| 579 | `resize()` | `spawnSync(["tmux","resize-window",...])` |
| 628 | `unsetWindowSize()` | `spawnSync(["tmux","resize-window","-A",...])` |
| 638 | `unsetWindowSize()` | `spawnSync(["tmux","set-option","-u",...])` |
| 656 | `setWindowSizeOption()` | `spawnSync(["tmux","set-option","-w",...])` |
| 671 | `close()` | `spawnSync(["tmux","pipe-pane",...])` |

**safeSpawn facts you need** (`packages/core/src/safe-spawn.ts`, re-exported
via `@nexus/core/node`):

- `safeSpawn(binary, args, opts) => SafeSpawnHandle` is **fully async** —
  `SafeSpawnHandle.exitCode` is a `Promise<number>`. There is **no synchronous
  equivalent** exported anywhere in `packages/core`.
- `assertAllowedBinary(binary): asserts binary is AllowedBinary` (throws
  `DisallowedBinaryError`) and `isSafeArg(arg): boolean` are exported
  separately and are exactly the two checks `safeSpawn()` runs internally
  before it calls the real `Bun.spawn`.
- `ALLOWED_BINARIES` (line 27) is a plain `as const` array — adding an entry
  is a one-line, reviewed code change (by design, per its own doc comment).

### Design decision (read this before writing any code)

Of the 11 call sites, only 2 (`spawn` at lines 376, 514) are already
asynchronous. The other 9 are `spawnSync`, invoked from genuinely synchronous
contexts: the constructor (which the class's own header comment documents as
a **synchronous** "Construct: spawn `tmux pipe-pane`..." step, relied on by
the lazy-attach WS-upgrade path in `server-websocket.ts:191`,
`const pty = new TmuxPtySource(target);` — no `await`), plus `resize()`,
`unsetWindowSize()`, `setWindowSizeOption()`, and `close()`.

Because `safeSpawn()` has no sync form, you **cannot** replace these 9
`spawnSync` calls with literal `safeSpawn()` calls without making the
constructor (and therefore every caller of `new TmuxPtySource(...)`) async —
that is an architecture change to the `PtySource` construction contract, well
beyond this file, and out of scope for this plan.

**The fix**: all 11 call sites already funnel through the single injectable
adapter (`this.spawn.spawn` / `this.spawn.spawnSync`) — that indirection is
the existing test seam. So the only production code that needs to change is
**what the default adapter is** (line 202). Build a small factory,
`createValidatedSpawnFns()`, that returns a `SpawnFns`-shaped object whose
`spawn`/`spawnSync` implementations call `assertAllowedBinary` on the binary
before delegating to the real `Bun.spawn`/`Bun.spawnSync`, then swap the
constructor default to use it. All 11 call sites get the identical allowlist
guarantee `safeSpawn()` provides, with a one-line production diff at the
choke point, zero changes to the 11 call sites themselves, and zero changes
needed to any test that already injects its own adapter.

**Do NOT also apply `isSafeArg`'s shell-metacharacter check in this wrapper.**
`doWrite()` (line ~512, `tmux send-keys -t <target> -l <text>`) sends
arbitrary client keystrokes that legitimately contain `;`, `$`, backticks,
newlines — a user's real shell input inside their attached session. The
sibling route `apps/agent/src/routes/commands-send-text.ts` hits the exact
same `tmux send-keys` shape and calls `safeSpawn(..., { trustArgs: true })`
for this exact reason (see `plans/020-send-text-safespawn-tmux-target-guard.md`).
Every call in this file is an argv-vector spawn (no shell on our side), so arg
*content* can never cause OS-level injection regardless of characters; the one
value that ever reaches a real shell (tmux's own, via the `pipe-pane` command
string at line 392) is the FIFO path, which is generated internally by
`mkdtempSync` and never attacker-controlled. The tmux *target* — the one
value that legitimately needs charset restriction — is validated separately
by `isValidTmuxTarget()` (line 144) before it ever reaches this class's
constructor (see the class doc comment at line 150: "Constructor MUST receive
a target validated upstream"). Applying `isSafeArg` in the wrapper would
throw `UnsafeArgError` on ordinary user keystrokes and break `write()`.

**ALLOWED_BINARIES verdict**: only `"mkfifo"` needs adding. `"tmux"` (line 28)
and `"cat"` (line 34) are already present — confirmed by direct read of
`packages/core/src/safe-spawn.ts`.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Core typecheck | `pnpm --filter @nexus/core typecheck` | exit 0 (verified clean baseline at `089e0338`) |
| Agent typecheck | `pnpm --filter @nexus/agent typecheck` | exit 0 |
| Statusline typecheck | `pnpm --filter @nexus/statusline typecheck` | exit 0 (unaffected by this plan; run as a full-gate sanity check) |
| Unit tests (this file) | `bun test apps/agent/src/terminal/tmux-pty-source.test.ts` | `11 pass, 0 fail` today; more after Step 4 |
| Full agent suite | `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test src/` | 0 fail (PG-gated tests skip without `POSTGRES_URL`) |
| Suppressions schema | `bash scripts/validate-audit-suppressions.sh` | exit 0 |
| Lint | `pnpm lint` (repo root, `turbo lint`) | exit 0 |

Runtime: Bun for execution (`bun test`), never `tsc` for execution — only for
`typecheck`. No DB, no migration — this plan touches zero schema files.

## Suggested executor toolkit

- `test-driven-development` skill — write the new tests in Step 4 before/with
  the implementation change in Step 2 if your workflow prefers RED-GREEN.
- `systematic-debugging` skill — if a typecheck or test failure doesn't match
  what a step predicts, use it before guessing at a fix.

## Scope

**In scope** (the only files you should modify):

- `apps/agent/src/terminal/tmux-pty-source.ts`
- `apps/agent/src/terminal/tmux-pty-source.test.ts`
- `packages/core/src/safe-spawn.ts` (ONE line: add `"mkfifo"` to
  `ALLOWED_BINARIES` — nothing else in this file)
- `.audit-suppressions.json` (the D4 entries described in Step 3)
- `plans/README.md` (status row only)

**Out of scope** (do NOT touch, even though they look related):

- `apps/agent/src/services/git-observer.ts`, `git-project.ts`,
  `git-project-resolver.ts`, `reaper-job.ts`, `process-watcher.ts`,
  `apps/agent/src/routes/handlers-status.ts`, `apps/agent/src/services/tailscale-presence.ts`
  — these bypass `safeSpawn` too but are a separate, lower-blast-radius
  mechanical fix (plan 033). Confirmed during authoring: all of them call
  `Bun.spawn` (async), never `Bun.spawnSync`, so they do not share this
  plan's sync/async design constraint — do not fold them in here.
- `apps/agent/src/terminal/pty-source.ts` — node-pty-based, unrelated
  mechanism (`pty.spawn()`, not `Bun.spawn`). You are only touching its
  `.audit-suppressions.json` entry's dead glob path (Step 3), never the file
  itself.
- `apps/agent/src/server-websocket.ts` — constructs `TmuxPtySource` (line 191);
  reference only, do not edit. Its synchronous `new TmuxPtySource(target)`
  call is exactly why the constructor cannot become async (see Design
  decision).
- `packages/core/src/safe-spawn.ts`'s `safeSpawn()` function, exports, or any
  new exported function (e.g. do NOT add a `safeSpawnSync`) — the fix lives
  entirely in `tmux-pty-source.ts`'s own default-adapter factory. The only
  change to this file is the one-line `ALLOWED_BINARIES` addition.
- `apps/agent/src/terminal/tmux-pty-source.integration.test.ts` — Tier 2
  live-tmux tests; you may run them for extra confidence (see Step 5) but do
  not need to edit them, and they are gated `describe.skipIf(!hasTmux)` so a
  tmux-less environment skips cleanly either way.

## Git workflow

- Work on the **current branch** (do not create a branch).
- Single commit, targeted adds only:
  `git add apps/agent/src/terminal/tmux-pty-source.ts apps/agent/src/terminal/tmux-pty-source.test.ts packages/core/src/safe-spawn.ts .audit-suppressions.json plans/README.md .beads/ && git commit && git push`
  (include `.beads/` only if the beads hook staged changes there; NEVER
  `git add .` or `git add -A`).
- Message style (match `git log`, e.g. `fix(agent): stop duplicating credential rows on token rotation`):
  `fix(agent): route TmuxPtySource spawns through safeSpawn's binary allowlist (plans/032)`

## Steps

### Step 1: Add `mkfifo` to `ALLOWED_BINARIES`

In `packages/core/src/safe-spawn.ts`, insert one line into the `ALLOWED_BINARIES`
array (after the `"cat"` entry, since both are used by the same FIFO-plumbing
call site in `tmux-pty-source.ts`):

```ts
export const ALLOWED_BINARIES = [
  "tmux", // tmux harness management — the product
  "git", // project discovery, branch detection
  "claude", // Claude Code CLI hook relay
  "ssh", // terminal attach via remote shells
  "bash", // PTY shell for interactive sessions
  "sh", // POSIX shell fallback
  "cat", // session log tailing
  "mkfifo", // create the named pipe tmux-pty-source.ts streams pane output through (plans/032)
  "nexus", // self-invocation (CLI tests, register)
  ...
```

Do not reorder or touch any other entry.

**Verify**: `grep -n '"mkfifo"' packages/core/src/safe-spawn.ts` → exactly one
match, inside the `ALLOWED_BINARIES` array.

**Verify**: `pnpm --filter @nexus/core typecheck` → exit 0.

### Step 2: Add `createValidatedSpawnFns()` and swap the constructor default

In `apps/agent/src/terminal/tmux-pty-source.ts`:

1. Extend the existing import (currently `import { logger } from "@nexus/core/node";`
   at line 37) to also pull `assertAllowedBinary`:

```ts
import { assertAllowedBinary, logger } from "@nexus/core/node";
```

2. Immediately after the `SpawnFns` interface (after line 126, before
   `TmuxPtySourceOptions`), add the exported factory:

```ts
/**
 * Production spawn adapter — validates the binary against safeSpawn's
 * ALLOWED_BINARIES (packages/core/src/safe-spawn.ts) before delegating to
 * the real Bun.spawn/Bun.spawnSync.
 *
 * This is NOT a call to safeSpawn() itself: safeSpawn is fully async
 * (SafeSpawnHandle.exitCode is a Promise), but 9 of this file's 11 spawn
 * call sites run synchronously (the constructor, resize(), unsetWindowSize(),
 * setWindowSizeOption(), close()) and there is no sync safeSpawn equivalent.
 * Reusing assertAllowedBinary here gives every call site the same allowlist
 * guarantee safeSpawn provides, at the single choke point where the default
 * adapter is constructed, without an architecture change to make
 * construction/resize/close async (see plans/032 Design decision).
 *
 * Arg-CONTENT validation (safeSpawn's other guarantee, isSafeArg) is
 * deliberately NOT applied here: doWrite()'s `tmux send-keys -l <text>` call
 * sends arbitrary client keystrokes that legitimately contain shell
 * metacharacters. Every call in this file is an argv-vector spawn (no shell
 * on our side), so arg content can never cause OS-level injection regardless
 * of characters; the tmux TARGET is validated separately by
 * isValidTmuxTarget() before it reaches this class's constructor.
 */
export function createValidatedSpawnFns(): SpawnFns {
  function checkBinary(argv: readonly string[]): void {
    const binary = argv[0];
    if (binary !== undefined) assertAllowedBinary(binary);
  }
  return {
    spawn: ((argv: string[], opts?: unknown) => {
      checkBinary(argv);
      return Bun.spawn(argv, opts as Parameters<typeof Bun.spawn>[1]);
    }) as typeof Bun.spawn,
    spawnSync: ((argv: string[], opts?: unknown) => {
      checkBinary(argv);
      return Bun.spawnSync(argv, opts as Parameters<typeof Bun.spawnSync>[1]);
    }) as typeof Bun.spawnSync,
  };
}
```

   (If `pnpm --filter @nexus/agent typecheck` complains about the `as`-cast
   shape after Step 5, adjust the casts to match — every call site in this
   file already calls `this.spawn.spawn(argv, opts)` / `this.spawn.spawnSync(argv, opts)`
   with an array first argument, never Bun's object-form overload, so a cast
   equivalent in spirit to the existing test mock's
   `as unknown as typeof Bun.spawn` pattern — see `tmux-pty-source.test.ts:75,92` —
   is acceptable here too.)

3. Change the constructor default (line 202) from:

```ts
    this.spawn = opts.spawn ?? { spawn: Bun.spawn, spawnSync: Bun.spawnSync };
```

   to:

```ts
    this.spawn = opts.spawn ?? createValidatedSpawnFns();
```

Do not change anything else in the constructor, and do not touch any of the
11 call sites listed in "Current state" — they are unaffected by this change
because they already call through `this.spawn`.

**Verify**: `grep -n 'createValidatedSpawnFns\|assertAllowedBinary' apps/agent/src/terminal/tmux-pty-source.ts`
→ at least 4 matches (import, function definition, function body call, constructor use).

**Verify**: `grep -n 'Bun.spawn, spawnSync: Bun.spawnSync' apps/agent/src/terminal/tmux-pty-source.ts`
→ no match (the raw literal default is gone from the constructor).

**Verify**: `pnpm --filter @nexus/agent typecheck` → exit 0.

**Verify**: `bun test apps/agent/src/terminal/tmux-pty-source.test.ts` →
`11 pass, 0 fail` (unchanged — every existing test injects its own adapter via
`{ spawn: rec.adapter }`, bypassing `createValidatedSpawnFns()` entirely, so
none of them should be affected by this step).

### Step 3: Fix the misdirected `.audit-suppressions.json` D4 entry

The existing entry (near the top of the `suppressions` array) is:

```json
        {
            "id": "D4",
            "paths": [
                "apps/agent/src/terminal/pty-source.ts",
                "apps/agent/src/services/pty*"
            ],
            "reason": "tmux harness management is the product — spawn is core capability, wrapped by safeSpawn"
        },
```

Replace it with two entries: the original one, corrected (drop the dead glob,
fix the reason to accurately describe `pty-source.ts`'s own node-pty
mechanism instead of implying it's "wrapped by safeSpawn" — it never was and
still isn't, nor does it need to be), plus a new entry that actually covers
the file this plan just fixed:

```json
        {
            "id": "D4",
            "paths": [
                "apps/agent/src/terminal/pty-source.ts"
            ],
            "reason": "Spawns via node-pty's own pty.spawn(), a different mechanism from Bun.spawn/safeSpawn entirely — no safeSpawn wrapping applies or is needed here. The apps/agent/src/services/pty* glob (matched zero files) was removed by plans/032."
        },
        {
            "id": "D4",
            "paths": [
                "apps/agent/src/terminal/tmux-pty-source.ts"
            ],
            "reason": "TmuxPtySource's default spawn adapter (createValidatedSpawnFns, added by plans/032) validates every binary against safeSpawn's ALLOWED_BINARIES via assertAllowedBinary before delegating to Bun.spawn/Bun.spawnSync. Literal safeSpawn() is not called directly because 9 of the file's 11 spawn call sites are synchronous and safeSpawn is async-only — see plans/032 Design decision."
        },
```

Do not touch any other entry in the file (A2, F2, E5, C15, E7, D5, A4, etc.).

**Verify**: `grep -c '"apps/agent/src/services/pty\*"' .audit-suppressions.json`
→ `0` (grep exits 1).

**Verify**: `grep -n 'terminal/tmux-pty-source.ts' .audit-suppressions.json`
→ 1 match.

**Verify**: `bash scripts/validate-audit-suppressions.sh` → exit 0 (schema
still valid — non-empty `id`/`paths`/`reason` on every entry).

### Step 4: Add unit tests pinning the validated default

In `apps/agent/src/terminal/tmux-pty-source.test.ts`:

1. Extend the existing import line (`import { TmuxPtySource, type SpawnFns } from "./tmux-pty-source";`)
   to also pull the new factory, and import `DisallowedBinaryError` from
   `@nexus/core/node` (the same barrel `logger` is already imported from
   elsewhere in this test suite via `@nexus/core/node` — confirm with
   `grep -n '@nexus/core/node' apps/agent/src/terminal/tmux-pty-source.test.ts`
   before adding a second import line for the same module; merge into one
   import if one already exists):

```ts
import { DisallowedBinaryError } from "@nexus/core/node";
import { TmuxPtySource, createValidatedSpawnFns, type SpawnFns } from "./tmux-pty-source";
```

2. Add a new `describe` block (anywhere at the top level of the file, e.g.
   right after the existing `describe("TmuxPtySource argv (Tier 1, ...)"` block
   closes):

```ts
describe("createValidatedSpawnFns (production default, D4 fix — plans/032)", () => {
  it("rejects a disallowed binary via spawnSync before touching Bun.spawnSync", () => {
    const fns = createValidatedSpawnFns();
    expect(() => fns.spawnSync(["not-an-allowed-binary", "x"])).toThrow(
      DisallowedBinaryError,
    );
  });

  it("rejects a disallowed binary via spawn before touching Bun.spawn", () => {
    const fns = createValidatedSpawnFns();
    expect(() => fns.spawn(["not-an-allowed-binary", "x"])).toThrow(
      DisallowedBinaryError,
    );
  });

  it("allows mkfifo (added to ALLOWED_BINARIES by plans/032)", () => {
    const fns = createValidatedSpawnFns();
    // `which` is always in ALLOWED_BINARIES and universally present — this
    // proves the allowlisted path reaches the real Bun.spawnSync (exit code
    // may be 0 or 1 depending on whether `mkfifo` is on PATH; either is a
    // real execution, not a DisallowedBinaryError throw).
    expect(() => fns.spawnSync(["which", "mkfifo"])).not.toThrow();
  });

  it("TmuxPtySource with no injected adapter uses the validated default without throwing", () => {
    // No live tmux session named this way exists — every production call
    // site is best-effort / try-catch, so construction and close() must not
    // throw even though the underlying tmux calls fail. This only proves the
    // production (no opts.spawn) path is wired through createValidatedSpawnFns
    // and stays exception-safe end-to-end.
    const source = new TmuxPtySource("nx-plan032-nonexistent-session:0.0");
    expect(() => source.close()).not.toThrow();
  });
});
```

**Verify**: `bun test apps/agent/src/terminal/tmux-pty-source.test.ts` →
`15 pass, 0 fail` (11 existing + 4 new).

### Step 5: Full gates

Run, from the repo root unless noted:

1. `pnpm --filter @nexus/core typecheck` → exit 0.
2. `pnpm --filter @nexus/agent typecheck` → exit 0.
3. `pnpm --filter @nexus/statusline typecheck` → exit 0 (sanity check — this
   plan does not touch the statusline, confirming no cross-package breakage).
4. `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test src/` → 0 fail.
5. If `tmux` is installed on this machine
   (`which tmux && echo yes || echo no`), also run:
   `cd apps/agent && bun test src/terminal/tmux-pty-source.integration.test.ts`
   → all pass (Tier 2 live-tmux round-trip; confirms `createValidatedSpawnFns`
   doesn't break real tmux argv). If `tmux` is absent, this suite
   self-skips (`describe.skipIf(!hasTmux)`) — that is expected, not a failure.
6. `bash scripts/validate-audit-suppressions.sh` → exit 0.
7. `pnpm lint` → exit 0.
8. `git status --short` → changes only in the 4 in-scope source files +
   `plans/README.md` (+ `.beads/` from hooks).

Then update `plans/README.md` (add a 032 row) and commit per the Git workflow
section.

## Test plan

- File: `apps/agent/src/terminal/tmux-pty-source.test.ts` (extend in place,
  do not rewrite existing tests).
- Structural pattern to mimic: the file's own existing `makeRecorder()` /
  `describe("TmuxPtySource argv (Tier 1, ...)")` block for style; the new
  block is simpler (no live tmux, no recorder needed) since it tests the
  factory function directly.
- Cases after this plan:
  1. `createValidatedSpawnFns().spawnSync([...])` with a disallowed binary
     throws `DisallowedBinaryError` (NEW — this is the regression gate: it
     MUST fail if the allowlist check is ever removed from the default
     adapter).
  2. Same, for `.spawn(...)` (NEW).
  3. `createValidatedSpawnFns().spawnSync(["which", "mkfifo"])` does not throw
     (NEW — proves `mkfifo` allowlisting from Step 1 landed and the happy
     path still reaches the real Bun function).
  4. `new TmuxPtySource(target)` with no injected adapter — production default
     path — does not throw on construction or `close()` (NEW — proves the
     constructor wiring in Step 2 is exception-safe).
  5. All 11 existing argv-pinning tests continue to pass unchanged (they
     inject their own adapter, bypassing the default entirely).
- Verification: `bun test apps/agent/src/terminal/tmux-pty-source.test.ts` →
  `15 pass, 0 fail`.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -n '"mkfifo"' packages/core/src/safe-spawn.ts` → 1 match inside `ALLOWED_BINARIES`
- [ ] `grep -n 'createValidatedSpawnFns' apps/agent/src/terminal/tmux-pty-source.ts` → matches for both the definition and the constructor use-site
- [ ] `grep -c 'Bun.spawn, spawnSync: Bun.spawnSync' apps/agent/src/terminal/tmux-pty-source.ts` → 0 (grep exits 1) — the raw literal default is gone
- [ ] `grep -c '"apps/agent/src/services/pty\*"' .audit-suppressions.json` → 0 (grep exits 1)
- [ ] `grep -n 'terminal/tmux-pty-source.ts' .audit-suppressions.json` → 1 match
- [ ] `bash scripts/validate-audit-suppressions.sh` → exit 0
- [ ] `bun test apps/agent/src/terminal/tmux-pty-source.test.ts` → `15 pass, 0 fail`
- [ ] `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test src/` → 0 fail
- [ ] `pnpm --filter @nexus/core typecheck` exits 0
- [ ] `pnpm --filter @nexus/agent typecheck` exits 0
- [ ] `pnpm lint` exits 0
- [ ] `git status --short` shows changes ONLY in the 4 in-scope source files + `plans/README.md` (+ `.beads/` from hooks)
- [ ] `plans/README.md` has a 032 status row

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check at the top shows any of the 4 in-scope files changed since
  `089e0338` and the "Current state" excerpts/line numbers no longer match.
- `import { assertAllowedBinary } from "@nexus/core/node"` does not resolve
  (check `packages/core/src/node.ts` for the export list). Do not invent a
  new export path or add a new export to `safe-spawn.ts` beyond the one-line
  `ALLOWED_BINARIES` addition authorized in Step 1.
- Any existing test in `tmux-pty-source.test.ts` (the 11 argv-pinning tests)
  starts failing after Step 2 — that means the constructor default swap
  leaked into a call path a test didn't expect; do not "fix" a test's
  assertions to match new behavior without first confirming the test wasn't
  asserting on the OLD raw-Bun-spawn default specifically (none currently do,
  per the Current state section — if you find one that does, STOP, since
  that changes this plan's blast-radius assumption).
- Fixing anything appears to require making `TmuxPtySource`'s constructor,
  `resize()`, `unsetWindowSize()`, `setWindowSizeOption()`, or `close()`
  asynchronous, or changing `server-websocket.ts`'s
  `new TmuxPtySource(target)` call site — that is the architecture change
  the Design decision section explicitly rules out of scope.
- `pnpm --filter @nexus/agent typecheck` or `pnpm --filter @nexus/core typecheck`
  show NEW errors attributable to the in-scope files that you cannot resolve
  by adjusting the cast shape in `createValidatedSpawnFns()` (see the note at
  the end of Step 2).
- You find that `apps/agent/src/services/pty*` (the glob being removed in
  Step 3) actually DOES match a real file at execution time (re-check with
  `find apps/agent/src/services -iname 'pty*'` — it returned nothing at
  authoring time) — if it now matches something, do not silently drop its
  suppression; report back instead of guessing whether that file needs D4
  coverage.

## Maintenance notes

- Reviewer scrutiny points: (1) confirm the constructor diff really is
  one line (`opts.spawn ?? createValidatedSpawnFns()`) and none of the 11
  call sites were touched — that's the whole point of this design; (2)
  confirm `isSafeArg`/arg-content validation was deliberately NOT added to
  `createValidatedSpawnFns` (see Design decision) — a reviewer unfamiliar
  with the `send-keys -l <text>` keystroke-passthrough requirement might
  otherwise "helpfully" add it and break normal terminal typing; (3) confirm
  the two `.audit-suppressions.json` entries both have accurate, distinct
  reasons — a future re-collapse of them back into one multi-path entry would
  re-introduce the exact "wrong file, wrong reason" drift this plan fixes.
- If a future change needs a genuinely synchronous, validated spawn primitive
  shared across the codebase (not just this file), that is a new, larger
  proposal (a `safeSpawnSync` in `packages/core/src/safe-spawn.ts`) — do not
  retrofit it into this plan's `createValidatedSpawnFns`, which is
  intentionally local and file-scoped.
- Plan 033 (6 other services bypassing `safeSpawn`: `git-observer.ts`,
  `git-project.ts`, `git-project-resolver.ts`, `reaper-job.ts`,
  `process-watcher.ts`, `tailscale-presence.ts`, plus
  `routes/handlers-status.ts`) is unaffected by this plan and should proceed
  independently — all of those call sites are already async (`Bun.spawn`,
  never `Bun.spawnSync`), so they can very likely call `safeSpawn()` directly
  with no design-decision detour like this plan needed.
- Deferred deliberately: whether `apps/agent/src/terminal/pty-source.ts`
  itself needs its OWN accurate D4 coverage for `pty.spawn()` (as opposed to
  the corrected-but-still-present suppression this plan leaves for it) is not
  re-verified here — doing so requires running the actual D4 audit-scan rule
  against that file, which is not a script committed to this repo. This plan
  leaves that file's suppression in place (with a corrected reason) rather
  than removing it, to avoid introducing a new, unrelated, unverified finding
  as a side effect of an unrelated fix.
