# Plan 025: Statusline spawn hygiene — eliminate shell-string interpolation (5 sites), fix suppression drift + typo'd allowlist

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index. When you mark the ledger row DONE/BLOCKED/REJECTED you
> MUST append `spec-impact: <slug>[, ...]` or `spec-impact: none`.
>
> **Drift check (run first)**:
> ```bash
> git -C /home/nyaptor/dev/personal/nexus diff --stat b7096486..HEAD -- \
>   apps/nexus-statusline/src/index.ts \
>   apps/nexus-statusline/src/index.test.ts \
>   .audit-suppressions.json \
>   packages/core/src/audit-suppressions.integration.test.ts
> ```
> Expected at authoring time: empty output (main had advanced past `b7096486`
> to `d458ef8e`, but none of the four in-scope files had changed). If any
> in-scope file now shows a diff, compare the "Current state" excerpts below
> against the live code before proceeding; on a mismatch, treat it as a STOP
> condition. Leo works directly in this checkout — expect main to advance
> mid-execution.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW (all five spawn sites are fail-soft — every caller is wrapped in try/catch returning null; worst regression is a missing statusline segment)
- **Depends on**: none. **Ordering constraint**: this plan and plan 026 edit the SAME file (`apps/nexus-statusline/src/index.ts`) and must run sequentially (025 then 026), and BOTH must land BEFORE plan 031 (which splits that file and would move every line this plan cites).
- **Category**: security / tech-debt
- **Planned at**: commit `b7096486`, 2026-07-11

## Why this matters

