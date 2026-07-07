# Repo Context: jordanhindo/beadboard

> Source: https://github.com/jordanhindo/beadboard (canonical upstream: zenchantlive/beadboard)
> Context: project (nx) · Stars: 53 · Last push: 2026-03-29 · License: MIT · Language: TypeScript

## Purpose

"Multi-agent orchestration and communication system built on Beads." A Next.js 15 local
dashboard + `bb` CLI + embedded Pi worker runtime that reads a repo's `.beads/` store and renders
an agent-first ops console (Social / Graph / Activity / Swarm lenses). Built on the SAME issue
tracker nx uses (`bd`), inspired by Steve Yegge's Gastown.

This is the single most directly-relevant external repo for nx: an independent, more-mature answer
to the exact question nx is asking ("build the bread-and-butter bead-tracking surface"). Headline:
it solves bead visualization/coordination extremely well but has **ZERO openspec/proposal/roadmap
awareness** — that is precisely nx's differentiation gap to exploit, not steal.

## Architecture & Key Patterns

### Dual read path: Dolt SQL (primary) -> JSONL (fallback)

- **Source of truth**: `.beads/issues.jsonl`, mutated ONLY via the `bd` CLI — never written directly.
- **Primary read**: `readIssuesViaDolt()` (`src/lib/read-issues-dolt.ts`) connects to a local
  Dolt (version-controlled MySQL-wire SQL) and runs the whole graph in two flat queries (issues
  with `GROUP_CONCAT` labels + comments subquery; all dependencies in one shot), building an
  `issue_id -> BeadDependency[]` map in memory. Deliberately N+1-free.
- **Fallback**: returns `null` (never throws) on any Dolt failure -> caller drops to parsing
  `issues.jsonl` directly (`parseIssuesJsonl`, `src/lib/parser.ts`).
- **Discovery**: `.beads/metadata.json` for `dolt_database` + `dolt_server_port`, preferring a
  `.beads/dolt-server.port` file. Pools cached per project root; connection verified before cache.

```ts
// read-issues-dolt.ts — whole-graph-in-two-queries
const [issueRows] = await pool.execute(
  `SELECT i.*, GROUP_CONCAT(l.label SEPARATOR ',') AS labels_concat,
          (SELECT COUNT(*) FROM comments c WHERE c.issue_id = i.id) AS comments_count
   FROM issues i LEFT JOIN labels l ON l.issue_id = i.id GROUP BY i.id`);
const [depRows] = await pool.execute(`SELECT issue_id, depends_on_id, type FROM dependencies`);
```

### Canonical `BeadIssue` type (`src/lib/types.ts`)

```ts
BEAD_STATUSES        = ['open','in_progress','blocked','deferred','closed','tombstone','pinned','hooked']
BEAD_DEPENDENCY_TYPES= ['blocks','parent','relates_to','duplicates','supersedes','replies_to']
CORE_ISSUE_TYPES     = ['task','bug','feature','epic','chore']
```

`priority:number` (0-4), `dependencies:{type,target}[]`, `metadata:Record<string,unknown>` (untyped
escape hatch — acceptance criteria live here), plus agent-overlay fields
`agentTypeId`/`agentInstanceId`/`closed_by_session`. Parser normalizes legacy `parent-child` ->
`parent` and `depends_on_id` -> `target`.

**Novel decision**: agent identities are themselves beads (labeled `gt:agent`), filtered out of
mission lists at parse time. Agents, mail threads, memory — everything is a bead.

### Coordination-as-audit-log

`src/lib/coord-events.ts` + `coord-schema.ts`: inter-agent coordination
(SEND/READ/ACK/RESERVE/RELEASE/TAKEOVER/RESUME/BLOCKED/HANDOFF/INCURSION) is a versioned envelope
(`coord.v1`) written via `bd audit record --stdin`. No side store — it rides the beads history so
Dolt versioning covers it for free.

### Realtime: file-watch -> SSE (no daemon push)

