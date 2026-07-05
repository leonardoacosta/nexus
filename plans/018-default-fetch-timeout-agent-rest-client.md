# Plan 018: Add a default AbortSignal timeout to AgentRestClient via a single request() wrapper

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update (or add) the status row for
> this plan in `plans/README.md` — unless a reviewer dispatched you and told
> you they maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat c67ff12c..HEAD -- apps/web/src/lib/agent-rest-client.ts apps/web/tsconfig.json`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug (reliability)
- **Planned at**: commit `c67ff12c`, 2026-07-05

## Why this matters

All three HTTP calls the web dashboard makes to the Nexus agent
(`listSessions`, `getSession`, `startSession` in
`apps/web/src/lib/agent-rest-client.ts`) use bare `fetch` with **no timeout**.
Browser/Bun `fetch` has no default deadline: a connected-but-silent agent
socket (agent wedged, tailnet path half-open) leaves the promise pending
forever. The damage is worst in `pollSessions` (same file): each tick `await`s
`listSessions` and schedules the **next** tick only in `finally` — if the
awaited fetch never settles, neither `catch` (so `onError` never fires) nor
`finally` (so no reschedule) runs. The poll loop stalls permanently and
silently, defeating the self-heal behavior its own doc comment promises
("the loop keeps running after an error so a transient agent blip
self-heals"). One private `request()` wrapper with a default
`AbortSignal.timeout`, combined with any caller signal via `AbortSignal.any`,
turns a hang into a surfaced `TimeoutError` and lets the poll loop keep
ticking.

Class context (settled — do not expand scope): this is a single-file
reliability fix in the web client. It is NOT request authentication (the
Tailscale-ACL trust boundary is deliberate design) and NOT an agent-side
change.

## Current state

Files (roles):

- `apps/web/src/lib/agent-rest-client.ts` — the web app's **entire** HTTP
  surface to the agent (exactly 3 live `fetch` sites, all in this file). URL
  building is already centralized via `private http(path)`; request execution
  is not. Also contains the `pollSessions` helper.
- `apps/web/src/lib/index.ts` — barrel that re-exports `AgentRestClient`,
  `AgentHttpError`, `pollSessions`. No change needed (this plan only adds an
  optional constructor parameter and a private method).
- Callers: `apps/web/src/components/SessionList.tsx` and
  `apps/web/src/components/NewSessionForm.tsx` — construct
  `new AgentRestClient(url)`. Unchanged (new constructor param is optional).
- `apps/web/tsconfig.json` — currently `"exclude": ["node_modules"]`; gets one
  added glob so the new bun test file is not swept into `tsc --noEmit`
  (apps/web cannot resolve `bun:test` types — see Step 2 rationale).

### Excerpt 1 — the three fetch sites (as of c67ff12c)

`apps/web/src/lib/agent-rest-client.ts:117-123` (`listSessions`):

```ts
    const url = this.http(path);
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: opts.signal,
      cache: "no-store",
    });
```

`apps/web/src/lib/agent-rest-client.ts:136-142` (`getSession`):

```ts
    const url = this.http(`/sessions/${encodeURIComponent(id)}`);
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal,
      cache: "no-store",
    });
```

`apps/web/src/lib/agent-rest-client.ts:157-170` (`startSession` — note: passes
NO signal at all today):

```ts
    const url = this.http("/session/start");
    const body: Record<string, string> = {
      project: input.project,
      path: input.path,
    };
    if (input.specSlug) body.spec_slug = input.specSlug;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
```

`apps/web/src/lib/agent-rest-client.ts:202-208` (`http` helper — keep as-is,
`request()` will call it):

```ts
  private http(path: string): string {
    const url = toHttpUrl(this.agentBaseUrl, path);
    if (!url) {
      throw new AgentHttpError(0, `unconstructable agent URL for ${path}`);
    }
    return url;
  }
```

### Excerpt 2 — the poll loop that stalls on a hang

`apps/web/src/lib/agent-rest-client.ts:242-261` (`pollSessions` tick):

```ts
  const tick = async () => {
    if (stopped) return;
    controller = new AbortController();
    try {
      const sessions = await client.listSessions({
        ...opts.listOptions,
        signal: controller.signal,
      });
      if (!stopped) onSessions(sessions);
    } catch (err) {
      // AbortError on stop() is expected — swallow it.
      if (!stopped && !(err instanceof DOMException && err.name === "AbortError")) {
        opts.onError?.(err);
      }
    } finally {
      if (!stopped) {
        timer = setTimeout(() => void tick(), intervalMs);
      }
    }
  };