`apps/nexus-statusline/src/index.ts` contains five child-process invocations
that assemble shell command strings via template-literal interpolation. The
interpolated values (`dir`, `cachePath`, `url`) all derive from the Claude
Code stdin payload's `workspace.project_dir` (or `CLAUDE_PROJECT_DIR` / cwd)
through `deriveProjectCode()`, which performs zero sanitization — a directory
path segment containing `"` or `$(...)` executes in the shell. Exploitability
is self-injection-only (the attacker must control the local repo path), which
is why this is P2 not P0, but the repo's mandated convention (all spawns via
`safeSpawn` in `packages/core/src/safe-spawn.ts`, or at minimum no
shell-string assembly) is systematically bypassed in this app, and the
pattern is actively reproducing: `readCachedAgentJson` (line 1022) is a
NEW-since-baseline copy of the older `getRoadmapPulse` template. Meanwhile
the blanket D4 audit suppression for this app carries a reason ("constant-arg
git probes with no user input") that is no longer true, so new shell-string
spawn shapes in this file ship invisible to the D4 gate — and a typo'd path
in the D4 allowlist test (`nexus-statuslineline`) would silently fail to
cover the real file the moment the suppression narrows. This plan converts
all five sites to interpolation-free spawning, then makes the suppression and
the allowlist truthful again.

## Current state

Repo facts the executor needs (this is a pnpm + Bun monorepo, NOT standard
T3 — no tRPC):

- `apps/nexus-statusline` is a standalone CC statusline extension compiled
  via `bun build --compile`. Its `package.json` declares **no dependencies**
  (devDependencies only: `@types/bun`, `typescript`) — `@nexus/core`'s
  `safeSpawn` is structurally unreachable without adding a workspace dep.
- Exports from `src/index.ts` exist solely for `src/index.test.ts`
  (bun:test, colocated, currently **113 passing tests**).
- Quality gates: `pnpm typecheck`, `pnpm lint`, `bun test` (root discovers
  all `*.test.ts`), `scripts/lint-sql-safety.sh`. CI
  (`.github/workflows/ci.yml`) is RED on main since 2026-07-10 solely due to
  a lint-sql-safety false positive that plan 023 fixes — until 023 lands, the
  bar for this plan is "no new failures attributable to changed files".

### The five interpolation sites (fresh read at b7096486)

`apps/nexus-statusline/src/index.ts:59-60` — imports:

```ts
import { execSync } from "node:child_process";
import * as childProcess from "node:child_process";
```

Sites 1–3, `getGitStatus` (`apps/nexus-statusline/src/index.ts:354-385`,
NOT currently exported):

```ts
function getGitStatus(dir: string): GitInfo | null {
  try {
    const branch = execSync(`git -C "${dir}" branch --show-current`, {   // :356
      encoding: "utf-8",
      timeout: 500,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (!branch) return null;

    const porcelain = execSync(`git -C "${dir}" status --porcelain`, {   // :363
      encoding: "utf-8",
      timeout: 500,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const dirty = porcelain.trim().length > 0;

    let ahead = 0;
    try {
      const revOut = execSync(
        `git -C "${dir}" rev-list --count @{upstream}..HEAD`,            // :372-373
        { encoding: "utf-8", timeout: 500, stdio: ["pipe", "pipe", "pipe"] },
      );
      ahead = parseInt(revOut.trim(), 10) || 0;
    } catch {
      // No upstream
    }

    return { branch, dirty, ahead };
  } catch {
    return null;
  }
}
```

Site 4, `getRoadmapPulse` (`apps/nexus-statusline/src/index.ts:885-898`):

```ts
    if (stale) {
      const child = childProcess.spawn(
        "sh",
        ["-c", `"${PULSE_BIN}" --line > "${cachePath}.tmp" 2>/dev/null && mv "${cachePath}.tmp" "${cachePath}"`],
        {
          cwd: projectDir,
          detached: true,
          stdio: "ignore",
          // Producer-side radar gate: cc's roadmap-pulse skips radar rungs when 0
          env: { ...process.env, PULSE_RADAR: isBb ? "1" : "0" },
        },
      );
      child.unref();
    }
```

(`PULSE_BIN` is a constant at :855 — `join(homedir(), ".claude/scripts/bin/roadmap-pulse")`.
`cachePath` at :871-874 embeds `projectCode` from `deriveProjectCode(projectDir)`.)

Site 5, `readCachedAgentJson` (`apps/nexus-statusline/src/index.ts:1011-1034`):

```ts
function readCachedAgentJson<T>(cachePath: string, url: string): T | null {
  let data: T | null = null;
  let stale = true;
  try {
    stale = Date.now() - statSync(cachePath).mtimeMs > BEAD_LINE_CACHE_TTL_MS;
    data = JSON.parse(readFileSync(cachePath, "utf-8")) as T;
  } catch {
    // No cache yet / unparseable — treat as stale, return null.
  }

  if (stale) {
    const child = childProcess.spawn(
      "sh",
      [
        "-c",
        `curl -sf --max-time 3 "${url}" > "${cachePath}.tmp" 2>/dev/null && mv "${cachePath}.tmp" "${cachePath}"`,
      ],
      { detached: true, stdio: "ignore" },
    );
    child.unref();
  }

  return data;
}
```

Callers of `readCachedAgentJson` (all interpolate `deriveProjectCode` output
into `cachePath`, and `getRoadmapLine` additionally into the `url`):
`getSpecsLine` :1040-1052, `getRoadmapLine` :1059-1074 (url:
`` `${agentUrl}/roadmap?project=${code}` `` at :1068), `getDriftLine`
:1166-1181.

### The taint chain

`deriveProjectCode` (`apps/nexus-statusline/src/index.ts:174-183`) — raw
substring slicing, no sanitization:

```ts
function deriveProjectCode(dir: string): string {
  if (dir.includes("/.claude") || dir.endsWith("/.claude")) return "cc";
  const devIdx = dir.indexOf("/dev/");
  if (devIdx !== -1) {
    const rest = dir.slice(devIdx + 5);
    const end = rest.indexOf("/");
    return end !== -1 ? rest.slice(0, end) : rest;
  }
  return basename(dir) || "?";
}
```

`projectDir` origin (`apps/nexus-statusline/src/index.ts:1556-1560`) — the
CC stdin payload:

```ts
  // Project dir resolution: CC workspace.project_dir → CLAUDE_PROJECT_DIR → cwd
  const projectDir =
    ccInput.workspace?.project_dir ??
    process.env.CLAUDE_PROJECT_DIR ??
    process.cwd();
```

### The suppression drift

`.audit-suppressions.json:61-69` (D4 stanza):

```json
    {
      "id": "D4",
      "paths": [
        "packages/core/src/safe-spawn.ts",
        "apps/nexus-statusline/src/**",
        "apps/agent/src/db/agent-registry.ts"
      ],
      "reason": "Trusted execs: safe-spawn.ts is the wrapper itself (self-reference); nexus-statusline runs constant-arg git probes with no user input; agent-registry runs `tailscale ip -4` with no interpolation"
    },
```

The reason is false today: the file's spawn sites are NOT constant-arg (see
above). `apps/nexus-statusline/src/` contains exactly two files (`index.ts`,
`index.test.ts`); test files are auto-skipped for D4 via `autoSkipTestFiles`.

