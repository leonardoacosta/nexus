# Design: Mechanize route-registry parity

## Section: Fail-mode inventory (for task 1.2)

`apps/agent/src/server-request-handler.ts` currently repeats one wrapper 57 times:
`.then((r) => withCors(request, r)).catch((err) => { logger.error({ route, method, err },
"route handler failed"); return withCors(request, new Response(<body>, { status: <n>, headers:
{...} })) })`. The shared helper (e.g. `dispatchRoute(routeLabel, request, handlerPromise,
failMode)`) MUST reproduce every current `(status, body, Content-Type)` triple exactly. Enumerate
before converting — do not infer from category alone:

- **Default 500** (~54 routes, the majority): `status: 500`, body
  `JSON.stringify({ error: "internal error" })`, `Content-Type: application/json`.
- **Fail-soft 200** (route-specific empty body, never 500 on a caught error):
  - `/beads/unlinked` -> `{"unlinked":[]}`
  - `/roadmap` -> `{"capabilities":[]}`
  - `/sources` -> `{"sources":[],"inbox":[]}`
  - `/requests` -> `{"requests":[]}`
  - `/queue` -> `{"items":[]}`
  - `/decisions` -> `[]`
  - `/triage` -> `"[]"` (plain string body, not `JSON.stringify([])` — same bytes, check the
    literal at line ~934)
  - `/thread` -> `'{"messages":[]}'`
- **Fail-loud 502** (explicit "NOT fail-soft" comments in source — a caught error must surface,
  never fabricate success): `/requests/:id/decision`, `/capture`, `/paste`. All three use
  `status: 502`, body `JSON.stringify({ error: "internal error" })`.

Pass the fail mode as an explicit argument at each call site (status + body + whether the
Content-Type header is set) rather than inferring it from the route path inside the helper — the
helper should be a pure wrapper, not a second place that encodes per-route knowledge.

## Section: Parity test design (for task 1.3)

`apps/agent/src/server-request-handler-route-parity.test.ts` statically parses the source text of
`server-request-handler.ts` (read via `fs.readFileSync`, not a runtime route table — the
dispatcher has no such table) to build the actual set of dispatched `{ method, path }` pairs, then
asserts it is exactly equal to `LEGACY_DISPATCH_ROUTES` (both directions — no extra entries in
either set).

Two route shapes to extract:

1. **Exact-match routes** (the majority): `if (url.pathname === "<literal>" && request.method ===
   "<METHOD>")`. A single regex over the source text captures both groups directly.
2. **Regex-parameterised routes** (a small, enumerable set — `/sessions/:id`, `/sessions/:id/context`,
   `/projects/:id`, `/projects/:id/git-events`, `/projects/:code/pulse`, `/notifications/voices/:project`,
   `/notifications/:id/audio`, `/credentials/:id/release`, `/credentials/:id/report-rate-limit`,
   `/credentials/:id/health`, `/integrations/:provider/credentials(/test)?`, `/agents/:id`,
   `/requests/:id/decision`, `/project/:code/status|beads|git|specs|run`,
   `/specs/:project/:name/:file|sessions|status`, `/notifications/voices/:project`): these are
   matched via a `const xMatch = url.pathname.match(/^\/foo\/([^/]+)$/)` assignment followed by
   `if (xMatch && request.method === "...")`. Map each regex-match variable to its documented
   `:param`-style path via a small hardcoded lookup table in the test (there are ~15, not worth a
   generic regex-to-path-template parser).

On mismatch, fail with the specific missing/extra route names (`expect(actual).toEqual(expected)`
with both sorted, or a manual diff + `throw`), not a bare "sets differ" assertion — the whole
point of this test is a fast, legible diagnosis the next time a route is added without updating
the array.

Verification during authoring: temporarily comment out one `LEGACY_DISPATCH_ROUTES` entry, confirm
the test fails and names that entry, then restore it — proves the test actually detects drift
rather than trivially passing.
