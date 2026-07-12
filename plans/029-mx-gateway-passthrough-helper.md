# Plan 029: Extract a shared mx-gateway passthrough helper and fold all 8 route copies onto it

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index. When you mark the row DONE/BLOCKED/REJECTED you MUST
> append `spec-impact: <slug>[, ...]` or `spec-impact: none` to the row.
>
> **Drift check (run first)**:
> `git diff --stat b7096486..HEAD -- apps/agent/src/routes/queue.ts apps/agent/src/routes/decisions.ts apps/agent/src/routes/requests.ts apps/agent/src/routes/capture.ts apps/agent/src/routes/decision.ts apps/agent/src/routes/sources.ts apps/agent/src/routes/triage.ts apps/agent/src/routes/thread.ts apps/agent/src/lib/ apps/agent/src/server-request-handler.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. (At authoring time this diff was
> empty at HEAD `d458ef8e` — the only commit past `b7096486` was a beads sync.
> Leo works directly in this checkout; expect main to advance mid-execution.)

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none (see "Cross-plan coordination" for scheduling constraints)
- **Category**: tech-debt
- **Planned at**: commit `b7096486`, 2026-07-11

## Repo facts (you have zero context — read this first)

- pnpm + Bun monorepo. NOT a standard T3 repo — no tRPC. The agent
  (`apps/agent`) is a Bun daemon.
- Quality gates: `pnpm typecheck`, `pnpm lint`, `bun test` (root `bun test`
  discovers all `*.test.ts`), `scripts/lint-sql-safety.sh`.
- CI (`.github/workflows/ci.yml`) is RED on main since 2026-07-10 solely due
  to a `lint-sql-safety` false positive (plan 023 fixes it). Until 023 lands,
  this plan's bar is: **no new failures attributable to the files it changes**.
- KNOWN PRE-EXISTING BASELINE FAILURES (verified 2026-07-11 at `b7096486`,
  none caused by this plan, none to be fixed by this plan):
  - `pnpm --filter @nexus/agent typecheck` (i.e. `tsc --noEmit` in
    `apps/agent`) fails with exactly 2 errors, both in a file this plan does
    NOT touch:
    ```
    src/routes/credentials.test.ts(20,3): error TS2300: Duplicate identifier 'initCredentialRoutes'.
    src/routes/credentials.test.ts(26,3): error TS2300: Duplicate identifier 'initCredentialRoutes'.
    ```
  - `@nexus/db#typecheck` fails with pre-existing TS2307 `bun:test` errors.
  - `pnpm --filter @nexus/agent lint` exits 0 with 46 pre-existing warnings,
    0 errors.
- Test conventions: `bun:test`, suites colocated as `<module>.test.ts`.
  `mock.module` is PROCESS-GLOBAL in bun — always spread the real barrel
  (see the logger stub pattern in `apps/agent/src/routes/queue.test.ts:13-26`,
  incident nx-jlx1c).
- Migration policy (irrelevant here — no DB work in this plan, listed for
  completeness): drizzle MIGRATION-ONLY, `db:push` is BANNED.

## Why this matters

The "mx gateway passthrough" skeleton — env-default base URL
(`MX_GATEWAY_URL` → `http://127.0.0.1:8799`), a `FETCH_TIMEOUT_MS`
AbortController + `setTimeout`/`clearTimeout` bound, a query-param allowlist
forward loop, and one of two failure postures (fail-soft empty payload for
reads, verbatim status/body relay + 504 for writes) — is copy-pasted across
**8 route files** in `apps/agent/src/routes/` with zero shared code
(verified: `src/lib/` and `src/utils/` contain no gateway code). Five of the
eight copies were added in the single delta `c67ff12c..b7096486`, and the
copies are already drifting: `/triage` and `/thread` use a 12s timeout while
the other six use 10s, and their param-forward + URL-construction details
diverge from the queue/decisions/requests trio. Every future gateway route
will clone the skeleton again, and every fix (timeout tuning, header change,
logging) must be applied 8 times or silently miss some copies. This plan
extracts one helper module and folds all 8 routes onto it, with zero change
to any route's HTTP contract except three small, deliberately-recorded
unifications listed below.