### The typo'd allowlist

`packages/core/src/audit-suppressions.integration.test.ts:76-87`:

```ts
const EXPECTED_UNSUPPRESSED_D4_FILES = new Set<string>([
  // The safeSpawn wrapper itself calls Bun.spawn — D4 pattern match hits the
  // implementation, which is by definition the sanctioned spawn site.
  "packages/core/src/safe-spawn.ts",
  // nexus-statuslineline is a standalone CLI that reads git state via execSync with
  // constant command strings. Not routed through safeSpawn because it has no
  // user-supplied input surface.
  "apps/nexus-statuslineline/src/index.ts",
  // Tailscale IP lookup in the agent's DB registry — constant args, boots
  // once at startup. Candidate for future safeSpawn migration.
  "apps/agent/src/db/agent-registry.ts",
]);
```

`apps/nexus-statuslineline/` (doubled "line") does not exist — the real path
is `apps/nexus-statusline/src/index.ts`.

### Pre-existing integration-suite redness (IMPORTANT — read before verifying)

`packages/core/src/audit-suppressions.integration.test.ts` was measured at
authoring time (2026-07-11, tree = b7096486 for all in-scope files) as:
**24 pass, 1 skip, 18 fail** (`bun test packages/core/src/audit-suppressions.integration.test.ts`).
The 18 failures are pre-existing environment drift, NOT caused by anything
this plan touches: the `audit-scan` binary at `~/.claude/scripts/bin/audit-scan`
now reports 31 D4 findings across `apps/agent/**` files that the pinned
baselines (D4 == 0, score >= 99, etc.) predate, and one test references a
nonexistent `apps/nextjs/...` path. Live audit-scan confirms
`apps/nexus-statusline` produces **zero** D4 findings today (the suppression
is working). Your bar for this suite is therefore: **same or fewer failures
than 18, and no NEW failing test naming a statusline path**. Do not attempt
to fix the other 18 — that is a separate triage (see Maintenance notes).

### Design decision (settled by this plan — do not re-open)

Two ways to fix the `sh -c` sites were considered:

1. **Positional shell parameters** (chosen): keep `sh -c` but make the script
   a compile-time constant; pass variable values as positional args
   (`spawn("sh", ["-c", SCRIPT, "sh", value1, value2], ...)`). The shell
   never parses interpolated data — `$1`/`$2` expansion happens after
   parsing, so metacharacters in values are inert. Preserves the detached
   atomic `> tmp && mv` idiom exactly. Zero new dependencies.
2. **Add `@nexus/core` workspace dep for `safeSpawn`**: rejected — the
   statusline is a zero-dependency standalone binary compiled with
   `bun build --compile`; pulling a workspace package into it for two
   constant-script spawns is disproportionate, and `safeSpawn` does not by
   itself provide the shell-side `&& mv` atomic-rename idiom these sites need.

For the three git probes, `execFileSync("git", ["-C", dir, ...])` is a pure
drop-in (no shell features are used), so no shell is involved at all.

## Commands you will need

Run from the repo root (`/home/nyaptor/dev/personal/nexus`), or the worktree
root if executing in a worktree.

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `pnpm install` | exit 0 |
| Typecheck (root) | `pnpm typecheck` | exit 0, no errors |
| Statusline tests | `bun test apps/nexus-statusline` | 116 pass, 0 fail (113 baseline + 3 new) |
| Suppression integration suite | `bun test packages/core/src/audit-suppressions.integration.test.ts` | 24 pass, 1 skip, <= 18 fail (pre-existing; see Current state) — takes ~90s |
| Lint | `pnpm lint` | exit 0 |
| Direct audit-scan probe | `~/.claude/scripts/bin/audit-scan --project . --json \| python3 -c "import json,sys; r=json.load(sys.stdin); print([f['file'] for f in r['findings'] if f['id']=='D4' and 'statusline' in f['file']])"` | `[]` |

## Scope

**In scope** (the only files you may modify):

- `apps/nexus-statusline/src/index.ts` — the five spawn sites + `execSync` import + `export` keyword on `getGitStatus`
- `apps/nexus-statusline/src/index.test.ts` — three new regression tests
- `.audit-suppressions.json` — D4 stanza only (path narrowing + truthful reason)
- `packages/core/src/audit-suppressions.integration.test.ts` — the typo'd entry + its attached comment only

