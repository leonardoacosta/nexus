# Plan 063: Pure-fs spec detail route; delete the dead `openspec approve/reject/status` handlers

> **Executor instructions**: Follow this plan step by step, run every
> verification command, honor STOP conditions, and update this plan's row in
> `plans/README.md` when done.
>
> **Drift check (run first)**:
> `git diff --stat 4bb98069..HEAD -- apps/agent/src/routes/specs.ts apps/agent/src/server-routes-specs.ts apps/agent/src/routes/specs/ apps/agent/src/services/spec-watcher/fs-snapshot.ts`
> On structural mismatch with the excerpts, STOP.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MEDIUM — the detail route's wire shape feeds the Swift detail pane; the contract test + Swift decode reads below de-risk it
- **Depends on**: none. Do BEFORE plan 068 (OPSX upgrade) — this removes the daemon's dependence on CLI output shapes.
- **Category**: correctness
- **Planned at**: commit `4bb98069`, 2026-07-19

## Why this matters

Two related defects in `apps/agent/src/routes/specs.ts`:

1. **The detail route depends on a CLI that is absent on the deployed
   host.** `handleGetSpec` (excerpt below) spawns `openspec show <name>
   --json`. The spec-watcher poller's own docstring
   (`services/spec-watcher/poller.ts:11-21`) records that on homelab the
   `openspec` binary is NOT installed ("command not found") and that the
   LIST path was therefore migrated to a pure-fs scan — but the detail
   path never was. Result: `GET /specs/:project/:name` 404s for every spec
   on homelab; the Swift detail pane is broken exactly where the
   dashboards run.
2. **Four handlers spawn subcommands that do not exist in ANY openspec
   version.** `handleApproveSpec` → `openspec approve` (specs.ts:333),
   `handleRejectSpec` → `openspec reject` (:373-378), `handleReadSpec` and
   `handleSpecStatus` → `openspec status --json` (:411, :540). The repo's
   own `openspec/AGENTS.md` "CLI Essentials" lists the real surface:
   `list / show / validate / archive` (plus init/update). These handlers
   have always failed. Real approval already works via a parallel
   mechanism: `PATCH /specs/:p/:n/status` in
   `routes/specs/handlers-status.ts`, which splices
   `status/approved-by/approved-at` frontmatter into proposal.md.

Also ride-along: `specs.ts:6-10` claims "Mirrors the Rust agent's spec
handlers … delegate to the Rust agent's SQLite-backed NexusDb" — the Rust
agent was retired 2026-04; this misleads every maintainer entering the file.

## Current state — verified excerpts (at 4bb98069)

`specs.ts:209-227` (the CLI-dependent detail path):

```ts
  const result = await runOpenspec(["show", name, "--json"], proj.path);
  if (!result.ok) {
    return new Response(
      JSON.stringify({ error: `spec ${project}/${name} not found` }), ...
  const frontmatter = await readProposalFrontmatter(proj.path, name);
  const beadRollup = await computeBeadRollup(proj.path, name, cachedRollupBeadSource);
```

Dead-handler dispatch wiring: `server-routes-specs.ts:77,85,93,101`
(approve/reject/read/status) and `:152` (detail). Pure-fs building blocks
that already exist: `parseSpecFromPath` (`spec-watcher/fs-snapshot.ts:74` —
status + task counts from the dir), `handleGetSpecContent` (`specs.ts:461`
— serves proposal.md/design.md/tasks.md via readFile after strict
validation), `readProposalFrontmatter` (`specs.ts:247+`).

## Steps

### Step 1 — Pin the detail wire contract BEFORE changing anything

Read, in order: `routes/specs.test.ts` + `specs-payload-completeness.test.ts`
(what fields the detail response asserts); the Swift decoder — grep
`apps/swift/NexusShared` for the model decoding `GET /specs/:p/:n`
(start from `SpecSummary.swift` and `NexusClient.swift`'s spec-detail
call). Write down the exact field set the client consumes. If the Swift
decode requires fields ONLY `openspec show --json` can produce (e.g. parsed
delta ASTs) and the fs sources cannot supply them, STOP and report the
field list.

