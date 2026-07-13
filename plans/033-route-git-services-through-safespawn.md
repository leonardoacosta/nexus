# Plan 033: Route 8 new-service spawn sites through safeSpawn

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> ```
> git diff --stat 089e0338..HEAD -- \
>   packages/core/src/safe-spawn.ts \
>   apps/agent/src/services/git-observer.ts \
>   apps/agent/src/services/git-project.ts \
>   apps/agent/src/services/git-project-resolver.ts \
>   apps/agent/src/services/reaper-job.ts \
>   apps/agent/src/services/process-watcher.ts \
>   apps/agent/src/services/tailscale-presence.ts \
>   apps/agent/src/routes/specs/handlers-status.ts \
>   apps/agent/src/utils/exec.ts
> ```
> Expected: empty output (this plan was drift-checked clean against `HEAD` at
> authoring time — see "Planned at" below). If any line appears, the codebase
> has moved since this plan was written — compare the "Current state"
> excerpts below against the live file before proceeding, and treat any
> mismatch as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none (disjoint files from plans 032/034/035/036/037 — see
  § Cross-plan coordination below)
- **Category**: security / tech-debt
- **Planned at**: commit `089e0338`, 2026-07-13

## Why this matters

`packages/core/src/safe-spawn.ts` states its own invariant in its file
docstring: *"Every production call site that spawns a child process MUST go
through this wrapper instead of `Bun.spawn` or `child_process.spawn`
directly."* Six services added since Wave 3 (git-observer, git-project x2,
git-project-resolver, reaper-job, process-watcher) reimplement raw
`Bun.spawn` with hand-rolled `setTimeout`/`kill`/`clearTimeout` timeout
plumbing instead of reusing `safeSpawn`'s allowlist + `AbortSignal` wiring.
Two more sites (handlers-status.ts, tailscale-presence.ts) use
`node:child_process`'s `spawnSync`/`execFile` directly, bypassing the
wrapper entirely.

None of these 8 sites currently take request-supplied input in
cwd/path/args — every one spawns a hardcoded binary/args literal, or an
argv-vector with a locally-sourced cwd (project registry, a live `claude`
PID's cwd, or the request path already validated by `resolveSpecDir`). This
is **not** a live exploitable vulnerability. The cost today is architectural
drift: the allowlist's defense-in-depth is silently absent from 8 sites,
~15 lines of timeout/kill boilerplate are duplicated per site instead of one
call to a shared wrapper, and a future call site can copy-paste one of these
as its "local convention" and inherit the gap. Fixing it now, while there are
8 sites, is cheaper than fixing it after there are 20.

## Current state

The repo already has TWO sanctioned entry points to `safeSpawn` — pick the
right one per site, do not reach for a third pattern:

1. **`safeSpawn(binary, args, opts)`** — `packages/core/src/safe-spawn.ts`
   (import via `@nexus/core/node`). Low-level: validates the binary against
   `ALLOWED_BINARIES`, validates args against a shell-metacharacter regex
   (opt out via `trustArgs: true`), spawns via `Bun.spawn`, and returns a
   handle with `.stdout`/`.stderr`/`.exitCode` (a `Promise<number>`) plus
   `.abort()`/`.kill()`. Passing `{ signal: someAbortSignal }` wires the
   signal so aborting it calls `handle.kill()` for you — this REPLACES the
   hand-rolled `setTimeout(() => proc.kill(), ms)` pattern.
2. **`execText(cmd, args, opts)` / `execJson<T>(cmd, args, opts)`** —
   `apps/agent/src/utils/exec.ts`. A typed convenience layer that itself
   delegates to `safeSpawn` (its own docstring: *"Internally delegates to
   `safeSpawn` so every subprocess in the agent codebase goes through the
   same allowlist + arg validation."*). It captures stdout (+ JSON-parses for
   `execJson`), applies a default 10s timeout via `Promise.race` +
   `handle.abort()`, and **throws** `ExecError` on non-zero exit /
   `ExecTimeoutError` on timeout — callers that currently return `null` on
   failure need a `try { ... } catch { return null; }` wrapper, which most of
   these sites already have.

`apps/agent/src/services/process-watcher.ts` already uses `execText` for its
`pgrep`/`tmux` calls (lines 191, 268, 427) — proving `execText` is the
established convention for this exact "spawn + capture stdout + fail
gracefully" shape. This plan's job is to extend that convention to the
remaining 8 call sites, using `execText`/`execJson` where the shape fits and
falling back to raw `safeSpawn` only where it doesn't (see per-site call
below).