**Out of scope** (do NOT touch, even though they look related):

- `apps/nexus-statusline/package.json` — do NOT add `@nexus/core` (decision
  above), and do NOT fix the `"test": "echo 'no tests yet'"` false-green
  script — that belongs to the statusline cache-machinery plan (026/027 family).
- Cache lifecycle behavior in `index.ts` (`stale` flag on corrupt cache, GC
  prefixes, pid-suffixed tmp names) — plans 026/027 own those lines.
- Any structural split of `index.ts` into modules — plan 031 owns that, and
  it runs AFTER this plan.
- `writeSessionContext`'s null-usedPct early-return — settled BY DESIGN; do
  not change the guard.
- `packages/core/src/safe-spawn.ts` and every `apps/agent` spawn site — all
  verified clean; this plan is statusline-only.
- The 18 pre-existing integration-suite failures / audit-scan baseline drift
  — separate triage, not this plan.

## Git workflow

- Branch: `advisor/025-statusline-spawn-hygiene` (plans execute in worktrees;
  main advances mid-run — the drift check at top guards this).
- Conventional commits, e.g.
  `fix(nexus-statusline): eliminate shell-string interpolation in spawn sites`.
  One commit for steps 1–4 (code + tests), one for steps 5–6 (suppression +
  allowlist) is acceptable; a single commit is also fine.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Convert `getGitStatus` to argv-vector `execFileSync`

In `apps/nexus-statusline/src/index.ts`:

1. Change the import at line 59 from
   `import { execSync } from "node:child_process";` to
   `import { execFileSync } from "node:child_process";`
   (leave the `import * as childProcess` line at :60 untouched — the spawn
   sites and the test spies use it).
2. Add the `export` keyword to `getGitStatus` (line 354):
   `export function getGitStatus(dir: string): GitInfo | null {`
   (exports in this file exist solely for `index.test.ts` — this matches the
   established convention, cf. `export function getRoadmapPulse` at :867).
3. Replace the three `execSync` calls with `execFileSync`, keeping every
   option object byte-identical:

```ts
    const branch = execFileSync("git", ["-C", dir, "branch", "--show-current"], {
      encoding: "utf-8",
      timeout: 500,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
```

```ts
    const porcelain = execFileSync("git", ["-C", dir, "status", "--porcelain"], {
      encoding: "utf-8",
      timeout: 500,
      stdio: ["pipe", "pipe", "pipe"],
    });
```

```ts
      const revOut = execFileSync(
        "git",
        ["-C", dir, "rev-list", "--count", "@{upstream}..HEAD"],
        { encoding: "utf-8", timeout: 500, stdio: ["pipe", "pipe", "pipe"] },
      );
```

**Verify**:
```bash
grep -c "execSync" apps/nexus-statusline/src/index.ts
```
→ `0` (note: the string `execSync` is NOT a substring of `execFileSync`, so
this is a clean check), then
```bash
pnpm typecheck && bun test apps/nexus-statusline
```
→ typecheck exit 0; 113 pass, 0 fail (no new tests yet).

### Step 2: Convert `getRoadmapPulse`'s spawn to a constant script with positional parameters

In `apps/nexus-statusline/src/index.ts`, immediately after the `PULSE_BIN`
constant (line 855), add a module-level constant. It MUST be a
**single-quoted TS string** (not a template literal) so `${2}` is literal
text handed to `sh`, not TypeScript interpolation:

```ts
// Constant refresh script — values arrive as positional shell parameters
// ($1 = binary, $2 = cache path), never interpolated into the script text,
// so shell metacharacters in paths are inert. $0 is set to "sh" by the
// extra argv entry. Preserves the detached atomic `> tmp && mv` idiom.
const PULSE_REFRESH_SCRIPT =
  '"$1" --line > "${2}.tmp" 2>/dev/null && mv "${2}.tmp" "$2"';
```

Then replace the spawn at :886-896 so only the args array changes (options
object stays byte-identical — the existing PULSE_RADAR tests read it as
`spy.mock.calls[0]?.[2]` and must keep passing):

```ts
      const child = childProcess.spawn(
        "sh",
        ["-c", PULSE_REFRESH_SCRIPT, "sh", PULSE_BIN, cachePath],
        {
          cwd: projectDir,
          detached: true,
          stdio: "ignore",
          // Producer-side radar gate: cc's roadmap-pulse skips radar rungs when 0
          env: { ...process.env, PULSE_RADAR: isBb ? "1" : "0" },
        },
      );
```