## Current state

All excerpts below are fresh reads at `b7096486` (working tree identical for
these files).

The 8 route files, each exporting exactly one handler consumed only by
`apps/agent/src/server-request-handler.ts` (imports at lines 73-81, dispatch
at lines 738-833) and by their colocated tests:

| File | Handler + signature | Posture | Timeout | Fail-soft empty payload / 504 error | Forwarded params |
|------|--------------------|---------|---------|--------------------------------------|------------------|
| `src/routes/queue.ts` | `handleGetQueue(request: Request)` | fail-soft GET `/queue` | 10s | `JSON.stringify({ items: [] })` | `["limit"]` |
| `src/routes/decisions.ts` | `handleGetDecisions(request: Request)` | fail-soft GET `/decisions` | 10s | `"[]"` (bare array) | `["since", "action"]` |
| `src/routes/requests.ts` | `handleGetRequests(request: Request)` | fail-soft GET `/requests` | 10s | `JSON.stringify({ requests: [] })` | `["status", "source", "changed_since"]` |
| `src/routes/sources.ts` | `handleGetSources()` — NO args | fail-soft GET `/sources` | 10s | `JSON.stringify({ sources: [], inbox: [] })` | none |
| `src/routes/triage.ts` | `handleGetTriage(url: URL)` | fail-soft GET `/triage` | **12s** | `"[]"` | `source`, `kind` (truthy-check) |
| `src/routes/thread.ts` | `handleGetThread(url: URL)` | fail-soft GET `/thread` | **12s** | `'{"messages":[]}'` | `source`, `id` (truthy-check) |
| `src/routes/capture.ts` | `handlePostCapture(request: Request)` | verbatim POST relay `/capture` | 10s | 504 `{ error: "capture gateway unreachable" }` | n/a (body relay) |
| `src/routes/decision.ts` | `handlePostDecision(request: Request)` | verbatim POST relay `/requests/{id}/decision` | 10s | 504 `{ error: "decision gateway unreachable" }` | n/a (body relay) |

The duplicated skeleton, e.g. `apps/agent/src/routes/queue.ts:19-28`:

```ts
/** mx gateway base URL. Loopback on the homelab; override via env for tests. */
const GATEWAY_URL = process.env.MX_GATEWAY_URL ?? "http://127.0.0.1:8799";

/** Bound the upstream fetch so a hung gateway can't stall the poll. */
const FETCH_TIMEOUT_MS = 10_000;

/** The fail-soft empty payload. */
const EMPTY_QUEUE = JSON.stringify({ items: [] });

/** Query params forwarded verbatim to the gateway. */
const FORWARDED_PARAMS = ["limit"] as const;
```

and the identical control flow at `queue.ts:37-81` (AbortController +
`setTimeout(abort, FETCH_TIMEOUT_MS)`; try: build upstream URL, forward
allowlisted params where `value !== null`, `fetch` with
`signal` + `Accept: application/json`; non-200 → `logger.warn` + empty
payload as 200; ok → `await upstream.text()` re-emitted as a fresh 200
Response with `Content-Type: application/json`; catch → `logger.warn` +
empty payload as 200; finally → `clearTimeout(timer)`).
`decisions.ts:37-81` and `requests.ts:37-81` are line-for-line identical to
it except the path, log strings, empty payload, and param list.

Known per-copy divergences (this is the drift the extraction stops):

