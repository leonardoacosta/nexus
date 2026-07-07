# Repo Context: w3dev33/beads-task-issue-tracker

> Source: https://github.com/w3dev33/beads-task-issue-tracker
> Context: project (nx) · Stars: 58 · Last push: 2026-05-04 · License: MIT · Language: Vue + Rust
> Status: MAINTENANCE/FROZEN — successor is PaiR (v0.26.0, closed-source). v1.24.4.

## Purpose

A native desktop *control panel* for the Beads (`bd`) AI-native issue tracker. It does NOT own the
data — the `bd`/`br` CLI writes `.beads/`, and this app reads/renders it for humans. Philosophy:
"a human window into AI-piloted work... a control panel, not a workspace."

**Caveat:** `.claude/codebase-map.md` describes a rich `src-tauri/src/tracker/` built-in SQLite
engine (12 modules, FTS5, git sync, conflict resolution). **That directory is NOT in the published
tree** — only `src-tauri/src/lib.rs` (~5274 lines) + `main.rs`. The map is partly aspirational. The
shipped persistence path is: **shell out to the `bd`/`br` CLI** (+ a Nuxt `server/api/bd/*`
browser-fallback via `server/utils/bd-executor.ts`). Treat SQLite-engine descriptions as design
intent, not verified code.

## Architecture & Key Patterns

### Enums (`app/types/issue.ts`) — verified

```ts
type IssueType     = 'bug'|'task'|'feature'|'epic'|'chore'
type IssueStatus   = 'open'|'in_progress'|'blocked'|'closed'|'deferred'|'tombstone'|'pinned'|'hooked'
type IssuePriority = 'p0'|'p1'|'p2'|'p3'|'p4'   // stored int 0..4 via priorityToNumber
```

Extended statuses (`deferred`/`pinned`/`hooked`/`tombstone`) come straight from Beads. `tombstone`
= soft-deleted, filtered from default view. The app mirrors whatever the CLI emits.

### `Issue.specId` — the one openspec-relevant hook

```ts
interface Issue { id, title, description, type, status, priority, assignee?, labels[],
  createdAt, updatedAt, closedAt?, comments[], blockedBy?[], blocks?[], externalRef?,
  estimateMinutes?, designNotes?, acceptanceCriteria?, workingNotes?, parent?, children?[],
  relations?[], metadata?, specId?, ... }
```

`specId` is a **first-class Beads CLI field**, not an app invention — round-trips as a `--spec-id` flag:

```rust
// src-tauri/src/lib.rs ~2652 (create) / ~2727 (update)
if let Some(ref spec_id) = payload.spec_id {
    if !spec_id.is_empty() { args.push("--spec-id".into()); args.push(spec_id.clone()); }
}
```

UI surfaces it as free text (`IssueForm.vue:363`, placeholder `"e.g. SPEC-001"`) + a read-only
"Spec ID" section (`IssuePreview.vue:886-905`, mono text). **It is an opaque string: zero linkage
to spec content, no parsing, no navigation, no validation.** The closest thing to "proposal
awareness" in the whole repo, and it is essentially just a labeled text box.

### Dependency / relation model (`lib.rs`) — verified

Beads models everything as a typed dependency edge; the app splits them into three buckets:
- `blocks` -> `blockedBy[]`/`blocks[]` (hard blockers)
- `parent-child` -> epic hierarchy (children from `dependents` where `dependency_type=="parent-child"`)
- everything else -> soft `relations[]`

```rust
let structural_types = ["blocks", "parent-child"];  // lib.rs ~485
```

Relation types are hardcoded + client-adaptive (`bd_available_relation_types`): `relates-to`,
`discovered-from`, `duplicates`, `supersedes`, ... (differs `bd` vs `br`).

### Epic hierarchy — dot-notation IDs (elegant, verified)

No separate parent field for `bd >= 0.50`: child IDs are `parent.N`. Pure derivation:

```ts
// app/utils/issue-helpers.ts
export function getParentIdFromIssue(issue: Issue): string | null {
  if (issue.parent?.id) return issue.parent.id
  const i = issue.id.lastIndexOf('.')               // "abc.1" -> "abc"
  if (i === -1) return null
  const suffix = issue.id.slice(i + 1)
  return /^\d+$/.test(suffix) ? issue.id.slice(0, i) : null
}
```