**Verify**:
```bash
bun test apps/nexus-statusline 2>&1 | tail -4
```
→ 113 pass, 0 fail — in particular the two `[2.2]` "PULSE_RADAR spawn env"
tests (index.test.ts:887-921) still pass, proving the options object was not
disturbed.

### Step 3: Convert `readCachedAgentJson`'s spawn the same way

In `apps/nexus-statusline/src/index.ts`, add beside `PULSE_REFRESH_SCRIPT`
(again a single-quoted TS string):

```ts
// Constant curl-refresh script — $1 = url, $2 = cache path, positional only.
// `curl -f` + `&&` means a down/erroring agent leaves the cache untouched.
const CURL_REFRESH_SCRIPT =
  'curl -sf --max-time 3 "$1" > "${2}.tmp" 2>/dev/null && mv "${2}.tmp" "$2"';
```

Replace the spawn at :1022-1029 with:

```ts
    const child = childProcess.spawn(
      "sh",
      ["-c", CURL_REFRESH_SCRIPT, "sh", url, cachePath],
      { detached: true, stdio: "ignore" },
    );
```

Do not change the function's docstring (its "Identical mechanism to
`getRoadmapPulse`" claim remains true) or its callers (`getSpecsLine`,
`getRoadmapLine`, `getDriftLine`) — their cachePath/url construction is now
harmless because the values travel as argv, not script text.

**Verify**:
```bash
grep -n '\${' apps/nexus-statusline/src/index.ts | grep -E 'curl -sf|--line|git -C'
```
→ no output (zero template-literal interpolation in any spawn/exec command
text), and
```bash
grep -c 'REFRESH_SCRIPT' apps/nexus-statusline/src/index.ts
```
→ `4` (two definitions + two uses), then
```bash
pnpm typecheck && bun test apps/nexus-statusline 2>&1 | tail -4
```
→ typecheck exit 0; 113 pass, 0 fail.

### Step 4: Add three regression tests

In `apps/nexus-statusline/src/index.test.ts`, add `getGitStatus` to the
existing import block from `./index` (see lines 23-28 which already import
`getRoadmapPulse`, `getSpecsLine`, `getRoadmapLine`, `getDriftLine`), then
append a new describe block. Model the spawn-spy tests on the existing
`describe("getRoadmapPulse — PULSE_RADAR spawn env", ...)` block at
index.test.ts:887-921 (same `spyOn(childProcess, "spawn")` +
`mkdtempSync` + `finally { spy.mockRestore(); rmSync(...) }` shape). The
three tests:

1. **getGitStatus survives a shell-hostile path** (this test FAILS against
   the old execSync code — it is the regression pin): create
   `mkdtempSync(join(tmpdir(), "nx-git-meta-"))`, then inside it
   `mkdirSync(join(base, 'repo "$(echo pwned)"'))` (a directory whose name
   contains a double quote and a `$()` sequence — `mkdirSync` handles any
   byte), run `execFileSync("git", ["-C", hostileDir, "init", "-b", "main"], ...)`
   (import `execFileSync` in the test file), then assert
   `getGitStatus(hostileDir)?.branch === "main"` and `dirty === false`.
2. **getRoadmapPulse passes cachePath as a positional argv entry**: spy on
   `childProcess.spawn` as in the [2.2] tests, call `getRoadmapPulse(dir)`
   on a fresh mkdtemp dir (no cache → stale → spawn fires), then read
   `spy.mock.calls[0]?.[1] as string[]` and assert: `args.length === 5`,
   `args[0] === "-c"`, `args[1]` (the script) does **not** contain the
   substring `dir`-derived project code and does not contain `"${c"` (i.e.
   `expect(args[1]).not.toContain(deriveProjectCode-output)` — simplest:
   assert `args[1] === '"$1" --line > "${2}.tmp" 2>/dev/null && mv "${2}.tmp" "$2"'`),
   and `args[4]` ends with `.line` and contains the project code.
3. **readCachedAgentJson passes url as a positional argv entry**: spy on
   `childProcess.spawn`, call
   `getSpecsLine("/home/nyaptor/dev/zzznope-spawn-test", "http://localhost:7400")`
   (matching the existing null-path tests at index.test.ts:428 — unique fake
   project code → no cache file → stale → spawn fires), then assert on
   `spy.mock.calls[0]?.[1] as string[]`: `args[1]` equals the constant
   `'curl -sf --max-time 3 "$1" > "${2}.tmp" 2>/dev/null && mv "${2}.tmp" "$2"'`,
   `args[3] === "http://localhost:7400/specs/all"`, and `args[4]` contains
   `bead-specs.zzznope-spawn-test.json`.