- `triage.ts:26` and `thread.ts:25`: `const FETCH_TIMEOUT_MS = 12_000;` —
  the other six use `10_000`. The 12s value has no recorded rationale
  (introduced in commit `583c6c6d` with none stated), while 10s is the repo
  convention (plan 018) and is asserted by the docstrings in `capture.ts:20`
  and `decision.ts:16` ("bounded by the same 10s timeout as the read
  routes" — currently false for 2 of the read routes).
- `triage.ts:45-49` and `thread.ts:41-45` build the upstream URL BEFORE the
  `try` and forward params with a truthy check (`if (source) ...`), whereas
  `queue.ts:43-50` (and decisions/requests) deliberately build it INSIDE the
  `try` ("so a malformed MX_GATEWAY_URL fail-softs ... rather than throwing
  past the catch") and forward on `value !== null`.
- `decision.ts:27-41`: has a route-specific prelude — `parseRequestId()`
  extracting `{id}` from `/requests/{id}/decision` (400 on malformed path)
  — and passes `{ id }` in its log context. This prelude STAYS in
  `decision.ts`; only the fetch/relay skeleton moves to the helper.
- `capture.ts:38-40`: reads the client body (`await request.text()`) before
  the fetch. This read STAYS in `capture.ts`.

Existing tests (verified run at authoring time):

```
bun test apps/agent/src/routes/queue.test.ts apps/agent/src/routes/decisions.test.ts \
  apps/agent/src/routes/requests.test.ts apps/agent/src/routes/capture.test.ts \
  apps/agent/src/routes/decision.test.ts
# -> 23 pass, 0 fail, 66 expect() calls, 5 files
```

`sources.ts`, `triage.ts`, `thread.ts` have NO test suites. No test asserts
the exact `logger.warn` message strings (all five suites stub the logger via
`mock.module` and never inspect it), but `capture.test.ts:103` DOES assert
the 504 body: `expect(body.error).toBe("capture gateway unreachable")` — the
per-route 504 error strings must be preserved exactly.

Existing exemplar for a shared agent lib module: `apps/agent/src/lib/`
already holds `beads-reader.ts` and `fleet-exceptions.ts` (domain helpers);
`src/utils/` holds generic primitives (`exec.ts`, `run-pool.ts`). The
gateway helper is domain-specific → it goes in `src/lib/`.

### Recorded design decisions (do not re-litigate; implement as written)

1. **Timeout unified at `10_000` ms.** Routes that change behavior: `/triage`
   and `/thread` go 12s → 10s. Rationale: 10s is the plan-018 repo
   convention, 6 of 8 copies already use it, and the POST docstrings assert
   it; a loopback-gateway fetch exceeding 10s is already pathological, and
   the worst case is one poll cycle serving the graceful empty payload
   (clients re-poll — Swift polls `/sources` every 30s). The single helper
   constant is the whole point: if post-deploy logs show new abort warnings
   for `/triage` or `/thread`, it is a one-line bump (see Maintenance notes).
2. **Per-route empty-payload shapes stay in the route files** and are passed
   to the helper as a parameter — they are route contract (Swift decoders
   depend on `{items:[]}` vs `[]` vs `{"messages":[]}` etc.), not shared
   plumbing.
3. **Param forwarding unified on `value !== null`** (the queue/decisions/
   requests semantics). Change: `/triage` and `/thread` now forward
   empty-string params (e.g. `?source=`) instead of dropping them —
   negligible, the gateway treats an empty filter as no filter.
4. **Upstream-URL construction unified inside the `try`** — a malformed
   `MX_GATEWAY_URL` now fail-softs on `/triage`/`/thread` too (previously it
   threw out of the handler to the dispatcher's `.catch`). Strict
   improvement, matches the intent comment in `queue.ts:43-44`.
5. **Log message prose standardized** to two shared messages per posture,
   with the route preserved as a structured field (`{ route: "/queue" }`).
   Safe: no test asserts message text.

## Commands you will need

| Purpose | Command (run from repo root unless noted) | Expected on success |
|---------|-------------------------------------------|---------------------|
| Install | `pnpm install` | exit 0 |
| Route + helper tests | `bun test apps/agent/src/routes/queue.test.ts apps/agent/src/routes/decisions.test.ts apps/agent/src/routes/requests.test.ts apps/agent/src/routes/capture.test.ts apps/agent/src/routes/decision.test.ts apps/agent/src/lib/mx-gateway.test.ts` | 0 fail |
| Agent typecheck | `cd apps/agent && bunx tsc --noEmit` | exactly the 2 pre-existing `credentials.test.ts` TS2300 errors, nothing else |
| Agent lint | `pnpm --filter @nexus/agent lint` | exit 0, 0 errors (warnings OK — 46 pre-existing) |
| Single-definition grep | `grep -rn "process.env.MX_GATEWAY_URL" apps/agent/src --include="*.ts" \| grep -v "\.test\.ts"` | exactly 1 line: `apps/agent/src/lib/mx-gateway.ts` |

## Scope

**In scope** (the only files you may modify/create):

- `apps/agent/src/lib/mx-gateway.ts` (CREATE)
- `apps/agent/src/lib/mx-gateway.test.ts` (CREATE)
- `apps/agent/src/routes/queue.ts`
- `apps/agent/src/routes/decisions.ts`
- `apps/agent/src/routes/requests.ts`
- `apps/agent/src/routes/sources.ts`
- `apps/agent/src/routes/triage.ts`
- `apps/agent/src/routes/thread.ts`
- `apps/agent/src/routes/capture.ts`
- `apps/agent/src/routes/decision.ts`
- `plans/README.md` (status row only)

**Out of scope** (do NOT touch, even though they look related):

- `apps/agent/src/server-request-handler.ts` — the dispatch sites
  (lines 738-833) must keep working UNCHANGED; all 8 handler names and
  signatures are frozen (`handleGetSources()` takes no args,
  `handleGetTriage(url: URL)` / `handleGetThread(url: URL)` take a URL, the
  rest take `Request`).
- The 5 existing route test files (`queue.test.ts`, `decisions.test.ts`,
  `requests.test.ts`, `capture.test.ts`, `decision.test.ts`) — they are the
  regression harness for this refactor; if you need to edit them to go
  green, the refactor changed behavior — STOP.
- `apps/agent/src/routes/credentials.test.ts` — its 2 TS2300 errors are a
  pre-existing baseline failure owned elsewhere; do not fix.
- Any new gateway routes, route semantics, response shapes, or auth
  behavior — this plan is a pure extraction.
- `apps/nexus-statusline/**` — plan 031's territory.
- `scripts/lint-sql-safety.sh` / CI workflow — plan 023's territory.

## Cross-plan coordination

- This plan touches 8 route files at once — do NOT execute it concurrently
  with any other plan doing agent-route work (none of plans 017-031 lists
  these 8 files, but check `plans/README.md` IN PROGRESS rows first).
- CI on main is red until plan 023 lands; success for this plan is measured
  by the scoped commands above, not by overall CI green.

## Git workflow

- Execute in a worktree (Leo works directly in `~/dev/personal/nexus`; at
  authoring time the shared tree had uncommitted changes to
  `apps/agent/src/services/credential-usage-poller.{ts,test.ts}` from a
  concurrent session — leave them alone).
- Branch: `advisor/029-mx-gateway-helper`
- One commit, conventional style, message via file + `git commit -F`:
  `refactor(agent): extract shared mx-gateway passthrough helper (plan 029)`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 0: Baselines

Run the drift check from the header. Then capture the two baselines:

**Verify**:
`bun test apps/agent/src/routes/queue.test.ts apps/agent/src/routes/decisions.test.ts apps/agent/src/routes/requests.test.ts apps/agent/src/routes/capture.test.ts apps/agent/src/routes/decision.test.ts`
→ `23 pass, 0 fail` (if not, STOP — baseline drifted).

**Verify**: `cd apps/agent && bunx tsc --noEmit 2>&1 | tee /tmp/plan029-tsc-baseline.txt`
→ exactly the 2 `credentials.test.ts` TS2300 lines quoted in "Repo facts".
If there are other errors, STOP and report them.

### Step 1: Create `apps/agent/src/lib/mx-gateway.ts`

Create the file with exactly this content (it is the load-bearing artifact
of the plan — reproduce it, adjusting only if typecheck demands):

```ts
/**
 * Shared mx-gateway passthrough helpers.
 *
 * Eight agent routes proxy the mx gateway (cmd/mx-gateway, 127.0.0.1:8799).
 * Before this module each route re-derived the same skeleton: env-default
 * base URL, AbortController timeout, query-param allowlist forwarding, and
 * one of two failure postures. This module is the single copy of that
 * skeleton (plans/029-mx-gateway-passthrough-helper.md).
 *
 * Two postures, deliberately asymmetric:
 *  - gatewayGetFailSoft: read routes degrade to a per-route empty payload
 *    with status 200, so a down/slow/non-200 gateway renders as a graceful
 *    empty state in the clients instead of an error.
 *  - gatewayPostRelay: write routes relay the gateway status + body
 *    VERBATIM and map timeout/network failure to 504 — NEVER a fabricated
 *    success, because a swallowed capture/decision is silent data loss.
 */

import { logger } from "@nexus/core/node";

/** mx gateway base URL. Loopback on the homelab; override via env for tests. */
const GATEWAY_URL = process.env.MX_GATEWAY_URL ?? "http://127.0.0.1:8799";

/**
 * Bound every upstream fetch so a hung gateway can't stall a poll or POST.
 * Unified at 10s (plan-018 convention). /triage and /thread previously used
 * 12s — recorded decision in plan 029; bump HERE (one line) if their feeds
 * ever show abort warnings under real fan-out load.
 */
const FETCH_TIMEOUT_MS = 10_000;

export interface GatewayGetOptions {
  /** Gateway path to fetch, e.g. "/queue". Appended to the base URL. */
  path: string;
  /** Route label for structured logs, e.g. "/queue". */
  route: string;
  /** Pre-serialized fail-soft payload returned (status 200) on ANY failure. */
  emptyPayload: string;
  /** Incoming URL whose query params may be forwarded. */
  incomingUrl?: URL;
  /** Allowlist of query params copied verbatim when present (!== null). */
  forwardParams?: readonly string[];
}

function emptyResponse(payload: string): Response {
  return new Response(payload, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Fail-soft GET passthrough: gateway body verbatim, or the empty payload. */
export async function gatewayGetFailSoft(
  opts: GatewayGetOptions,
): Promise<Response> {
  const { path, route, emptyPayload, incomingUrl, forwardParams } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    // URL construction lives inside the try so a malformed MX_GATEWAY_URL
    // fail-softs to the empty payload rather than throwing past the catch.
    const upstreamUrl = new URL(`${GATEWAY_URL}${path}`);
    if (incomingUrl && forwardParams) {
      for (const key of forwardParams) {
        const value = incomingUrl.searchParams.get(key);
        if (value !== null) upstreamUrl.searchParams.set(key, value);
      }
    }

    const upstream = await fetch(upstreamUrl, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });

    if (!upstream.ok) {
      logger.warn(
        { route, upstreamStatus: upstream.status },
        "mx gateway returned non-200 — serving fail-soft empty payload",
      );
      return emptyResponse(emptyPayload);
    }

    // Passthrough: return the gateway body verbatim. Re-emit as a fresh
    // Response so we control the Content-Type + drop hop-by-hop headers.
    const body = await upstream.text();
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    logger.warn(
      { route, err },
      "mx gateway unreachable — serving fail-soft empty payload",
    );
    return emptyResponse(emptyPayload);
  } finally {
    clearTimeout(timer);
  }
}

export interface GatewayPostOptions {
  /** Gateway path to POST, e.g. "/capture". Appended to the base URL. */
  path: string;
  /** Route label for structured logs, e.g. "/capture". */
  route: string;
  /** Client body, forwarded verbatim as JSON. */
  body: string;
  /** `error` value of the 504 JSON body on timeout/network failure. */
  unreachableError: string;
  /** Extra structured-log fields (e.g. { id }). */
  logContext?: Record<string, unknown>;
}

/**
 * Verbatim POST relay: gateway status + body relayed as-is (2xx/4xx/5xx
 * alike); timeout/abort/network error maps to 504 — never a fabricated 200.
 */
export async function gatewayPostRelay(
  opts: GatewayPostOptions,
): Promise<Response> {
  const { path, route, body, unreachableError, logContext = {} } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const upstreamUrl = new URL(`${GATEWAY_URL}${path}`);

    const upstream = await fetch(upstreamUrl, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body,
    });

    // Relay the gateway status + body VERBATIM — 2xx, 4xx, and 5xx alike.
    // Re-emit as a fresh Response so we control the Content-Type + drop
    // hop-by-hop headers, but preserve the upstream status code.
    const upstreamBody = await upstream.text();
    if (!upstream.ok) {
      logger.warn(
        { route, upstreamStatus: upstream.status, ...logContext },
        "mx gateway returned non-2xx — relaying status verbatim",
      );
    }
    return new Response(upstreamBody, {
      status: upstream.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    // Timeout / abort / network error — map to 504. NEVER a fabricated 200:
    // a dropped write must be visibly unacknowledged so the caller retries.
    logger.warn(
      { route, err, ...logContext },
      "mx gateway unreachable — returning 504",
    );
    return new Response(JSON.stringify({ error: unreachableError }), {
      status: 504,
      headers: { "Content-Type": "application/json" },
    });
  } finally {
    clearTimeout(timer);
  }
}
```

**Verify**: `cd apps/agent && bunx tsc --noEmit 2>&1 | diff /tmp/plan029-tsc-baseline.txt -`
→ no new lines (exit 0 on the diff).

### Step 2: Create `apps/agent/src/lib/mx-gateway.test.ts`

Model the file structurally on `apps/agent/src/routes/queue.test.ts`:
stub the logger FIRST via `mock.module("@nexus/core/node", () => ({
...coreNode, logger: loggerMock }))` spreading the real barrel (nx-jlx1c —
`mock.module` is process-global), THEN import the SUT; stub
`globalThis.fetch` with a URL-capturing helper and restore it in
`afterEach` (copy the `stubFetch` helper from `queue.test.ts:34-49`).

Cover at minimum these 8 cases (one `it` each):

1. `gatewayGetFailSoft` forwards allowlisted params present on the incoming
   URL to `GATEWAY_URL + path` and returns the gateway body verbatim (200).
2. `gatewayGetFailSoft` omits allowlisted params absent from the incoming
   URL (`searchParams.has(key)` false upstream).
3. `gatewayGetFailSoft` forwards an empty-string param
   (`?source=` → upstream `source=""`) — pins decision 3.
4. `gatewayGetFailSoft` on upstream non-200 → status 200 + the exact
   `emptyPayload` string + `Content-Type: application/json`.
5. `gatewayGetFailSoft` on fetch throw (`ECONNREFUSED`) → status 200 + the
   exact `emptyPayload`.
6. `gatewayPostRelay` forwards the body verbatim via POST and relays an
   upstream 200 status + body verbatim.
7. `gatewayPostRelay` relays a non-2xx (e.g. 409) status + body verbatim
   (body NOT swallowed).
8. `gatewayPostRelay` on fetch throw → 504 with body
   `{ error: "<unreachableError>" }`.

**Verify**: `bun test apps/agent/src/lib/mx-gateway.test.ts`
→ `8 pass, 0 fail` (or more if you add cases).

### Step 3: Fold the near-verbatim trio — `queue.ts`, `decisions.ts`, `requests.ts`

For each file: keep the header docstring (lines 1-14ish) and the per-route
empty-payload constant; delete the local `GATEWAY_URL`, `FETCH_TIMEOUT_MS`,
`FORWARDED_PARAMS`, `emptyResponse()`, the `logger` import, and the whole
inline fetch skeleton; the handler becomes a thin call. Target shape for
`queue.ts` (repeat with the table values for the other two):

```ts
import { gatewayGetFailSoft } from "../lib/mx-gateway";

/** The fail-soft empty payload. */
const EMPTY_QUEUE = JSON.stringify({ items: [] });

export async function handleGetQueue(request: Request): Promise<Response> {
  return gatewayGetFailSoft({
    path: "/queue",
    route: "/queue",
    emptyPayload: EMPTY_QUEUE,
    incomingUrl: new URL(request.url),
    forwardParams: ["limit"],
  });
}
```

- `decisions.ts`: path/route `"/decisions"`, `const EMPTY_DECISIONS = "[]";`,
  `forwardParams: ["since", "action"]`. Keep the docstring NOTE about the
  bare-array shape.
- `requests.ts`: path/route `"/requests"`,
  `const EMPTY_REQUESTS = JSON.stringify({ requests: [] });`,
  `forwardParams: ["status", "source", "changed_since"]`.

Handler names, export style, and signatures are FROZEN (dispatcher +
tests import them by name).

**Verify**:
`bun test apps/agent/src/routes/queue.test.ts apps/agent/src/routes/decisions.test.ts apps/agent/src/routes/requests.test.ts`
→ `13 pass, 0 fail` (4 + 5 + 4 — the same tests that passed at baseline).

### Step 4: Fold `sources.ts`, `triage.ts`, `thread.ts`

Same treatment. Signature notes:

- `sources.ts`: `handleGetSources()` takes NO arguments — call the helper
  with no `incomingUrl`/`forwardParams`:
  `gatewayGetFailSoft({ path: "/sources", route: "/sources", emptyPayload: EMPTY_INDEX })`
  where `const EMPTY_INDEX = JSON.stringify({ sources: [], inbox: [] });`.
- `triage.ts`: `handleGetTriage(url: URL)` — pass `incomingUrl: url`,
  `forwardParams: ["source", "kind"]`, `const EMPTY_FEED = "[]";`. Keep the
  rich header docstring and the comment about case-insensitive `kind`
  matching; delete the local 12s constant (decision 1: now 10s via helper).
- `thread.ts`: `handleGetThread(url: URL)` — `incomingUrl: url`,
  `forwardParams: ["source", "id"]`,
  `const EMPTY_THREAD = '{"messages":[]}';`.

These three have no test suites; the gates are typecheck + grep.

**Verify**: `cd apps/agent && bunx tsc --noEmit 2>&1 | diff /tmp/plan029-tsc-baseline.txt -` → no new lines.
**Verify**: `grep -n "AbortController\|FETCH_TIMEOUT_MS\|MX_GATEWAY_URL" apps/agent/src/routes/sources.ts apps/agent/src/routes/triage.ts apps/agent/src/routes/thread.ts` → only docstring/comment prose hits at most; no `const GATEWAY_URL`, no `new AbortController` code lines.

### Step 5: Fold the POST relays — `capture.ts`, `decision.ts`

- `capture.ts`: keep the full header docstring (the NOT FAIL-SOFT rationale
  is contract documentation) and the body read; handler becomes:

```ts
export async function handlePostCapture(request: Request): Promise<Response> {
  // Read the client body once, forward it verbatim to the gateway.
  const body = await request.text();
  return gatewayPostRelay({
    path: "/capture",
    route: "/capture",
    body,
    unreachableError: "capture gateway unreachable",
  });
}
```

- `decision.ts`: keep `parseRequestId()` and the 400 malformed-path guard
  exactly as-is (`decision.ts:27-41`); after the body read, call:

```ts
  return gatewayPostRelay({
    path: `/requests/${encodeURIComponent(id)}/decision`,
    route: "/requests/:id/decision",
    body,
    unreachableError: "decision gateway unreachable",
    logContext: { id },
  });
```

The two `unreachableError` strings are pinned by
`capture.test.ts:103` — copy them EXACTLY.

**Verify**:
`bun test apps/agent/src/routes/capture.test.ts apps/agent/src/routes/decision.test.ts`
→ `10 pass, 0 fail` (same tests as baseline).

### Step 6: Final gates

**Verify** (all must hold):

1. `bun test apps/agent/src/routes/queue.test.ts apps/agent/src/routes/decisions.test.ts apps/agent/src/routes/requests.test.ts apps/agent/src/routes/capture.test.ts apps/agent/src/routes/decision.test.ts apps/agent/src/lib/mx-gateway.test.ts`
   → `31 pass, 0 fail` (23 baseline + 8 new; more if you added cases).
2. `grep -rn "process.env.MX_GATEWAY_URL" apps/agent/src --include="*.ts" | grep -v "\.test\.ts"`
   → exactly 1 line, in `apps/agent/src/lib/mx-gateway.ts`.
3. `grep -rln "new AbortController" apps/agent/src/routes/queue.ts apps/agent/src/routes/decisions.ts apps/agent/src/routes/requests.ts apps/agent/src/routes/capture.ts apps/agent/src/routes/decision.ts apps/agent/src/routes/sources.ts apps/agent/src/routes/triage.ts apps/agent/src/routes/thread.ts`
   → no output.
4. `cd apps/agent && bunx tsc --noEmit 2>&1 | diff /tmp/plan029-tsc-baseline.txt -` → exit 0.
5. `pnpm --filter @nexus/agent lint` → exit 0, `0 errors` (warning count may
   DROP below 46 — removed unused imports — but must not gain new warnings
   in the 10 in-scope files).
6. `git status --porcelain` → only the 10 in-scope source files +
   `plans/README.md` modified/added (ignore the pre-existing
   `credential-usage-poller` and `.beads/` modifications if executing in the
   shared tree — but you should be in a worktree).

Then commit (message file + `git commit -F`, see Git workflow).

## Test plan

- New file `apps/agent/src/lib/mx-gateway.test.ts` — 8 cases listed in
  Step 2, structurally modeled on `apps/agent/src/routes/queue.test.ts`
  (logger `mock.module` barrel-spread first, `stubFetch` capture helper,
  `afterEach` fetch restore).
- The 5 existing suites (23 tests) are the refactor's regression harness and
  must pass UNMODIFIED.
- Verification: the Step 6 combined run → `31 pass, 0 fail`.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] Step 6 command 1 → `31 pass, 0 fail` (or documented higher count)
- [ ] Step 6 command 2 → exactly 1 non-test `process.env.MX_GATEWAY_URL` site (`lib/mx-gateway.ts`)
- [ ] Step 6 command 3 → zero `new AbortController` in the 8 route files
- [ ] Step 6 command 4 → zero new typecheck errors vs baseline
- [ ] Step 6 command 5 → lint 0 errors
- [ ] The 5 existing test files are byte-identical to baseline (`git diff --stat -- 'apps/agent/src/routes/*.test.ts'` shows nothing)
- [ ] `plans/README.md` row for 029 updated, with `spec-impact: <slug>` or `spec-impact: none` appended

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check shows any in-scope file changed AND its live code no
  longer matches the "Current state" excerpts (Leo commits to main directly;
  another session may have refactored a route).
- The Step 0 baseline is not `23 pass, 0 fail`, or agent `tsc --noEmit`
  shows errors beyond the 2 quoted `credentials.test.ts` TS2300 lines.
- Any of the 5 existing suites fails after a step and one reasonable fix
  attempt — do NOT edit the test files to make them pass.
- You find a 9th non-test consumer of `process.env.MX_GATEWAY_URL` (the
  grep in "Commands" returns more than the 8 route files + your new helper).
- Preserving a handler signature appears impossible without touching
  `server-request-handler.ts`.
- You are tempted to change any response shape, status code, or the two
  pinned 504 error strings — that is a route-semantics change, out of scope.

## Maintenance notes

- **Timeout watch (the one deliberate behavior change)**: `/triage` and
  `/thread` moved 12s → 10s. After the next agent deploy, if
  `journalctl --user -u nexus-agent` shows new
  `"mx gateway unreachable — serving fail-soft empty payload"` warnings with
  `route: "/triage"` or `"/thread"` that correlate with abort errors (not
  gateway downtime), bump `FETCH_TIMEOUT_MS` in
  `apps/agent/src/lib/mx-gateway.ts` — one line now fixes all 8 routes.
- **Reviewer focus**: (a) the 5 untouched test suites passing is the main
  correctness signal; (b) confirm `decision.ts` kept its 400 guard and
  `encodeURIComponent(id)`; (c) confirm the per-route empty payloads were
  not accidentally swapped between routes (queue `{items:[]}` vs requests
  `{requests:[]}` vs sources `{sources:[],inbox:[]}`).
- **Future gateway routes** must call `gatewayGetFailSoft` /
  `gatewayPostRelay` instead of cloning the skeleton — point PR reviewers at
  this helper when a new `MX_GATEWAY_URL` read appears in a route file (the
  Step 6 grep is re-runnable as a review check).
- **Deferred, deliberately**: route-level test suites for `sources.ts`,
  `triage.ts`, `thread.ts` (their bodies are now ~10-line wrappers over
  tested shared logic; a dedicated suite per wrapper is low-value — revisit
  only if a wrapper grows route-specific logic). Also deferred: any retry or
  circuit-breaker behavior — out of this plan's contract.