**Verified `git -C 6796f8ab..089e0338` diff is empty for all 9 in-scope
files** — the tree at the time of this read matched the commit this plan is
stamped against exactly.

### `ALLOWED_BINARIES` (packages/core/src/safe-spawn.ts:27-42)

```ts
export const ALLOWED_BINARIES = [
  "tmux", "git", "claude", "ssh", "bash", "sh", "cat", "nexus",
  "openspec", "which", "pgrep", "gh", "bd", "nexus-watcher",
] as const;
```

`"tailscale"` is **not** in this list. `tailscale-presence.ts:170` needs it.
`apps/agent/src/server.ts:65` (`probeTailscaleOnce`, an already-suppressed
sibling site per `.audit-suppressions.json`) also calls the `tailscale`
binary directly but is **out of scope** for this plan — do not touch
`server.ts`.

### Site 1 — `apps/agent/src/services/git-observer.ts:139` (`observeGitState`)

```ts
export async function observeGitState(
  path: string,
  timeoutMs: number = PER_PROJECT_TIMEOUT_MS,
): Promise<GitObservation | null> {
  if (!existsSync(path)) return null;

  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const proc = Bun.spawn(
      ["git", "-C", path, "status", "--porcelain=v2", "--branch"],
      { stdout: "pipe", stderr: "ignore", stdin: "ignore" },
    );
    timer = setTimeout(() => {
      try { proc.kill(); } catch { /* already exited */ }
    }, timeoutMs);
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) return null;
    return parseGitStatusV2(stdout);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
```

Test file `apps/agent/src/services/git-observer.test.ts` has a timeout test
(`spyOn(Bun, "spawn")`) that spies on the GLOBAL `Bun.spawn` — since
`execText` bottoms out in `safeSpawn` which calls the real `Bun.spawn`, this
spy still fires correctly after migration (verified by tracing the call
chain: `execText` → `safeSpawn` → `Bun.spawn`).

### Site 2 & 3 — `apps/agent/src/services/git-project.ts:45,173`

```ts
// line 43-60 (gitRemoteUrl)
async function gitRemoteUrl(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "-C", cwd, "remote", "get-url", "origin"], {
      stdout: "pipe", stderr: "pipe", stdin: "ignore",
    });
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(), proc.exited,
    ]);
    if (exitCode !== 0) return null;
    const out = stdout.trim();
    return out.length > 0 ? out : null;
  } catch { return null; }
}

// line 163-196 (spawnGitMetadata)
async function spawnGitMetadata(cwd: string): Promise<string | null> {
  const cmd = [
    "git -C \"$0\" status --porcelain=v2 --branch --untracked-files=no",
    "git -C \"$0\" log -1 --format=%aN%n%aI",
  ].join(" && ");
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const proc = Bun.spawn(["/bin/sh", "-c", cmd, cwd], {
      stdout: "pipe", stderr: "pipe", stdin: "ignore",
    });
    timer = setTimeout(() => {
      try { proc.kill(); } catch { /* already exited */ }
    }, GIT_METADATA_TIMEOUT_MS);
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(), proc.exited,
    ]);
    if (exitCode !== 0) return null;
    return stdout;
  } catch { return null; } finally { if (timer) clearTimeout(timer); }
}
```

`spawnGitMetadata`'s command string contains `&&` — `safeSpawn`'s
`SHELL_META` regex (`/[;&|$\`\n\r]/`) rejects `&` by default, so this site
MUST pass `trustArgs: true`. This is the literal case `safe-spawn.ts`'s own
docstring names ("Opting out requires an explicit `trustArgs: true` flag").
The `cwd` value travels as the `$0` positional argument to `sh -c`, never
string-interpolated into the command text itself — so `trustArgs` here opts
out of the *metacharacter* check on the fixed command string, not on
attacker-controlled input.

### Site 4 — `apps/agent/src/services/git-project-resolver.ts:186` (`execGitRemoteUrl`)

```ts
export async function execGitRemoteUrl(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "-C", cwd, "remote", "get-url", "origin"], {
      stdout: "pipe", stderr: "pipe", stdin: "ignore",
    });
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(), proc.exited,
    ]);
    if (exitCode !== 0) return null;
    const out = stdout.trim();
    return out.length > 0 ? out : null;
  } catch (err) {
    log.debug({ err: err instanceof Error ? err.message : String(err), cwd },
      "git remote get-url spawn failed");
    return null;
  }
}
```

### Site 5 — `apps/agent/src/services/reaper-job.ts:224` (`runReaper`)