**Verify**:
```bash
bun test apps/nexus-statusline 2>&1 | tail -4
```
→ **116 pass, 0 fail**. Also spot-check the regression pin is real: the
step-4 test 1 would fail if you temporarily reverted step 1 (do not actually
revert — reasoning only).

### Step 5: Make the D4 suppression truthful and narrow

In `.audit-suppressions.json`, edit ONLY the `"id": "D4"` stanza (lines
61-69): change the path `"apps/nexus-statusline/src/**"` to
`"apps/nexus-statusline/src/index.ts"` (the only production source file in
that directory; `index.test.ts` is auto-skipped for D4 via
`autoSkipTestFiles`), and replace the reason with a truthful one:

```json
    {
      "id": "D4",
      "paths": [
        "packages/core/src/safe-spawn.ts",
        "apps/nexus-statusline/src/index.ts",
        "apps/agent/src/db/agent-registry.ts"
      ],
      "reason": "Trusted execs: safe-spawn.ts is the wrapper itself (self-reference); nexus-statusline (zero-dependency compiled binary, no @nexus/core) runs argv-vector git probes via execFileSync plus two constant-script sh spawns whose variable values travel as positional shell parameters, never interpolated into script text (plan 025); agent-registry runs `tailscale ip -4` with no interpolation"
    },
```

Keep the rest of the file byte-identical (note the file uses `—` escapes
elsewhere — do not reformat).

**Verify**:
```bash
python3 -c "import json; json.load(open('.audit-suppressions.json')); print('valid json')"
```
→ `valid json`, then
```bash
~/.claude/scripts/bin/audit-scan --project . --json | python3 -c "import json,sys; r=json.load(sys.stdin); print([f['file'] for f in r['findings'] if f['id']=='D4' and 'statusline' in f['file']])"
```
→ `[]` (statusline still fully suppressed — the narrowing changed which glob
matches, not the outcome). If `audit-scan` is missing at
`~/.claude/scripts/bin/audit-scan`, note it and rely on the JSON-validity
check plus Step 6's suite run.

### Step 6: Fix the typo'd allowlist entry

In `packages/core/src/audit-suppressions.integration.test.ts`, replace lines
80-83 (the comment + entry inside `EXPECTED_UNSUPPRESSED_D4_FILES`) with:

```ts
  // nexus-statusline is a standalone zero-dependency CLI. Its git probes use
  // execFileSync argv vectors and its refresh spawns use constant sh scripts
  // with positional parameters (plan 025) — not routed through safeSpawn.
  "apps/nexus-statusline/src/index.ts",
```

Touch nothing else in that file (the pinned baselines and ceilings are
pre-existing drift owned by a separate triage — see Current state).

**Verify**:
```bash
grep -c "statuslineline" packages/core/src/audit-suppressions.integration.test.ts
```
→ `0`, then
```bash
bun test packages/core/src/audit-suppressions.integration.test.ts 2>&1 | tail -4
```
→ pass/skip/fail counts are **24 pass, 1 skip, 18 fail or better** (identical
to the authoring-time baseline; your edits must not add a failure). This run
takes ~90 seconds — do not kill it early.

### Step 7: Full gates

