# Plan 020: Route /commands/send-text through safeSpawn and add the isValidTmuxTarget guard

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat c67ff12c..HEAD -- apps/agent/src/routes/commands-send-text.ts apps/agent/src/routes/commands-send-text.test.ts`
> If the diff is non-empty, compare the "Current state" excerpts below against
> the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tech-debt (spawn-convention regression with a defense-in-depth security angle)
- **Planned at**: commit `c67ff12c`, 2026-07-05

## Why this matters

`POST /commands/send-text` (used by watchOS notification actions Approve /
Deny / Custom) is the **only** production route in the agent that still spawns
a subprocess via raw `node:child_process.spawn`. Every other production spawn
site goes through `safeSpawn` (`packages/core/src/safe-spawn.ts`), whose
header mandates exactly that: *"Every production call site that spawns a child
process MUST go through this wrapper."* The route also never validates
`session.tmuxTarget` before splicing it into the tmux argv, whereas the
sibling lazy-attach path guards the **same DB field** with
`isValidTmuxTarget()` (`apps/agent/src/server-websocket.ts:180`).

Framing (settled, 2026-07-03 audit): this is a **single-site convention
regression**, not a live injection. Exploitability is LOW — the spawn is
argv-vector (no shell), `tmuxTarget` is DB-sourced inside the Tailscale trust
boundary, and the text payload is intended keystrokes. Do not describe it as
an exploitable hole in commit messages or comments. The value of the fix is
(a) restoring the "one grep finds every spawn" audit invariant, and (b)
closing the target-validation gap so both consumers of `tmuxTarget` behave
identically.

## Current state

Files (all paths repo-relative to `/home/nyaptor/dev/nx`):

- `apps/agent/src/routes/commands-send-text.ts` — the route (141 lines). Raw
  spawn import at line 23, spawn call at line 70, no target validation.
- `apps/agent/src/routes/commands-send-text.test.ts` — 3 existing tests; mocks
  `node:child_process` via `mock.module` (lines 26–56). Must be rewritten
  because the module being mocked goes away.
- `packages/core/src/safe-spawn.ts` — the sanctioned wrapper. `"tmux"` is
  already first in `ALLOWED_BINARIES` (line 28). **Do not modify this file.**
- `apps/agent/src/terminal/tmux-pty-source.ts:144-146` — `isValidTmuxTarget`,
  already exported. **Do not modify this file.**
- `apps/agent/src/index.ts:100` — production wiring:
  `initSendTextRoute(sessionManager);` (must keep compiling unchanged).

**Raw spawn today** (`commands-send-text.ts:23` and `:62-82`):

```ts
import { spawn } from "node:child_process";
// ...
function tmuxSendKeys(
  target: string,
  text: string,
  appendNewline: boolean,
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const args = ["send-keys", "-t", target, text];
    if (appendNewline) args.push("Enter");
    const child = spawn("tmux", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      resolve({ code: -1, stderr: err.message });
    });
    child.on("close", (code) => {
      resolve({ code: code ?? -1, stderr });
    });
  });
}
```

**Missing guard** — handler today (`commands-send-text.ts:110-115`):

```ts
  const tmuxTarget = session.tmuxTarget;
  if (!tmuxTarget || tmuxTarget.trim() === "") {
    return jsonError(409, `session has no tmuxTarget: ${sessionId}`);
  }

  const { code, stderr } = await tmuxSendKeys(tmuxTarget, text, appendNewline);
```

**The pattern to mirror** (`server-websocket.ts:180-183`):

```ts
  if (!isValidTmuxTarget(target)) {
    logger.warn({ sessionId, tmuxTarget: target }, "lazy-attach: rejected unsafe tmux target");
    return false;
  }