`groupIssues()` builds epic groups in-sort-order, absorbs visible children, and computes an inline
progress ratio (`closedChildCount / childCount`) + surfaces the `in_progress` child — driving
collapsible epic rows with progress bars.

### Persistence

Source of truth `.beads/` (SQLite `beads.db` + JSONL), owned by CLI. App is read-mostly, mutates
via CLI subprocess. Attachments: app-invented `.beads/attachments/{issue-id}/` convention with
path-traversal guards (canonicalize + assert inside dir). No app-owned DB in the shipped tree.

### UI model — three-panel control panel (NO board)

`app/pages/index.vue` (~1250 lines, kept thin; logic extracted to composables):
- **Left**: filesystem project picker (`.beads`/Dolt badges) + dashboard (KPI cards, status/priority
  pie charts, ready/pinned quick lists).
- **Center**: issue **table** — `@tanstack/vue-table`, sortable, epic grouping, multi-select + bulk
  delete, load-more, per-project column config.
- **Right**: issue detail/preview/edit sheet, independently collapsible sections (incl. spec id),
  image/markdown gallery.

No Kanban board — explicit non-feature.

### Filtering (`filterIssues`) — worth stealing

Dual model: inclusion (`useFilters`) + exclusion/inverse (`useExclusionFilters`). Search
short-circuits all other filters. Default view auto-excludes `closed`+`tombstone`. Labels OR-logic.
All filter state per-project (localStorage, DJB2 path hash: `beads:proj:{hash}:{key}`). "Smart
short IDs" hide the common prefix.

### Live updates — standout UX

`useChangeDetection` + native Rust file watcher (`notify` crate) on `.beads/` -> Tauri
`beads-changed` event (1s debounce). `useAdaptivePolling` safety net: **5s active / 30s blurred /
60s idle / paused-when-hidden**, gated by a cheap **mtime check** (`bd_check_changed`, no CLI call)
before expensive `bd_poll_data`. Explicitly to track AI agents mutating issues in real time.

### Concurrency guards (relevant to nx's Bun daemon)

Per-project **mutex** (`BD_PROJECT_LOCKS`) serializes all CLI calls per project (prevents concurrent
Dolt embedded-access SIGSEGV) + a **10s sync cooldown** (`LAST_SYNC_TIME`).

### Issue lifecycle

Thin wrappers over CLI verbs: `bd create ... --spec-id`, `bd update <id> --status in_progress`
(claim), `bd close <id>` (always confirmed), `bd dep add/remove`, `bd delete <id> --force --hard`.
Sentinel `cleared:{id}` for clearing unique-constrained optional fields (SQLite UNIQUE workaround).

### Tech stack

Tauri 2 (Rust) shell · Nuxt 4 (Vue 3, SSR off, hash router) TS · shadcn-vue (reka-ui) + Tailwind 4
+ `@tanstack/vue-table` + `sortablejs` + `markdown-it`/`dompurify` · Rust: tauri 2.9, `notify` 7,
`rusqlite` (bundled) · Vitest + jsdom (214 unit tests), pure-logic-in-utils architecture.

### Novel terminology

"probe" (dev-only metrics SSE) · "tombstone" (soft-delete) · "landing the plane" (session-completion
ritual) · "CLI-follower" philosophy (freeze if CLI goes machine-only).

## OpenSpec / Proposal / Roadmap awareness — effectively ABSENT

Only artifact is the opaque `specId` string (a labeled text box round-tripped as `--spec-id`) — no
spec content, parsing, linking, status rollup, or roadmap surface. No `openspec/`, no proposal
model, no roadmap/milestone view. **This is nx's greenfield** — no prior art to steal.

## Prior Coverage

None found — no prior `docs/recon/beads-task-issue-tracker.*`, no archived change, no matching bead.

## Discovery Metadata

- Context: project
- Project: @nexus/root (nx)
- Path: /home/nyaptor/dev/nx
- Timestamp: 2026-07-07T12:41:45Z