```ts
const proc = Bun.spawn([bashBin, ...args], {
  stdout: "pipe",
  stderr: "pipe",
  env: { ...process.env, NEXUS_REAPER_NO_REDIRECT: "1" },
});

let timedOut = false;
const timeoutHandle = setTimeout(() => {
  timedOut = true;
  try { proc.kill(); } catch { /* best-effort */ }
}, timeoutMs);

let stdout = "";
let stderr = "";
try {
  [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
} finally {
  clearTimeout(timeoutHandle);
}

const exitCode = await proc.exited;
```

`runReaper` needs BOTH raw stdout and stderr regardless of exit code (its own
`parseReaperOutput` derives success/failure/aborted from the `NEXUS_RESULT`
sentinel line, not from the exit code alone) plus a custom env override and a
tee-to-logfile step later in the function. This does **not** fit
`execText`'s throw-on-nonzero/stdout-only contract — use raw `safeSpawn`
here, not `execText`.

**IMPORTANT — do not double-spread `process.env`**: `safeSpawn`'s own
implementation (`packages/core/src/safe-spawn.ts:199`) already does
`env: opts.env ? { ...process.env, ...opts.env } : undefined` internally.
Passing `env: { NEXUS_REAPER_NO_REDIRECT: "1" }` (NOT
`{ ...process.env, NEXUS_REAPER_NO_REDIRECT: "1" }`) produces the identical
merged environment the original code built by hand — `safeSpawn` does the
spread for you.

### Site 6 — `apps/agent/src/services/process-watcher.ts:123` (`resolveBranch`)

```ts
async function resolveBranch(cwd: string | null | undefined): Promise<string | null> {
  if (!cwd) return null;
  const now = Date.now();
  const cached = branchCache.get(cwd);
  if (cached && cached.expiresAt > now) return cached.value;

  let value: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const proc = Bun.spawn(
      ["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"],
      { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
    );
    timer = setTimeout(() => {
      try { proc.kill(); } catch { /* already exited */ }
    }, BRANCH_RESOLVE_TIMEOUT_MS);
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(), proc.exited,
    ]);
    if (exitCode === 0) {
      const out = stdout.trim();
      value = out.length > 0 && out !== "HEAD" ? out : null;
    }
  } catch (err) {
    log.debug({ err, cwd }, "process-watcher: branch resolution failed (non-git or git missing) — null");
    value = null;
  } finally {
    if (timer) clearTimeout(timer);
  }
  branchCache.set(cwd, { value, expiresAt: now + BRANCH_CACHE_TTL_MS });
  return value;
}
```

**Do NOT route this one through `execText`.** `process-watcher.ts` already
imports `execText` from `../utils/exec` for its `pgrep`/`tmux` calls (lines
191, 268, 427 — both call sites already correctly use `execText`, one with
`trustArgs: true` for the `tmux` format-string args). `resolveBranch`'s own
test file, `apps/agent/src/services/process-watcher-branch.test.ts`, states
this explicitly in its header docstring: *"Strategy: `resolveBranch` shells
out via `Bun.spawn` directly (not the mocked `execText`)"*. The reason:
`apps/agent/src/services/process-watcher.test.ts` (the reconciliation-pass
suite) installs a restorable spy on the `../utils/exec` module's
`execText`/`execJson` exports via `installExecMock` (`spyOn(execNs,
"execText")` in `apps/agent/src/testing/mock-exec.ts`), with a hard-coded
allowlist of exactly three invocation shapes (`pgrep -af claude`, `pgrep -P
<pid>`, `tmux list-panes -a`) — any other `execText` call throws
`"unexpected execText call in test: ..."`. Because `spyOn` patches the
shared module namespace object, migrating `resolveBranch` to call
`execText` would make its `git rev-parse` calls route through that same
patched export and hit the "unexpected call" throw the moment a
DB-integration test creates a new session row with a non-empty `cwd` (that
code path calls `resolveBranch(cwd)` — see `process-watcher.ts` line 776).
Use raw `safeSpawn` here instead, with `{ signal }`-based abort replacing
the `setTimeout`/`kill` pair, exactly as sites 1-4 do via `execText`'s
internal implementation — just called directly instead of through the
`execText` convenience layer.

### Site 7 — `apps/agent/src/routes/specs/handlers-status.ts:52` (`resolveApprover`)

```ts
function resolveApprover(): string {
  try {
    const r = spawnSync("git", ["config", "user.email"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (r.status === 0 && r.stdout) {
      const email = r.stdout.trim();
      if (email) return email;
    }
  } catch { /* fall through to $USER */ }
  return process.env.USER || "unknown";
}
```