```

**The validator** (`tmux-pty-source.ts:144-146`, regex at `:46` is
`/^[A-Za-z0-9_.:%@/-]+$/`):

```ts
export function isValidTmuxTarget(target: string): boolean {
  return target.length > 0 && target.length <= 256 && TMUX_TARGET_RE.test(target);
}
```

**safeSpawn facts you need** (from `packages/core/src/safe-spawn.ts`, exported
via the `@nexus/core/node` barrel — see `apps/agent/src/utils/exec.ts:14`
`import { safeSpawn, type SafeSpawnHandle } from "@nexus/core/node";`):

- Signature: `safeSpawn(binary, args, opts) => SafeSpawnHandle` where the
  handle has `stderr` (a `ReadableStream<Uint8Array>` when piped, else
  undefined/number) and `exitCode: Promise<number>`.
- `opts.stdio` takes `[StdioMode, StdioMode, StdioMode]`.
- **Arg validation gotcha**: by default safeSpawn rejects any arg matching
  `/[;&|$`\n\r]/` by THROWING `UnsafeArgError`. The `text` argument here is
  intended keystrokes and legitimately contains such characters — the existing
  happy-path test sends `"ls\r"`, and a watchOS Custom reply may contain `;`
  or `$`. Therefore this call site MUST pass `trustArgs: true`, justified
  because (a) the spawn is argv-vector with no shell, and (b) the only
  non-literal arg besides `text` is `target`, which step 2 validates with
  `isValidTmuxTarget` (a strict charset that excludes every metacharacter)
  before the spawn. This mirrors the precedent at
  `apps/agent/src/services/process-watcher.ts:266-269` (comment + `trustArgs: true`).
- `Bun.spawn` (inside safeSpawn) **throws synchronously** when the binary is
  missing (there is no `'error'` event like node's spawn). A try/catch is
  required to preserve the route's never-throws `{ code, stderr }` contract
  and its existing "tmux not installed → 500" behavior.

**Test-mocking facts you need**:

- The existing test mocks `node:child_process` (lines 26–56) and installs a
  PARTIAL `mock.module("@nexus/core/node", ...)` (lines 59–69) that exports
  only `createLogger`/`logger`. Both must go.
- Do NOT mock `@nexus/core/node` at all in the rewritten test. Bun's
  `mock.module` is process-global and last-writer-wins; a partial factory
  strips `safeSpawn` for sibling suites (documented hazard —
  `apps/agent/src/testing/mock-core-node.ts:53-61`). The bun test preload
  (`apps/agent/src/testing/preload.ts`, wired via `apps/agent/bunfig.toml`)
  already silences `createLogger` for every suite, so deleting the local
  logger mock loses nothing.
- Also do NOT `mock.module("@nexus/core/node")` with a fake `safeSpawn` —
  `utils/exec.test.ts` exercises the REAL safeSpawn in the same process.
  Instead, use the injection seam added in Step 1 (the codebase precedent for
  test-controllable spawns is injection: `tmux-pty-source.ts:123-135`
  `SpawnFns`).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Route tests | `cd apps/agent && bun test src/routes/commands-send-text.test.ts` | `4 pass, 0 fail` after this plan (3 pass today) |
| Agent test suite | `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test src/` | 0 fail (PG-gated tests skip without `POSTGRES_URL`) |
| Typecheck | `pnpm typecheck` (repo root) | exit 0 — baseline was greened 2026-07-03 (informal plan 016). If it is red again, verify no NEW errors mention the two in-scope files, note the baseline drift, and continue. |
| Lint | `pnpm lint` (repo root) | exit 0 — same baseline caveat as typecheck |
| Spawn-convention grep | `grep -rln 'node:child_process' apps/agent/src/routes/` | exactly one line: `apps/agent/src/routes/specs/handlers-status.ts` (settled out-of-scope site — see Scope) |

Runtime: Bun (never `tsc` for execution). No DB, no migration — this plan
touches zero schema files.

## Scope

**In scope** (the only files you should modify):

- `apps/agent/src/routes/commands-send-text.ts`
- `apps/agent/src/routes/commands-send-text.test.ts`
- `plans/README.md` (status row only; add a row for 020 if none exists)

**Out of scope** (do NOT touch, even though they look related):

- `packages/core/src/safe-spawn.ts` — `tmux` is already allowlisted; no change
  needed. Editing the wrapper is another plan's territory.
- `apps/agent/src/terminal/tmux-pty-source.ts` — you import
  `isValidTmuxTarget` from it; do not edit it.
- `apps/agent/src/routes/specs/handlers-status.ts` — imports `spawnSync` from
  `node:child_process` (line 30) but is a settled, suppressed site (E5 /
  sync-I/O audit decision). Leave it; it is the one expected survivor of the
  convention grep.
- `apps/agent/src/db/agent-registry.ts`, `apps/agent/src/services/tailscale-presence.ts`
  — other `node:child_process` importers outside `routes/`; separately settled.
- `apps/agent/src/server-websocket.ts`, `apps/agent/src/routes/sessions.ts`,
  `apps/agent/src/utils/exec.ts` — reference exemplars only.
- `.audit-suppressions.json` — no suppression edits.
- `apps/agent/src/index.ts` — the default parameter in Step 1 keeps the
  existing call compiling; do not edit it.

## Git workflow

- Work on the **current branch** (do not create a branch).
- Single commit, targeted adds only:
  `git add apps/agent/src/routes/commands-send-text.ts apps/agent/src/routes/commands-send-text.test.ts plans/README.md .beads/ && git commit && git push`
  (include `.beads/` only if the beads hook staged changes there; NEVER `git add .`).
- Message style (match `git log`): `fix(agent): route send-text through safeSpawn + tmux-target guard (plans/020)`

## Steps

### Step 1: Swap raw spawn for safeSpawn in `commands-send-text.ts`

In `apps/agent/src/routes/commands-send-text.ts`:

1. Delete line 23: `import { spawn } from "node:child_process";`
2. Change line 22's import to also pull `safeSpawn`:

```ts
import { createLogger, safeSpawn } from "@nexus/core/node";
import { isValidTmuxTarget } from "../terminal/tmux-pty-source";
```

3. Add an injectable spawn seam next to the existing `_sessionManager`
   module-state (after line 29), and reset it in `resetSendTextRoute`.
   Extend `initSendTextRoute` with a defaulted second parameter so the
   production call site (`index.ts:100`) is untouched:

```ts
// Injectable spawn impl (default: real safeSpawn). Tests pass a recording
// fake — mirrors the SpawnFns injection pattern in terminal/tmux-pty-source.ts.
let _spawn: typeof safeSpawn = safeSpawn;

export function initSendTextRoute(
  sessionManager: SessionManager,
  spawnImpl: typeof safeSpawn = safeSpawn,
): void {
  _sessionManager = sessionManager;
  _spawn = spawnImpl;
}

export function resetSendTextRoute(): void {
  _sessionManager = null;
  _spawn = safeSpawn;
}
```

4. Replace the whole `tmuxSendKeys` function (lines 58–82, including its doc
   comment's first sentence — keep the "Never throws" promise) with:

```ts
/**
 * Run `tmux send-keys -t <target> <text> [Enter]` via safeSpawn and resolve
 * to the tuple { code, stderr }. Never throws.
 */
async function tmuxSendKeys(
  target: string,
  text: string,
  appendNewline: boolean,
): Promise<{ code: number; stderr: string }> {
  const args = ["send-keys", "-t", target, text];
  if (appendNewline) args.push("Enter");
  try {
    // trustArgs: `text` is intended keystrokes and may legitimately contain
    // shell metacharacters (; $ \r ...). Safe because this is an argv-vector
    // spawn (no shell) and `target` — the only other non-literal arg — is
    // validated with isValidTmuxTarget before we get here.
    const handle = _spawn("tmux", args, {
      stdio: ["ignore", "ignore", "pipe"],
      trustArgs: true,
    });
    const stderr =
      handle.stderr instanceof ReadableStream
        ? await new Response(handle.stderr).text()
        : "";
    const code = await handle.exitCode;
    return { code, stderr };
  } catch (err) {
    // Bun.spawn throws synchronously when tmux is missing — preserve the old
    // node 'error'-event behavior: code -1, message in stderr (route → 500).
    return { code: -1, stderr: err instanceof Error ? err.message : String(err) };
  }
}
```

**Verify**: `grep -n 'node:child_process' apps/agent/src/routes/commands-send-text.ts`
→ no output (exit 1).

**Verify**: `cd apps/agent && bun run --silent tsc --noEmit 2>/dev/null; pnpm --filter @nexus/agent typecheck 2>&1 | tail -5`
→ if the workspace has a `typecheck` script it exits 0; otherwise run the root
`pnpm typecheck` at the end of Step 3 and rely on that. (Do NOT use `tsc` to
*execute* anything — typecheck only.)

### Step 2: Add the isValidTmuxTarget guard before the spawn

In `handleSendText`, immediately after the existing empty-target check
(currently lines 110–113), insert the guard so the flow reads:

```ts
  const tmuxTarget = session.tmuxTarget;
  if (!tmuxTarget || tmuxTarget.trim() === "") {
    return jsonError(409, `session has no tmuxTarget: ${sessionId}`);
  }
  if (!isValidTmuxTarget(tmuxTarget)) {
    log.warn({ sessionId, tmuxTarget }, "send-text: rejected invalid tmux target");
    return jsonError(409, `session has invalid tmuxTarget: ${sessionId}`);
  }
```

409 (not 400) because the request body is well-formed — the *session state*
is unusable, matching the sibling `session has no tmuxTarget` 409. The
`log.warn` shape mirrors `server-websocket.ts:181`.

**Verify**: `grep -n 'isValidTmuxTarget' apps/agent/src/routes/commands-send-text.ts`
→ two lines: the import and the guard.

### Step 3: Rewrite the test mock and add the invalid-target test

In `apps/agent/src/routes/commands-send-text.test.ts`:

1. Delete the `mock.module("node:child_process", ...)` block (lines 18–56)
   and the `mock.module("@nexus/core/node", ...)` logger block (lines 58–69),
   plus the now-unused `mock` import if nothing else uses it. Update the file
   header comment (lines 10–14) — the route now spawns via an injected
   `safeSpawn`-shaped fake, and the preload handles the logger.
2. Add a recording fake with the `SafeSpawnHandle` surface `tmuxSendKeys`
   uses (`stderr` may be `undefined` — the route guards with
   `instanceof ReadableStream`):

```ts
import type { safeSpawn } from "@nexus/core/node";

interface SpawnCall {
  binary: string;
  args: ReadonlyArray<string>;
}
const spawnCalls: SpawnCall[] = [];

const fakeSpawn = ((binary: string, args: string[]) => {
  spawnCalls.push({ binary, args: [...args] });
  return {
    pid: 12345,
    stdin: undefined,
    stdout: undefined,
    stderr: undefined, // route treats non-ReadableStream as ""
    exitCode: Promise.resolve(0),
    abort: async () => 0,
    kill: () => {},
  };
}) as unknown as typeof safeSpawn;
```

3. In each existing test, change `initSendTextRoute(sm)` to
   `initSendTextRoute(sm, fakeSpawn)`. Keep the `beforeEach` that clears
   `spawnCalls`. Update the happy-path assertions to the new call shape:

```ts
    expect(spawnCalls.length).toBe(1);
    const call = spawnCalls[0]!;
    expect(call.binary).toBe("tmux");
    expect(call.args).toEqual(["send-keys", "-t", "nexus:cc-1234", "ls\r"]);
```

4. Add the new test (this is the regression gate — it MUST fail if Step 2's
   guard is removed, because the route would then spawn and return 200):

```ts
  test("invalid tmuxTarget (shell-metachar) returns 409 and does NOT spawn", async () => {
    const { initSendTextRoute, handleSendText, resetSendTextRoute } =
      await import("./commands-send-text");

    const sm = makeSessionManagerStub({
      "cc-evil-0000": { id: "cc-evil-0000", tmuxTarget: "bad;target" },
    });
    initSendTextRoute(sm, fakeSpawn);

    const res = await handleSendText(
      makeRequest({ sessionId: "cc-evil-0000", text: "hello" }),
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("invalid tmuxTarget");

    // Critical: NO spawn of any kind
    expect(spawnCalls.length).toBe(0);

    resetSendTextRoute();
  });
```

**Verify**: `cd apps/agent && bun test src/routes/commands-send-text.test.ts`
→ `4 pass, 0 fail`.

### Step 4: Full gates

Run, from the repo root unless noted:

1. `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test src/` → 0 fail.
2. `pnpm typecheck` → exit 0 (baseline caveat in Commands table).
3. `pnpm lint` → exit 0 (same caveat).
4. `grep -rln 'node:child_process' apps/agent/src/routes/` → exactly
   `apps/agent/src/routes/specs/handlers-status.ts`.
5. `git status --short` → only the three in-scope files modified.

Then update `plans/README.md` (add/update the 020 row) and commit per the Git
workflow section.

## Test plan

- File: `apps/agent/src/routes/commands-send-text.test.ts` (rewrite in place).
- Structural pattern to mimic: the file itself (fixtures `makeSessionManagerStub`
  / `makeRequest` stay as-is); for the injection-fake idea, the precedent is
  the `SpawnFns` recording mock described at
  `apps/agent/src/terminal/tmux-pty-source.ts:130-135`.
- Cases after this plan:
  1. valid session + target → 200, fake spawn called once with exact tmux argv (existing, updated assertions)
  2. unknown sessionId → 404, no spawn (existing)
  3. missing `text` → 400, no spawn (existing)
  4. `tmuxTarget: "bad;target"` → 409 containing `invalid tmuxTarget`, no spawn (NEW)
- Verification: `cd apps/agent && bun test src/routes/commands-send-text.test.ts` → 4 pass, 0 fail.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `cd apps/agent && bun test src/routes/commands-send-text.test.ts` → 4 pass, 0 fail
- [ ] `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test src/` → 0 fail
- [ ] `grep -c 'node:child_process' apps/agent/src/routes/commands-send-text.ts` → 0 (grep exits 1)
- [ ] `grep -c 'node:child_process' apps/agent/src/routes/commands-send-text.test.ts` → 0 (grep exits 1)
- [ ] `grep -rln 'node:child_process' apps/agent/src/routes/` → exactly one line: `apps/agent/src/routes/specs/handlers-status.ts`
- [ ] `grep -n 'trustArgs: true' apps/agent/src/routes/commands-send-text.ts` → 1 match, adjacent to a comment justifying it
- [ ] `pnpm typecheck` exits 0 (or, if baseline drifted red: no error output mentions either in-scope file)
- [ ] `pnpm lint` exits 0 (same baseline caveat)
- [ ] `git status --short` shows changes ONLY in the two source files + `plans/README.md` (+ `.beads/` from hooks)
- [ ] `plans/README.md` has a 020 status row

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check shows either in-scope file changed since `c67ff12c` and the
  "Current state" excerpts no longer match.
- `import { safeSpawn } from "@nexus/core/node"` does not resolve (check with
  `grep -n 'safeSpawn' packages/core/src/node.ts packages/core/src/index.ts`
  and how `apps/agent/src/utils/exec.ts:14` imports it). Do not invent a new
  export path.
- The happy-path test fails with `UnsafeArgError` — that means `trustArgs: true`
  was dropped or misplaced; fix once, and if it persists, STOP.
- Any sibling suite in the full `bun test src/` run breaks in a way that
  mentions `safeSpawn` or `@nexus/core/node` mocks — you have leaked a
  process-global mock; revert the test approach to the injection seam and if
  it still fails, STOP.
- Fixing anything appears to require editing `safe-spawn.ts`,
  `tmux-pty-source.ts`, `index.ts`, or `.audit-suppressions.json`.
- `pnpm typecheck`/`pnpm lint` show NEW errors attributable to the in-scope
  files that you cannot resolve within the in-scope files.

## Maintenance notes

- Reviewer scrutiny points: (1) the `trustArgs: true` justification comment
  must mention that `target` is pre-validated and the spawn is argv-vector;
  (2) the guard returns 409 BEFORE any spawn — order matters; (3) response
  shapes for the three existing cases are byte-for-byte unchanged (200/404/400
  bodies), so watchOS clients are unaffected.
- If iOS quick-reply lands on this route (header says "future"), it inherits
  both the guard and safeSpawn for free — no follow-up needed.
- If the tmux target grammar ever changes, `isValidTmuxTarget` in
  `tmux-pty-source.ts` is the single source of truth — do not fork a second
  regex into this route.
- Deferred deliberately: `routes/specs/handlers-status.ts` `spawnSync`
  (settled E5 suppression, subprocess-dominated), and converting this route to
  `utils/exec.ts` `execText` (throws on non-zero exit — would complicate the
  never-throws `{ code, stderr }` contract for zero benefit).
