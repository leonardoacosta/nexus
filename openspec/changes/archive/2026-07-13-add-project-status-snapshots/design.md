# Design: add-project-status-snapshots

## Decisions

### Beads change signal: filesystem watch, not CC hooks, not bd polling

- No CC hook is bead-shaped (verified against cc's settings.json hook inventory —
  `session-closer` is session-granular and does not emit to nexus). A `PostToolUse` Bash
  matcher on `bd ` would be fragile (RTK rewrite class) and requires cc-side changes.
- `bd`'s `export.auto` rewrites `.beads/issues.jsonl` on every mutation — a durable, local,
  no-cc-changes-needed signal.
- Watch the PARENT directory (`.beads/`) filtered to `issues.jsonl`: auto-export renames a temp
  file over the target, which kills single-file inotify watches. This is the exact nx-6uzqi
  lesson already encoded in `apps/agent/src/credentials/active-credential-watcher.ts:350-466` —
  reuse that shape (dir watch + filename filter + debounce + AbortController) rather than
  inventing a new one.
- Unconditional 60s poll fallback mirrors both the credential watcher and spec-watcher; fs
  events are an optimization, never the only path.

### Counting from JSONL, zero bd calls

- `bd list` costs ~2s per invocation and the agent's systemd sandbox breaks `bd`/`openspec`
  shell-outs in prod (ReadOnlyPaths on the dolt lock + mise PATH — see
  reference_agent_systemd_sandbox). Parsing `issues.jsonl` directly avoids both.
- Ready = status open with no open blocking dependencies; blocked = open with at least one open
  blocker (or explicit blocked status). Unlinked = not referenced by any unarchived proposal's
  beads markers — reuse `services/bead-rollup.ts`'s marker parsing for linkage, so there is one
  definition of "linked".
- Parity with the live `beads-unlinked` route is a spec requirement with a fixture test; the
  JSONL path must not drift into its own semantics.
- Fail-open on parse errors (truncated mid-write, bad line): keep previous counts, log, skip
  snapshot/event — same posture as `config-watcher.ts`.

### Storage: Postgres time-series, not the session-context TTL map

- `add-session-context-api` chose an in-memory TTL store explicitly because it has no history
  requirement. This capability's whole point is history (trends, velocity), so it takes
  session-context's route/contract conventions but the `spec_sessions`/retention persistence
  shape.
- Two tables: `spec_snapshots` (per-spec completed/total — revives the committed
  spec-timeseries requirement on Postgres) and `project_status_snapshots` (per-project
  aggregate). Change-only inserts keep both tables small; 90d retention matches
  `cron_runs`/`bloat_radar` (one cutoff const + one delete in `retention.ts`).
- Project identity: `project` text column (project name), consistent with `spec_sessions` and
  the spec-watcher's project keying — not the `projects` uuid, to keep the watcher path free of
  registry joins.

### Event: BeadTransition, symmetric with SpecTransition

- New `LifecycleEventMap` entry + payload interface in `lifecycle-bus.ts`; emitted only on
  count change (the change-only snapshot comparison doubles as the emission gate). Existing SSE
  endpoint exposes it for free; NexusShared gets a minimal Codable model + observer wiring so
  Swift dashboards can update live without polling.

### Data flow

```
bd mutation -> export.auto rewrites .beads/issues.jsonl
  -> beads-watcher (dir watch, 300ms debounce; 60s poll fallback)
     -> JSONL parse -> unlinked ready/blocked counts
        -> status-snapshots writer (compare vs latest row)
           -> insert project_status_snapshots row (change only)
           -> lifecycleBus.emit BeadTransition (change only)

spec-watcher tick/refresh (existing)
  -> per-spec counts -> spec_snapshots (change only)
  -> proposals_unarchived -> status-snapshots writer (same compare/insert path)

GET /projects/:id/status[?history=days] -> latest row | time series
```

## Alternatives rejected

- CC hooks as the change signal — requires cc-side work, misses non-CC bd mutations (manual
  CLI, other machines' pulls), and no bead-shaped hook exists today.
- `bd list` polling as primary — 2s/project cost, sandbox-hostile, and laggy vs the 1s
  watch-to-recount budget.
- Extending `GET /specs/all` instead of a new route — that payload is bead-rollup-shaped
  (per-proposal); mixing per-project snapshot history in would bloat a hot dashboard payload.