Called once, at line 230: `const actor = resolveApprover();` (inside
`handlePatchSpecStatus`, which is already `async`). `safeSpawn` has no
synchronous variant — `packages/core/src/safe-spawn.ts` wraps `Bun.spawn`
only (confirmed: no `spawnSync`/sync wrapper exists anywhere under
`packages/core/src/`). This site MUST become `async` and its one call site
MUST add `await`. This is a small, deliberate signature change — call it out
explicitly in your diff/commit message (per the bundle's instruction: don't
fold it in silently).

### Site 8 — `apps/agent/src/services/tailscale-presence.ts:170` (`defaultFetchStatus`)

```ts
async function defaultFetchStatus(): Promise<TailscaleStatus | null> {
  try {
    const { stdout } = await execFileAsync("tailscale", ["status", "--json"], {
      timeout: STATUS_TIMEOUT_MS,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    return JSON.parse(stdout) as TailscaleStatus;
  } catch (err) {
    log.warn({ error: err instanceof Error ? err.message : String(err) },
      "tailscale status --json failed — will retry next tick");
    return null;
  }
}
```

This is a perfect fit for `execJson<T>` (spawn + capture + JSON.parse in one
call). Requires the `ALLOWED_BINARIES` addition from the top of this
section — do that first (Step 1).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| API typecheck (gate) | `pnpm --filter @nexus/agent typecheck` | exit 0, no errors |
| Core typecheck (modified package) | `pnpm --filter @nexus/core typecheck` | exit 0, no errors |
| E2E gate | `bun test` (from repo root) | exit 0, all pass |
| Targeted tests | `bun test <file...>` | all pass, `0 fail` |

(All four verified runnable in this repo during recon; the `db`/`ui` gates
from `.claude/project.toml` — `pnpm --filter @nexus/db typecheck` /
`pnpm --filter @nexus/statusline typecheck` — are irrelevant to this plan;
no `packages/db` or `apps/nexus-statusline` file is touched.)

## Scope

**In scope** (the only files you should modify):
- `packages/core/src/safe-spawn.ts` (Step 1 only — one array entry + comment)
- `apps/agent/src/services/git-observer.ts`
- `apps/agent/src/services/git-project.ts`
- `apps/agent/src/services/git-project-resolver.ts`
- `apps/agent/src/services/reaper-job.ts`
- `apps/agent/src/services/process-watcher.ts`
- `apps/agent/src/services/tailscale-presence.ts`
- `apps/agent/src/routes/specs/handlers-status.ts`

**Out of scope** (do NOT touch, even though they look related):
- `apps/agent/src/terminal/tmux-pty-source.ts` — this is D4-01 / **plan 032**
  (higher blast radius: 11 call sites, a user-facing keystroke path, and
  `mkfifo` is not yet in `ALLOWED_BINARIES`). No file overlap with this
  plan, so ordering relative to 032 doesn't matter for merge purposes, but
  032 is the higher-priority fix — do it first or in parallel, never skip it
  in favor of this one.
- `apps/agent/src/server.ts:65` (`probeTailscaleOnce`) — the
  already-`.audit-suppressions.json`-suppressed sibling `tailscale` call
  site. Adding `"tailscale"` to `ALLOWED_BINARIES` in Step 1 does NOT
  obligate you to migrate this site too; leave it as-is.
- `apps/agent/src/utils/exec.ts` itself — already correct, used as-is.
- Any file under `apps/agent/src/testing/` (`mock-exec.ts` etc.) — read for
  understanding, never edited by this plan.
- `.audit-suppressions.json` — no entry in it corresponds to any of these 8
  sites; do not add or remove suppression rows.

## Git workflow

- No branch creation (per repo convention — ad-hoc lane commits directly to
  the current branch).
- One commit for this whole plan is acceptable given the mechanical,
  same-shape nature of all 8 sites; commit message style: conventional
  commits, e.g. `fix(security): route git/reaper/tailscale spawns through safeSpawn`.
- Do NOT push — this repo's session-close protocol pushes once at the end of
  the whole session, not per-plan.

## Steps

### Step 1: Add `"tailscale"` to `ALLOWED_BINARIES`

In `packages/core/src/safe-spawn.ts`, add a `"tailscale"` entry to the
`ALLOWED_BINARIES` array (currently lines 27-42) with its own comment, e.g.:

```ts
export const ALLOWED_BINARIES = [
  "tmux", // tmux harness management — the product
  "git", // project discovery, branch detection
  "claude", // Claude Code CLI hook relay
  "ssh", // terminal attach via remote shells
  "bash", // PTY shell for interactive sessions
  "sh", // POSIX shell fallback
  "cat", // session log tailing
  "nexus", // self-invocation (CLI tests, register)
  "openspec", // spec list/show for spec-watcher + specs route
  "which", // binary discovery for environment route + tmux availability check
  "pgrep", // process-watcher reconciliation — discover live `claude` PIDs
  "gh", // GitHub CLI auth status for environment route
  "bd", // beads issue tracker queries for recommend + project-detail
  "nexus-watcher", // sibling Bun-compiled binary — file system event watcher relayed by watcher-bridge
  "tailscale", // presence poller (tailscale-presence.ts) — `tailscale status --json`
] as const;
```

This is its own reviewed line, called out explicitly — do not fold it
silently into a later step's diff.

**Verify**: `pnpm --filter @nexus/core typecheck` → exit 0. Then
`bun test packages/core/src/safe-spawn.test.ts` → `5 pass, 0 fail` (baseline
measured during recon: this file currently passes with 5 tests before your
change; it should still pass unchanged after — the new array entry doesn't
alter any existing assertion).

### Step 2: Migrate `git-observer.ts` (`observeGitState`) to `execText`

Add `import { execText } from "../utils/exec";` to the top import block
(alongside the existing `createLogger`/`@nexus/db` imports at lines 31-35).

Replace the body of `observeGitState` (lines 131-161) with:

```ts
export async function observeGitState(
  path: string,
  timeoutMs: number = PER_PROJECT_TIMEOUT_MS,
): Promise<GitObservation | null> {
  if (!existsSync(path)) return null;

  try {
    const stdout = await execText(
      "git",
      ["-C", path, "status", "--porcelain=v2", "--branch"],
      { timeout: timeoutMs },
    );
    return parseGitStatusV2(stdout);
  } catch {
    return null;
  }
}
```

This drops the manual `timer`/`setTimeout`/`kill`/`clearTimeout` block
entirely — `execText`'s internal `Promise.race` + `handle.abort()` replaces
it. Non-zero exit and timeout both throw inside `execText`; the outer
`catch { return null; }` preserves the original fail-open contract exactly.

**Verify**: `bun test apps/agent/src/services/git-observer.test.ts` →
`7 pass, 0 fail` (measured baseline before this change: 7 pass, 0 fail —
same count expected after, since behavior is preserved).

### Step 3: Migrate `git-project.ts` (`gitRemoteUrl` + `spawnGitMetadata`) to `execText`

Add `import { execText } from "../utils/exec";` near the top (after the
existing `createLogger` import at line 27).

Replace `gitRemoteUrl` (lines 43-60):

```ts
async function gitRemoteUrl(cwd: string): Promise<string | null> {
  try {
    const out = await execText("git", ["-C", cwd, "remote", "get-url", "origin"]);
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}
```

Replace `spawnGitMetadata` (lines 163-196) — keep the `cmd` construction
(lines 166-169) unchanged, replace only the spawn/timeout block:

```ts
async function spawnGitMetadata(cwd: string): Promise<string | null> {
  const cmd = [
    "git -C \"$0\" status --porcelain=v2 --branch --untracked-files=no",
    "git -C \"$0\" log -1 --format=%aN%n%aI",
  ].join(" && ");

  try {
    return await execText("/bin/sh", ["-c", cmd, cwd], {
      timeout: GIT_METADATA_TIMEOUT_MS,
      trustArgs: true,
    });
  } catch {
    return null;
  }
}
```

`trustArgs: true` is required here — the joined `cmd` string contains `&&`,
which `safeSpawn`'s metacharacter guard rejects by default. Note: unlike the
original, `gitRemoteUrl` previously had NO timeout at all (a hung `git`
process would hang forever); `execText`'s default 10s timeout now bounds it.
This is a safety improvement, not a behavior regression — do not "fix" it
away by passing an explicit very-long timeout.

**Verify**: `bun test apps/agent/src/services/git-project.test.ts` →
`59 pass, 0 fail` combined with the other 4 files in the same baseline run —
run this file alone and confirm `0 fail`.

### Step 4: Migrate `git-project-resolver.ts` (`execGitRemoteUrl`) to `execText`

Add `import { execText } from "../utils/exec";` near the top (after the
existing `createLogger` import at line 30).

Replace `execGitRemoteUrl` (lines 184-206):

```ts
export async function execGitRemoteUrl(cwd: string): Promise<string | null> {
  try {
    const out = await execText("git", ["-C", cwd, "remote", "get-url", "origin"]);
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch (err) {
    log.debug(
      { err: err instanceof Error ? err.message : String(err), cwd },
      "git remote get-url spawn failed",
    );
    return null;
  }
}
```