```

Key facts about this loop (verified on live Bun 1.3.11, this machine,
2026-07-05):

- `AbortSignal.timeout(ms)` aborts with a `DOMException` named
  **`TimeoutError`** (not `AbortError`). A `fetch` against a TCP socket that
  accepts but never responds, with
  `signal: AbortSignal.any([AbortSignal.timeout(300)])`, rejected in ~301 ms
  with `e.name === "TimeoutError"`, `e instanceof DOMException === true`.
- The `catch` above swallows **only** `AbortError`, so a `TimeoutError`
  correctly reaches `opts.onError`, and `finally` reschedules the next tick.
  No change to `pollSessions` is needed — fixing the fetch layer alone
  restores the promised self-heal.
- `AbortSignal.any` and `AbortSignal.timeout` exist in Bun 1.3.11 and in the
  TS `DOM` lib that apps/web compiles against (`"lib": ["ES2022", "DOM",
  "DOM.Iterable"]`, TS ^5.7) — no polyfill, no new dependency.

### Excerpt 3 — current tsconfig exclude

`apps/web/tsconfig.json:24` (last line of the file's JSON object):

```json
  "exclude": ["node_modules"]
```

### Repo conventions that apply

- Bun monorepo — Bun executes TS directly; never `tsc` for execution.
  `bun test` discovers `*.test.ts` files repo-wide (excluding node_modules).
- apps/web has **no** test files today and no `@types/bun` (verified:
  `apps/web/node_modules/@types/` contains only `node`, `react`, `react-dom`;
  `bun-types` is not resolvable from apps/web under pnpm strict linking). A
  `bun:test` import in a file swept by apps/web's `tsc --noEmit` would break
  `pnpm typecheck`. Hence the one-line tsconfig exclude in Step 2 — NOT a new
  dependency (do not add `@types/bun` to apps/web).
- Hung-fetch test pattern exemplar:
  `apps/agent/src/notifications/reliability-regression.test.ts:231-242` swaps
  `globalThis.fetch` for `mock(() => new Promise<Response>(() => {}))` inside
  `try`/`finally`. This plan's tests use real localhost Bun sockets instead
  (stronger — exercises the actual abort path), but mimic that file's
  structure: `describe`/`it` from `bun:test`, cleanup in `finally`/`afterAll`,
  explicit per-test timeout budgets.
- Lint is a single root flat config (`eslint.config.mjs`,
  `tseslint.configs.recommended`, not type-aware) — it does not resolve
  `bun:test` imports, so the new test file lints clean without config changes.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `pnpm install` | exit 0 |
| Typecheck (scoped) | `pnpm --filter @nexus/web typecheck` | exit 0, no output after the script banner (verified green at c67ff12c) |
| Typecheck (repo) | `pnpm typecheck` | exit 0 (baseline greened 2026-07-03 by informal plan 016; if red, verify no NEW errors attributable to in-scope files) |
| Lint (repo) | `pnpm lint` | exit 0 (same baseline caveat) |
| New tests | `bun test apps/web/src/lib/agent-rest-client.test.ts` | 5 pass, 0 fail |
| Full test suite | `NEXUS_ATTACH_SECRET=test bun test` | no NEW failures vs a pre-change run (PG integration tests additionally need `POSTGRES_URL`; skip-if-unset behavior is pre-existing) |

## Scope

**In scope** (the only files you may modify/create):

- `apps/web/src/lib/agent-rest-client.ts` — add `request()` wrapper + two
  timeout constants + optional constructor param; route the 3 methods through
  it.
- `apps/web/src/lib/agent-rest-client.test.ts` — **create** (new tests).
- `apps/web/tsconfig.json` — add `"src/**/*.test.ts"` to `exclude` (one line).

**Out of scope** (do NOT touch, even though they look related):

- `apps/web/next.config.ts` — a prior scan hit at line 10 is docstring prose
  ("fetch() + WebAssembly.instantiate()"), not a call site. Confirmed false
  positive; there is no fetch in that file.
- `apps/web/src/lib/agent-ws-client.ts` — WebSocket transport, different
  lifecycle (its own reconnect/heartbeat semantics). Owned by no plan; leave
  alone.
- `apps/web/src/lib/agent-config.ts`, `apps/web/src/lib/index.ts` — no export
  or signature changes needed.
- `apps/web/src/components/*.tsx` — constructor param is optional; callers
  compile unchanged.
- Anything under `apps/agent/` or `packages/` — this is a web-client-only fix.
- `apps/web/package.json` / any lockfile — no new dependencies (specifically:
  do NOT add `@types/bun`).
- Any form of request authentication — the Tailscale-ACL trust boundary is
  deliberate design.

## Git workflow

- Work on the **current branch** (no branch creation, per this repo's executor
  convention).
- Single commit, targeted adds only:
  `git add apps/web/src/lib/agent-rest-client.ts apps/web/src/lib/agent-rest-client.test.ts apps/web/tsconfig.json .beads/ && git commit && git push`
  Never `git add .` / `-A` / bare directories (other sessions may share this
  tree).
- Message style (match `git log`): `fix(web): default fetch timeout in AgentRestClient (advisor-plans/018)`

## Steps

### Step 1: Add the `request()` wrapper and route all three methods through it

In `apps/web/src/lib/agent-rest-client.ts`:

1a. Above the `AgentRestClient` class (after the `AgentHttpError` class, in
the `// ── Client ──` section), add two module constants:

```ts
/**
 * Default per-request deadline. fetch has NO built-in timeout — without one,
 * a connected-but-silent agent socket pends forever and stalls pollSessions
 * (its next tick is scheduled in `finally`, which a hung await never reaches).
 * 10s: comfortably above tailnet round-trip, short enough that the 3s poll
 * loop self-heals quickly. Ticks never overlap (next tick is scheduled only
 * after the current one settles), so a timing-out tick just delays the list
 * refresh by up to the deadline.
 */