**Verify**:
```bash
pnpm typecheck && pnpm lint && bun test apps/nexus-statusline 2>&1 | tail -4
```
→ typecheck exit 0; lint exit 0; 116 pass, 0 fail. Then run the root suite
and confirm no NEW failures attributable to the four changed files
(pre-existing failures: the audit-suppressions integration baselines above,
and CI's lint-sql-safety false positive until plan 023 lands):
```bash
bun test 2>&1 | tail -6
```

## Test plan

- New tests (Step 4), all in `apps/nexus-statusline/src/index.test.ts`,
  modeled structurally on the existing
  `describe("getRoadmapPulse — PULSE_RADAR spawn env")` block
  (index.test.ts:887-921):
  1. `getGitStatus` returns branch info for a repo path containing `"` and
     `$()` (regression pin for the execSync → execFileSync conversion).
  2. `getRoadmapPulse` refresh spawn: script text is the exact constant;
     cachePath arrives as `args[4]`, never inside the script.
  3. `readCachedAgentJson` (via `getSpecsLine`) refresh spawn: url is
     `args[3]`, cachePath is `args[4]`, script text is the exact constant.
- Existing tests that double as regression guards: the two `[2.2]`
  PULSE_RADAR tests (options-object position unchanged) and the
  stale-while-revalidate null-path tests at index.test.ts:420-429/:525-531.
- Verification: `bun test apps/nexus-statusline` → 116 pass, 0 fail.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -c "execSync" apps/nexus-statusline/src/index.ts` → `0`
- [ ] `grep -n '\${' apps/nexus-statusline/src/index.ts | grep -E 'curl -sf|--line|git -C'` → no output
- [ ] `grep -c 'REFRESH_SCRIPT' apps/nexus-statusline/src/index.ts` → `4`
- [ ] `pnpm typecheck` exits 0
- [ ] `bun test apps/nexus-statusline` → 116 pass, 0 fail
- [ ] `grep -c "statuslineline" packages/core/src/audit-suppressions.integration.test.ts` → `0`
- [ ] `python3 -c "import json; s=[x for x in json.load(open('.audit-suppressions.json'))['suppressions'] if x['id']=='D4'][0]; assert 'apps/nexus-statusline/src/index.ts' in s['paths'] and 'apps/nexus-statusline/src/**' not in s['paths'] and 'constant-arg git probes' not in s['reason']; print('ok')"` → `ok`
- [ ] `~/.claude/scripts/bin/audit-scan --project . --json` shows zero D4 findings under `apps/nexus-statusline/` (command in Step 5)
- [ ] `bun test packages/core/src/audit-suppressions.integration.test.ts` fail count <= 18 (authoring-time baseline), no new failing test naming a statusline path
- [ ] `git status` shows modifications ONLY to the four in-scope files
- [ ] `plans/README.md` status row updated (with `spec-impact:` note per the executor handoff rule)

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check at the top shows any in-scope file changed AND the
  "Current state" excerpts no longer match the live code (plans 026/027/031
  target the same file — if one of them landed first, the line numbers and
  possibly the spawn sites themselves have moved).
- After Step 2, either `[2.2]` PULSE_RADAR test fails twice after a
  reasonable fix attempt (means the options-object position shifted — the
  tests read `spy.mock.calls[0]?.[2]`).
- After Step 5, audit-scan reports any D4 finding under
  `apps/nexus-statusline/` (means the exact-file path form is not matched by
  audit-scan's suppression matcher — revert to the `src/**` glob, keep the
  truthful reason, and report the matcher limitation).
- The integration suite's failure count EXCEEDS 18 after your changes.
- Any fix appears to require touching `apps/nexus-statusline/package.json`,
  `packages/core/src/safe-spawn.ts`, or any `apps/agent` file.
- You discover `getGitStatus` is exported or spied somewhere this plan did
  not predict (a concurrent plan landed) — coordinate, don't overwrite.

## Maintenance notes

- **Ordering**: plan 026 edits the same file next; plan 031 then splits
  `index.ts` along its banner seams and will relocate `PULSE_REFRESH_SCRIPT`
  / `CURL_REFRESH_SCRIPT` — the constants and their tests should move as a
  unit into whatever module owns the SWR cache pipeline.
- **For the next statusline feature that needs a background refresh**: copy
  the positional-parameter constant-script shape, NOT the old interpolated
  template — the old template was cloned once already (`readCachedAgentJson`
  copied `getRoadmapPulse`), which is exactly how this class reproduces.
- **Reviewer focus**: (a) the options objects of both spawn calls are
  byte-identical to before (PULSE_RADAR env gate, `cwd`, `detached`,
  `stdio`); (b) the two script constants are single-quoted TS strings — a
  template literal here silently reintroduces the bug; (c) the suppression
  reason now matches reality — keep it truthful on future edits.
- **Deferred, deliberately**: the 18 pre-existing audit-suppressions
  integration failures (audit-scan baseline drift: 31 D4 hits in
  `apps/agent/**`, score 77 vs pinned >= 99, a dead `apps/nextjs` path
  reference) need their own triage/plan — this plan only guarantees it adds
  nothing to that pile. Also deferred: the statusline `package.json`
  false-green test script (plan 026/027 family) and any `safeSpawn`
  adoption in this app (rejected in the design decision above).