**Verify**: `bun test apps/agent/src/services/git-project-resolver.test.ts`
→ `0 fail`.

### Step 5: Migrate `reaper-job.ts` (`runReaper`) to raw `safeSpawn`

Change the import at line 30 from `import { createLogger } from
"@nexus/core/node";` to `import { createLogger, safeSpawn } from
"@nexus/core/node";`.

Replace the spawn + timeout block inside `runReaper` (lines 224-257):

```ts
  const ac = new AbortController();
  const proc = safeSpawn(bashBin, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { NEXUS_REAPER_NO_REDIRECT: "1" },
    signal: ac.signal,
  });

  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, timeoutMs);

  let stdout = "";
  let stderr = "";
  try {
    [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
  } finally {
    clearTimeout(timeoutHandle);
  }

  const exitCode = await proc.exitCode;
```

Do NOT write `env: { ...process.env, NEXUS_REAPER_NO_REDIRECT: "1" }` —
`safeSpawn` already merges `opts.env` over `process.env` internally (see
`packages/core/src/safe-spawn.ts:199`); pre-spreading here would be
redundant, not wrong, but adds noise a reader has to untangle. Everything
below this block (`log.info(...)`, the tee-to-logfile block, `parsed =
parseReaperOutput(stdout)`, the `status` resolution) is unchanged — it
already reads `stdout`/`stderr`/`exitCode`/`timedOut` as local variables,
which this replacement still produces with the same names and types.

**Verify**: `bun test apps/agent/src/services/reaper-job.test.ts
apps/agent/src/services/reaper-job.e2e.test.ts` → `0 fail`.

### Step 6: Migrate `process-watcher.ts` (`resolveBranch`) to raw `safeSpawn`

Add `import { safeSpawn } from "@nexus/core/node";` near the top (this file
already imports `createLogger` from the same package at line 51 — add
`safeSpawn` to a NEW import line, do not touch the existing `execText`
import at line 52, which is used by `listClaudeProcesses`/`listTmuxPanes`
and must keep working exactly as-is).

Replace the body of `resolveBranch` (lines 109-156), specifically the
spawn/timeout block (lines 122-152):

```ts
  let value: string | null = null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), BRANCH_RESOLVE_TIMEOUT_MS);
  try {
    const proc = safeSpawn(
      "git",
      ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"],
      { stdio: ["ignore", "pipe", "pipe"], signal: ac.signal },
    );
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exitCode,
    ]);
    if (exitCode === 0) {
      const out = stdout.trim();
      value = out.length > 0 && out !== "HEAD" ? out : null;
    }
  } catch (err) {
    log.debug(
      { err, cwd },
      "process-watcher: branch resolution failed (non-git or git missing) — null",
    );
    value = null;
  } finally {
    clearTimeout(timer);
  }
```

The surrounding cache-check (lines 114-118) and the final
`branchCache.set(...)` + `return value;` (lines 154-155) are unchanged.

**Do not** import or call `execText` in this function — see the "Site 6"
rationale above (the `installExecMock` spy in `process-watcher.test.ts`
throws on any unrecognized `execText` invocation shape, and adding a
`git rev-parse` branch to that mock's allowlist is out of scope for this
plan).