const DEFAULT_TIMEOUT_MS = 10_000;

/** `POST /session/start` spawns tmux + a Claude Code process on the agent — allow a longer budget. */
const START_SESSION_TIMEOUT_MS = 30_000;
```

1b. Change the constructor to accept an optional default-timeout override
(needed so tests can use a sub-second deadline; also a per-client knob):

```ts
export class AgentRestClient {
  constructor(
    private readonly agentBaseUrl: string,
    private readonly defaultTimeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}
```

1c. Add ONE private method (place it next to the existing `private http`):

```ts
  /**
   * Single execution point for all agent HTTP calls. Injects a default
   * timeout so no request can pend forever; a caller-supplied cancellation
   * signal is combined via AbortSignal.any (whichever aborts first wins).
   * Timeout rejection surfaces as a DOMException named "TimeoutError" —
   * distinct from the "AbortError" that pollSessions deliberately swallows.
   */
  private async request(
    path: string,
    init: RequestInit & { timeoutMs?: number } = {},
  ): Promise<Response> {
    const { timeoutMs = this.defaultTimeoutMs, signal, ...rest } = init;
    const timeout = AbortSignal.timeout(timeoutMs);
    return fetch(this.http(path), {
      ...rest,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  }
```

1d. Route the three methods through it — each replaces its
`const url = this.http(...)` + `await fetch(url, {...})` pair with a single
`await this.request(path, {...})` carrying the SAME options it passes today:

- `listSessions` (currently lines 117–123):

```ts
    const res = await this.request(path, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: opts.signal,
      cache: "no-store",
    });
```

- `getSession` (currently lines 136–142):

```ts
    const res = await this.request(`/sessions/${encodeURIComponent(id)}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal,
      cache: "no-store",
    });
```

- `startSession` (currently lines 157–170) — keep the body-building lines,
  replace only the url/fetch pair, and give it the longer budget:

```ts
    const res = await this.request("/session/start", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      timeoutMs: START_SESSION_TIMEOUT_MS,
    });
```

Do NOT change `http()`, `AgentHttpError`, any DTO, or anything in
`pollSessions` — the existing `catch`/`finally` already handles `TimeoutError`
correctly (it only swallows `AbortError`).

**Verify**:
`grep -c "fetch(" apps/web/src/lib/agent-rest-client.ts` → `1`
(the single call inside `request()`; the doc-comment mention of
`NexusClient.fetchSessions` does not match `fetch(`).
Then: `pnpm --filter @nexus/web typecheck` → exit 0.

### Step 2: Exclude test files from apps/web tsc, then write the tests

2a. In `apps/web/tsconfig.json`, change the exclude line to:

```json
  "exclude": ["node_modules", "src/**/*.test.ts"]
```

Rationale (inline so you don't "fix" this differently): the test imports
`bun:test` and uses the `Bun` global. apps/web has no `@types/bun` (verified
not resolvable under pnpm strict linking) and MUST NOT gain it (dependency
scope boundary; its globals also overlap the DOM lib this Next.js app compiles
against). `bun test` executes the file regardless of tsconfig; only
`tsc --noEmit` needs to skip it.

2b. Create `apps/web/src/lib/agent-rest-client.test.ts` with the 5 tests below.
Structural pattern: mimic
`apps/agent/src/notifications/reliability-regression.test.ts` (bun:test
imports, cleanup in `afterAll`/`finally`, explicit test timeout budgets).
Use real localhost sockets, not fetch stubs:

- **Black-hole helper** (module-level): `Bun.listen({ hostname: "127.0.0.1",
  port: 0, socket: { open() {}, data() {} } })` — accepts TCP, never responds.
  Base URL: `` `http://127.0.0.1:${srv.port}` ``. Stop with `srv.stop(true)`
  in `afterAll`.
- **Responding helper**: `Bun.serve({ port: 0, fetch: handler })`; stop in
  `afterAll`.

Tests (names load-bearing — keep the numbering):

1. `"listSessions rejects with TimeoutError instead of pending forever"` —
   `new AgentRestClient(blackHoleUrl, 250)`; expect `client.listSessions()`
   to reject; assert the error is a `DOMException` with
   `name === "TimeoutError"` and that it rejected in well under 5s (record
   `Date.now()` before/after; assert elapsed `< 5_000`). Test timeout: 10_000.
2. `"caller AbortSignal still cancels before the default timeout"` —
   `new AgentRestClient(blackHoleUrl, 10_000)`; create an `AbortController`,
   `setTimeout(() => controller.abort(), 50)`; expect
   `client.listSessions({ signal: controller.signal })` to reject with
   `name === "AbortError"` (proves `AbortSignal.any` preserves caller
   cancellation). Test timeout: 10_000.
3. `"getSession times out on a silent socket"` —
   `new AgentRestClient(blackHoleUrl, 250)`; assert `client.getSession("x")`
   rejects with `name === "TimeoutError"` (covers the third GET path through
   `request()`). Do NOT write a startSession timeout test: Step 1d pins
   startSession to the explicit per-call `timeoutMs: START_SESSION_TIMEOUT_MS`
   (30s), which overrides the constructor default — a timeout test there
   would take 30 real seconds. startSession routing is instead proven by
   test 5's happy path plus the `grep -c "fetch(" == 1` done-criterion
   (no bypass fetch path exists). Test timeout: 10_000.
4. `"pollSessions surfaces TimeoutError via onError and keeps ticking"` — the
   regression this plan exists for. `new AgentRestClient(blackHoleUrl, 100)`;
   `pollSessions(client, () => {}, { intervalMs: 50, onError: (e) => errors.push(e) })`;
   await until `errors.length >= 2` (poll every 25ms, give up after 5s), then
   `poll.stop()`. Assert `errors.length >= 2` (loop rescheduled after the
   first timeout — `finally` ran) and `(errors[0] as DOMException).name ===
   "TimeoutError"`. Test timeout: 10_000.
5. `"happy path: listSessions and startSession still work through request()"` —
   `Bun.serve` handler: `GET /sessions*` → `Response.json([])`;
   `POST /session/start` → echo-check `await req.json()` has `project` and
   `path`, respond `Response.json({ session_name: "s", started: true })`.
   Assert `listSessions()` resolves to `[]` and
   `startSession({ project: "p", path: "/tmp" })` resolves with
   `sessionName === "s"`, `started === true` (proves method/headers/body still
   plumb through the wrapper).

Import what you need from `"bun:test"` (`describe`, `it`, `expect`,
`afterAll`) and `AgentRestClient`, `pollSessions` from
`"./agent-rest-client"`.

**Verify**: `bun test apps/web/src/lib/agent-rest-client.test.ts` →
`5 pass, 0 fail`. Then `pnpm --filter @nexus/web typecheck` → exit 0 (proves
the exclude works and the test file is not swept into tsc).

### Step 3: Full gates + commit

Run, in order:

1. `pnpm --filter @nexus/web typecheck` → exit 0
2. `pnpm typecheck` → exit 0 (baseline caveat: if red in files this plan never
   touched, record which — see STOP conditions)
3. `pnpm lint` → exit 0 (same caveat)
4. `NEXUS_ATTACH_SECRET=test bun test` → the 5 new tests pass; no NEW failures
   vs baseline (if unsure of baseline, `git stash` is banned in this shared
   tree — instead run the targeted file test plus
   `NEXUS_ATTACH_SECRET=test bun test apps/agent` and compare failure names
   against a fresh `git log`/CI expectation; any failure mentioning
   agent-rest-client is yours)
5. Commit + push per Git workflow above.

**Verify**: `git status --short` shows nothing staged/modified outside the
three in-scope files and `.beads/`.

## Test plan

- New file: `apps/web/src/lib/agent-rest-client.test.ts` (the first test file
  in apps/web) — 5 cases listed in Step 2b: timeout surfaces (1), caller
  cancellation preserved (2), startSession routed (3), poll loop self-heals —
  the core regression (4), happy-path plumbing (5).
- Structural exemplar: `apps/agent/src/notifications/reliability-regression.test.ts`
  (hung-fetch regression test, lines 219–291 — same describe/it/afterAll +
  explicit timeout-budget shape).
- Verification: `bun test apps/web/src/lib/agent-rest-client.test.ts` → 5
  pass, 0 fail, total runtime under ~10s (all deadlines are sub-second).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun test apps/web/src/lib/agent-rest-client.test.ts` → 5 pass, 0 fail
- [ ] `pnpm --filter @nexus/web typecheck` exits 0
- [ ] `pnpm typecheck` and `pnpm lint` exit 0 (or: any failures are in files
      this plan did not touch AND are reported, not silently accepted)
- [ ] `grep -c "fetch(" apps/web/src/lib/agent-rest-client.ts` → `1`
- [ ] `grep -c "AbortSignal.any" apps/web/src/lib/agent-rest-client.ts` → `1`
- [ ] `grep -c '"@types/bun"' apps/web/package.json` → `0` (no dependency added)
- [ ] `git status --short` shows changes ONLY in the three in-scope files
      (+ `.beads/`)
- [ ] `plans/README.md` status row for 018 updated (add the row if absent)

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts in "Current state" don't match the live file (another session
  has already touched `agent-rest-client.ts` — plans are drafted concurrently
  in this tree). Pin reads with
  `git show c67ff12c:apps/web/src/lib/agent-rest-client.ts` to confirm drift
  direction before reporting.
- `pnpm --filter @nexus/web typecheck` fails on `AbortSignal.any` /
  `AbortSignal.timeout` (would mean the TS lib assumption is wrong — do NOT
  polyfill or cast; report).
- The tsconfig exclude does not keep the test file out of `tsc --noEmit` and
  you are tempted to add `@types/bun` to apps/web — that is out of scope;
  report instead.
- Test 4 (poll self-heal) fails twice after one reasonable fix attempt
  (timing flake vs real bug needs a human eye).
- Fixing anything appears to require touching `agent-ws-client.ts`,
  `next.config.ts`, any component, or anything agent-side.

## Maintenance notes

- **Reviewer focus**: (a) `request()` must be the ONLY `fetch(` call in the
  file; (b) the `signal ? AbortSignal.any([signal, timeout]) : timeout`
  branch — passing `AbortSignal.any([undefined, ...])` would throw at runtime;
  (c) test 4 is the one that bites — it fails on the unfixed code (the loop
  stalls and `errors` never reaches 2), so it is a true regression guard.
- **Future interactions**: if `pollSessions` ever gains overlapping ticks or a
  shorter interval, revisit `DEFAULT_TIMEOUT_MS` (a 10s deadline currently
  delays at most one refresh; ticks are serialized via `finally`). If
  `agent-ws-client.ts` grows REST-ish side channels, route them through this
  same wrapper rather than adding a second timeout idiom.
- **Deferred deliberately**: retry/backoff (pollSessions' interval IS the
  retry policy); exposing `timeoutMs` on the public method options (YAGNI —
  constructor + per-call internal override cover today's callers); making
  `startSession` accept a caller AbortSignal (no caller wants one today).