`bd` touches `.beads/last-touched` -> Chokidar (`IssuesWatchManager`) -> `ProjectEventCoalescer`
-> `IssuesEventBus` singleton -> SSE endpoint -> browser. Snapshot-diffing computes per-issue changes.

### Board/Kanban model (`src/lib/kanban.ts` — the crown jewel)

Four lanes, DERIVED not stored: `['ready','in_progress','blocked','closed']`.

- `deriveBlockedIds(issues)` — an issue is blocked if any `blocks`-dep target isn't `closed`
  (computed blocked-ness on top of explicit `blocked` status). `laneForIssue()` precedence:
  closed -> blocked(explicit OR derived) -> in_progress(incl "review") -> ready.
- Epics hidden from the `ready` lane.
- `pickNextActionableIssue()` — ranks ready by priority -> **unblocks-count** (how many beads this
  one frees, via `buildUnblocksCountByIssue`) -> recency -> id. Genuinely good "what next" heuristic.
- `buildExecutionChecklist(issue)` — per-bead readiness gate: owner assigned / no open blockers /
  has acceptance-or-description signal / execution-compatible status. Rendered as a card checklist.
- `buildBlockedByTree()` — bounded BFS up the blocker chain for a "why is this blocked" drill-down.

**Social lens** (`social-cards.ts`): bidirectional dependency arrows — `blocks[]` vs `unblocks[]` —
with an "effective status" overriding `ready`->`blocked` when incoming blockers unresolved.

**Graph lens** (`epic-graph.ts` + `smart-dag.tsx`): `@xyflow/react` + Dagre.
`buildWorkflowEdges()` does focus-aware dependency tracing — BFS upstream blockers + downstream
blocked, tagging each edge `isUpstreamOfFocus`/`isDownstreamOfFocus`/`isDirectlyFocused`/
`isUnrelated` for dimming. `collectEpicDescendantIds()` walks `parent` edges for an epic subtree.

### Relation model

`blocks` (execution ordering, load-bearing) · `parent` (epic hierarchy, `beadboard-<epic>.x.x`
naming; orphan tasks hidden from nav) · `relates_to`/`duplicates`/`supersedes`/`replies_to`.
`supersede` powers a bead-native memory system (canonical "decision" beads, `mem-canonical`,
append-only history). Swarm membership is a label (`swarm:<epicId>`), single-membership enforced.

### Tech stack

Next.js 15 (App Router) · React 19 · Tailwind + Radix + shadcn/ui + Framer Motion · `@xyflow/react`
12 + `dagre` · **Dolt** (MySQL wire via `mysql2`) w/ JSONL fallback · `chokidar` 5 + SSE ·
`@mariozechner/pi-coding-agent` (`bb-pi`, "under construction") · `remotion` · Node native test runner.

### Novel terminology

`bb-pi` · `gt:agent` · **archetypes** (architect/engineer/reviewer/tester/investigator/shipper) ·
**templates** (feature-dev/bug-fix/full-squad/greenfield/research-and-discovery) · **reservations**
(TTL scope locks, liveness-aware takeover) · **INCURSION** · **"Landing the Plane"** ·
**mem-canonical / domain anchors** · `beadboard-driver` (agent operating-contract skill).

## OpenSpec / Proposal / Roadmap awareness — ABSENT (the key gap)

`openspec` = 0 code hits. `proposal` = 3 incidental prose hits. `roadmap` exists only as static
markdown under `docs/plans/*.md` — hand-authored, not machine-linked. No change-proposal lifecycle
linked to beads, no spec->bead traceability, no rendered/queryable roadmap surface. This is exactly
nx's stated differentiation. BeadBoard proves the bead-visualization half is a solved, polished
problem; nx's novel contribution is the **openspec x bead x roadmap join**.

## Prior Coverage

None found — no prior `docs/recon/beadboard.*`, no archived openspec change, no matching bead.

## Discovery Metadata

- Context: project
- Project: @nexus/root (nx)
- Path: /home/nyaptor/dev/nx
- Timestamp: 2026-07-07T12:41:45Z