### Step 2 — Rebuild `handleGetSpec` on fs sources

Compose the response from: `parseSpecFromPath` (status,
completed/total tasks), `readProposalFrontmatter` (unchanged),
`computeBeadRollup` (unchanged), plus whatever raw content fields Step 1
proved the client uses (serve them the way `handleGetSpecContent` reads
files). Preserve the wire shape byte-compatibly for every field Step 1
listed; drop `runOpenspec` from this path entirely. Keep the 404-on-missing
behavior (dir absent under `openspec/changes/` AND `archive/*-<name>` — use
`session-spec-link.ts`'s `resolveSpecDir` if it is exported, else mirror
its live-then-archive resolution).

Verification: `bun test apps/agent/src/routes/specs.test.ts apps/agent/src/routes/specs-payload-completeness.test.ts` → 0 fail.

### Step 3 — Delete the dead handlers

Remove `handleApproveSpec`, `handleRejectSpec`, `handleReadSpec`,
`handleSpecStatus` from `specs.ts` and their dispatch blocks in
`server-routes-specs.ts` (:77-101 region) — FIRST confirming no live
client calls them: grep `apps/swift` and `apps/web/src` for the route
paths (`/approve`, `/reject`, `/read`, and GET `.../status`). Expected:
Swift approval uses the PATCH mechanism (verify by finding the PATCH call
in NexusClient). If any client DOES call a dead route, STOP and report
which — the fix then becomes re-pointing that client to PATCH, a scope
expansion needing maintainer sign-off. Also remove `runOpenspec` itself if
Step 2 left no remaining callers in the file.

If `LEGACY_DISPATCH_ROUTES` (or the `mechanize-route-registry-parity`
proposal's registry, if landed) lists these routes, remove the entries in
the same commit — and if the parity test from that proposal exists, it MUST
pass.

### Step 4 — Fix the header docstring

Rewrite `specs.ts:1-15` to describe reality: pure-fs reads over
`openspec/changes/`, frontmatter-PATCH approval, bead rollup via the cached
source. Delete every Rust/SQLite/NexusDb sentence.

### Step 5 — Full sweep

```
bun test apps/agent/src/routes/ apps/agent/src/services/spec-watcher/
pnpm --filter @nexus/agent typecheck
```

Expected: no new failures vs pre-Step-1 baseline; typecheck clean on
touched files.

## Done criteria (machine-checkable)

- `grep -c "runOpenspec(\[\"show\"\|approve\|reject\|\"status\"" apps/agent/src/routes/specs.ts` → 0 (no CLI spawns remain in this file; if Step 2 kept `runOpenspec` for some verified-real subcommand, document why — expected count is 0).
- `grep -c "Rust agent\|NexusDb" apps/agent/src/routes/specs.ts` → 0.
- Detail-route tests green INCLUDING a new test that runs with PATH stripped of any `openspec` binary (prove the fs path needs no CLI).
- Swift-called route inventory from Step 3 recorded in the report.

## Out of scope — do not touch

- `handlers-status.ts` (the PATCH approval mechanism — it is the survivor,
  not a target).
- spec-watcher poller/watcher (plan 064).
- `handleGetSpecContent`, list routes (already pure-fs).
- Installing the openspec CLI anywhere (plan 066).

## STOP conditions

- Step 1 field-gap or Step 3 live-caller discoveries (as written above).
- If `resolveSpecDir` semantics differ from what the detail 404 contract
  needs (archived specs: should detail serve them? read the current
  behavior — CLI-missing means today's de-facto behavior on homelab is
  "always 404", so match the TEST suite's expectation, and report if tests
  and Swift disagree).

## Maintenance notes

- After this plan, the agent's ONLY openspec-CLI dependency is the watcher
  fast-path (plan 064 removes it) — after both, the daemon is CLI-free and
  plan 068's tool upgrade cannot break it.
- Any future spec route must start from fs primitives
  (`parseSpecFromPath`/`readFile`), never a CLI spawn on the request path.