**Verify**: `bun test apps/agent/src/services/process-watcher-branch.test.ts`
→ `0 fail` (this file unit-tests `resolveBranch` directly against real repos
— no mocking, so it directly exercises your new `safeSpawn` call). Then run
`bun test apps/agent/src/services/process-watcher.test.ts` → `0 fail` (this
suite's DB-gated reconciliation tests skip without `POSTGRES_URL` set — if
your environment has no test Postgres, expect the same `53 pass / 29 skip /
0 fail` shape measured during recon; if you DO have `POSTGRES_URL` set,
those previously-skipped tests will now run for the first time against your
change and MUST also show `0 fail` — treat any failure there as a STOP
condition, not something to patch around by editing the test's mock).

### Step 7: Migrate `handlers-status.ts` (`resolveApprover`) to async `safeSpawn`

Remove the line `import { spawnSync } from "node:child_process";` (line 30).
Change the import at line 31 from `import { createLogger } from
"@nexus/core/node";` to `import { createLogger, safeSpawn } from
"@nexus/core/node";`.

Replace `resolveApprover` (lines 50-64):

```ts
async function resolveApprover(): Promise<string> {
  try {
    const proc = safeSpawn("git", ["config", "user.email"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exitCode,
    ]);
    if (exitCode === 0 && stdout) {
      const email = stdout.trim();
      if (email) return email;
    }
  } catch {
    /* fall through to $USER */
  }
  return process.env.USER || "unknown";
}
```

Update the one call site at (originally) line 230, inside
`handlePatchSpecStatus`, from `const actor = resolveApprover();` to
`const actor = await resolveApprover();`. Call out this signature change
(sync → async) explicitly in your commit message — it is a deliberate,
reviewed part of this migration, not an incidental drive-by.

**Verify**: `bun test apps/agent/src/routes/specs/handlers-status.test.ts` →
`0 fail`. Confirm specifically the two tests asserting
`expect(body).toMatch(/approved-by: /)` / `.not.toMatch(/approved-by:/)`
still pass — they exercise this exact function end-to-end via the route
handler.

### Step 8: Migrate `tailscale-presence.ts` (`defaultFetchStatus`) to `execJson`

Remove `import { execFile } from "node:child_process";`, `import {
promisify } from "node:util";` (lines 32-33), and the line `const
execFileAsync = promisify(execFile);` (line 37). Add `import { execJson }
from "../utils/exec";` in their place.

Replace `defaultFetchStatus` (lines 168-183):

```ts
async function defaultFetchStatus(): Promise<TailscaleStatus | null> {
  try {
    return await execJson<TailscaleStatus>("tailscale", ["status", "--json"], {
      timeout: STATUS_TIMEOUT_MS,
    });
  } catch (err) {
    log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "tailscale status --json failed — will retry next tick",
    );
    return null;
  }
}
```

This step depends on Step 1 (`"tailscale"` in `ALLOWED_BINARIES`) — if you
skipped Step 1, this call throws `DisallowedBinaryError` at runtime and
every poller tick logs a warning instead of ever succeeding. Confirm Step 1
landed before verifying this step.

**Verify**: `bun test apps/agent/src/services/tailscale-presence.test.ts` →
`0 fail` (this suite only tests the pure `classifyPhonePeer` function today
— no existing test exercises `defaultFetchStatus` directly, so this file's
pass count is a regression check, not new coverage of the migrated code
path; Step 9 below adds that coverage).

## Test plan

- **New test**: add one test to
  `apps/agent/src/services/tailscale-presence.test.ts` (or a new adjacent
  `tailscale-presence.integration.test.ts` if you prefer isolating a
  real-subprocess test from the existing pure-classifier file) that starts
  `startTailscalePresencePoller({ intervalMs: <large>, fetchStatus:
  undefined })`... **actually simpler**: directly unit-test that
  `ALLOWED_BINARIES` now contains `"tailscale"` and that a `safeSpawn`
  call with that binary doesn't throw `DisallowedBinaryError`. Model this
  after the existing pattern in `packages/core/src/safe-spawn.test.ts`
  (`test("allows a binary in ALLOWED_BINARIES (git --version)", ...)` at
  line 16) — add a sibling test:

  ```ts
  test("allows 'tailscale' (added for tailscale-presence.ts)", () => {
    expect(() => assertAllowedBinary("tailscale")).not.toThrow();
  });
  ```

  in `packages/core/src/safe-spawn.test.ts`, near the existing allowlist
  tests (after line ~21). This is the one net-new assertion this plan
  requires — everything else is a behavior-preserving refactor covered by
  existing tests.
- Do NOT add a live-network test that actually shells the real `tailscale`
  binary — `defaultFetchStatus`'s only untested path stays untested by
  design (no test currently exercises it; adding one that depends on a real
  Tailscale daemon being present would make CI flaky on machines without
  Tailscale installed).
- **Verification**: `bun test packages/core/src/safe-spawn.test.ts` → the
  existing 5 tests plus your 1 new test all pass (`6 pass, 0 fail`).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm --filter @nexus/agent typecheck` exits 0
- [ ] `pnpm --filter @nexus/core typecheck` exits 0
- [ ] `bun test packages/core/src/safe-spawn.test.ts` → `6 pass, 0 fail` (5
      pre-existing + 1 new `"tailscale"` allowlist test)
- [ ] `bun test apps/agent/src/services/git-observer.test.ts` → `7 pass, 0 fail`
- [ ] `bun test apps/agent/src/services/git-project.test.ts` → `0 fail`
- [ ] `bun test apps/agent/src/services/git-project-resolver.test.ts` → `0 fail`
- [ ] `bun test apps/agent/src/services/reaper-job.test.ts apps/agent/src/services/reaper-job.e2e.test.ts` → `0 fail`
- [ ] `bun test apps/agent/src/services/process-watcher-branch.test.ts` → `0 fail`
- [ ] `bun test apps/agent/src/services/process-watcher.test.ts` → `0 fail`
      (skips allowed for DB-gated tests when `POSTGRES_URL` is unset)
- [ ] `bun test apps/agent/src/routes/specs/handlers-status.test.ts` → `0 fail`
- [ ] `bun test apps/agent/src/services/tailscale-presence.test.ts` → `0 fail`
- [ ] `grep -rn "Bun\.spawn\|spawnSync\|execFile" apps/agent/src/services/git-observer.ts apps/agent/src/services/git-project.ts apps/agent/src/services/git-project-resolver.ts apps/agent/src/services/reaper-job.ts apps/agent/src/routes/specs/handlers-status.ts apps/agent/src/services/tailscale-presence.ts` → no matches (raw spawn primitives fully removed from these 6 files)
- [ ] `grep -n "Bun.spawn" apps/agent/src/services/process-watcher.ts` → no matches EXCEPT inside `process-watcher-branch.test.ts`'s own test-helper `repoRoot()` (that's a test file, not in this grep's scope, and is explicitly allowed to keep using raw `Bun.spawn` for its own setup)
- [ ] `grep -n '"tailscale"' packages/core/src/safe-spawn.ts` → one match, inside `ALLOWED_BINARIES`
- [ ] No files outside the 8 in-scope files (`git status`) are modified,
      other than `packages/core/src/safe-spawn.test.ts` (the one new test)
- [ ] `plans/README.md` status row for plan 033 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at any of the 8 sites doesn't match the "Current state" excerpts
  above (the codebase drifted since `089e0338`).
- Any verification test fails twice after a reasonable fix attempt.
- You discover a 9th call site not listed here that also bypasses
  `safeSpawn` inside one of the 8 in-scope FILES (as opposed to the file's
  already-known site) — note it, but do not silently fix it; it's outside
  this plan's reviewed scope.
- You discover any of these 8 sites DOES take request-supplied input into
  `cwd`/`path`/args that isn't already validated upstream (the bundle's own
  analysis says none currently do — if implementation reveals otherwise,
  this is a live security finding, not a routine consistency fix; stop and
  flag it rather than quietly patching it as part of this mechanical swap).
- `pnpm --filter @nexus/agent typecheck` reports errors outside the 8
  modified files (would indicate an unrelated pre-existing type error, not
  something this plan should fix as a drive-by).
- `POSTGRES_URL` is set in your environment and
  `apps/agent/src/services/process-watcher.test.ts`'s previously-skipped
  DB-integration tests FAIL after Step 6 — this would falsify the "no
  `execText` collision" analysis above and needs a fresh look, not a patch
  to the test's mock.

## Maintenance notes

- **For whoever adds a 9th git/subprocess call site later**: prefer
  `execText`/`execJson` (`apps/agent/src/utils/exec.ts`) over raw
  `safeSpawn` whenever the shape is "spawn, capture stdout, fail null/throw
  on non-zero" — it's less code per site and is now the dominant convention
  in `apps/agent/src/services/`. Reach for raw `safeSpawn` only when you need
  streaming access to both stdout AND stderr independent of exit code (like
  `reaper-job.ts`), a synchronous-looking call site that must become async
  anyway (like `handlers-status.ts`), or when a test file's mock isolation
  specifically requires bypassing `execText` (like `process-watcher.ts`'s
  `resolveBranch` — read that file's "Site 6" note above before assuming
  `execText` is always safe to add to a `services/` file that already uses
  it for something else).
- **`server.ts:65`'s `tailscale` suppression**: once `"tailscale"` is in
  `ALLOWED_BINARIES` (Step 1), the audit-suppression reason text for that
  site ("Trusted execs: ... agent-registry runs `tailscale ip -4` with no
  interpolation") is still accurate as a suppression rationale, but the
  underlying migration (routing `server.ts:65` through `safeSpawn` too) is a
  natural, low-effort follow-up now that the allowlist entry exists. It is
  explicitly NOT part of this plan — file a separate small bead if someone
  wants to pick it up.
- **`git-project.ts` gains an implicit 10s timeout** on `gitRemoteUrl` where
  none existed before (via `execText`'s default). If a future caller needs a
  different budget, pass `{ timeout: <ms> }` explicitly rather than assuming
  the old "no timeout" behavior — it's gone by design now.
- A reviewer should scrutinize: the `trustArgs: true` calls (Step 3's
  `spawnGitMetadata`, Step 6/7 do NOT need it) — confirm the untrusted
  content is always the fixed command-string constant, never `cwd` itself
  (it isn't — `cwd` travels as a separate positional arg, `$0`, not
  interpolated into the command string).
