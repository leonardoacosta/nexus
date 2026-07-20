# Plan 061: Formula → molecule pilot for openspec-change and audit waves (staged)

> **Executor instructions**: STAGED plan — Stages 0-1 are authoring/docs and
> executor-safe; Stages 2-3 involve bd WRITES against the shared database
> and are OPERATOR-GATED: prepare the commands, do not run them from an
> isolated worktree. Honor STOP conditions; update this plan's row in
> `plans/README.md` per stage.
>
> **Drift check (run first)**:
> `git diff --stat 9c4c61ed..HEAD -- openspec/AGENTS.md AGENTS.md .beads/`
> plus `bd formula --help` / `bd mol --help` availability check.

## Status

- **Priority**: P3 (highest structural upside of the beads roadmap, but a workflow change — pilot deliberately)
- **Effort**: M (Stages 0-1) + operator adoption
- **Risk**: LOW for authoring; MEDIUM for adoption (changes how waves are seeded — pilot on ONE wave before generalizing)
- **Depends on**: 059 recommended first (claim discipline is how molecule steps get picked up safely)
- **Category**: workflow / direction
- **Planned at**: commit `9c4c61ed`, 2026-07-19

## Why this matters

The repo's two most repeated workflows are hand-built every time:

1. **openspec change waves** — a proposal becomes an epic + N task beads
   (`[SPEC]`/`[CAPABILITY]` markers, `[1.2]`-style task titles — visible
   throughout `.beads/issues.jsonl`: 148 epics, 1,884 tasks, 1,785
   parent-child edges), sequenced implicitly by task numbering and prose.
2. **audit waves** — recon → parallel audit → verify → plan/proposal →
   execute → reconcile (this very document's lineage; see
   `docs/audit/apply-2026-07-19-001/wave-plan.json` from yesterday's run).

The dependency graph carries only **14 `blocks` edges** across 2,220 beads
— ordering lives in filenames and prose, invisible to `bd ready`. bd 1.1.0's
formula system is purpose-built for this: declare the DAG once as TOML
(steps with `needs`, `{{vars}}`, optional gates), `bd cook` it into a
proto, then `bd mol pour --var name=...` stamps out a real epic whose
children carry REAL dependency edges. Then:

- `bd ready --mol <id> [--claim]` feeds concurrent agents exactly the
  unblocked frontier of that wave (the `parallel` label routing becomes
  graph-native);
- `bd mol progress` gives dashboards a true per-wave rollup (plan 057's
  feed can carry it later);
- `bd mol distill <epic>` reverse-engineers a formula from a wave already
  run — the cheapest possible authoring start.

Pilot honestly: ONE formula, ONE real wave, then decide.

## Explicit advantages — what each piece buys (read this even if you think you know)

Nothing below is implicit; an executor or reviewer should be able to
justify every step from this table alone.

| Feature | What it concretely is | What nx gains, explicitly |
|---|---|---|
| **Molecule** | Just an epic (parent bead + children) PLUS execution semantics. nx already has 148 epics with 1,785 parent-child edges — nx is already "using molecules" structurally, minus the ordering. | The traversal commands start working: `bd ready --mol <id>` (only unblocked steps of THIS wave), `bd mol current` (where am I), `bd mol progress` (completed/total, rate, ETA), `bd mol stale` (complete-but-unclosed wave detection). |
| **`needs` / `blocks` edges** | Real graph edges between steps. The bd docs' Agent Pitfall #2 states nx's exact current condition: "Numbered steps don't create sequence. Steps named Step 1/2/3 still run in parallel until you add dependencies between them." nx's `[1.2]`, `[3.7]` task numbering is prose — bd sees 2,220 beads with only **14** blocking edges; `bd ready` cannot sequence anything today. | Ordering becomes machine-readable: a phase-2 task literally cannot appear in `bd ready` until phase 1 closes. Dependency direction rule (Pitfall #1): requirement language, dependent first — `bd dep add <phase2> <phase1>` means "phase2 needs phase1". |
| **Formula → proto → pour** | The DAG written ONCE as TOML, stamped out per-instance with `--var`. | Wave-creation becomes one command instead of N `bd create` + M `bd dep add` calls; step structure stops drifting between waves; `bd mol distill <epic>` reverse-engineers the TOML from a wave already run (cheapest authoring start). |
| **`bd mol bond A B`** | A dependency between two work GRAPHS (sequential / parallel / conditional). | Multi-change apply waves compose: change-B's molecule bonds after change-A's; an agent finishing A flows into B without a human re-seeding. |
| **`bd epic close-eligible`** | Sweeps epics whose children are all closed. | Directly kills a recurring nx failure: epics like the Sentry-migration epic staying open after all work shipped. |
| **`bd mol squash` / `burn`** | Condense a molecule's children to a digest bead / delete outright. | Wave-cleanup primitive; pairs with wisps (plan 062). |

### `bd swarm` — corrected assessment (upgraded from "out of scope")

The initial audit graded swarm "overkill for the session count." That was
wrong about half the command: `bd swarm` has two halves with different
verdicts.

| Subcommand | What it does | nx verdict |
|---|---|---|
| `bd swarm validate <epic>` | READ-ONLY structural analysis of an epic's DAG: detects inverted/temporal dependencies, orphaned roots, missing edges, cycles, disconnected subgraphs — and reports **ready fronts (the waves of parallel work), estimated worker-sessions, and maximum parallelism**. | **Adopt in the pilot.** It computes waves like the apply tooling's `wave-plan.json` does, but from a DIFFERENT signal: dependency edges (logical order, deterministic) vs wave-plan's LLM-emitted file-path intersections (merge-conflict proxy, unverifiable). Complementary today — see the seam table row below for the convergence path. After pouring a molecule, `bd swarm validate` is the pre-flight check that the graph encodes what the wave plan intended. |
| `bd swarm status <epic>` | Live status computed FROM beads (completed / active-with-assignee / ready / blocked). | Useful read surface mid-wave; same data `bd mol progress` summarizes. |
| `bd swarm create` + coordinator | A swarm molecule assigning a coordinator agent for multi-worker orchestration. | Still out of scope — nx has one human coordinator; revisit only if unattended multi-agent execution arrives. |

## The beads↔openspec seam — framing for the next audits

The pilot's real subject is the seam between openspec (change proposals,
tasks.md, archive lifecycle) and beads (epics, tasks, edges). Current
mapping is by CONVENTION only — titles like `[SPEC]`/`[CAPABILITY]`/`[1.2]`
and the `spec_id` field — enforced nowhere. The molecule model gives each
convention a first-class home:

| openspec artifact | beads today (convention) | beads with molecules (mechanism) |
|---|---|---|
| change proposal | epic titled `[SPEC] ...` + `spec_id` | poured molecule root (from `openspec-change` formula), `--var change_id` |
| tasks.md numbered task `[N.M]` | child bead, number in title, NO ordering edges | molecule step with real `needs` edges |
| wave-plan.json (apply tooling) | LLM-emitted `file_paths` per spec, waves derived by file-path intersection (merge-conflict proxy); `beads_covered` exists but is always `[]` — the beads link is unfilled | COMPLEMENTARY, not equivalent: `bd swarm validate` computes ready fronts from DEPENDENCY edges (logical order), deterministic but blind to file conflicts; wave-plan sees file conflicts but no logical order. Convergence path: encode the wave generator's file-conflict conclusions as `blocks`/`bond` edges → swarm validate subsumes the JSON. The pilot's Stage 2 comparison tests exactly this. |
| apply execution loop | agent reads tasks.md, picks by number | `bd ready --mol <id> --claim` |
| archive step | epic often left open | `bd epic close-eligible` sweep + `bd mol stale` |

NOTE for the executor: the `/apply` and feature-authoring commands live in
the USER-LEVEL `~/.claude` (not in this repo — repo `.claude/commands/`
holds only `audit/*`). This plan therefore integrates at the seam
artifacts (formula files, openspec/AGENTS.md text, wave-plan comparison),
NOT by editing those commands. Stage 3's verdict should state explicitly
whether the apply-command layer should adopt `bd ready --mol` as its
task-selection mechanism — that is the follow-up audit's question, and this
pilot generates the evidence for it.

## Current state

- No formulas exist (`grep -rn "formula" .beads/ openspec/ scripts/` → none
  beyond docs noise — verify).
- Wave anatomy exemplars to mine: `git show 28c9efa5 --stat` (yesterday's
  4-proposal audit wave), `docs/audit/apply-2026-07-19-001/wave-plan.json`,
  and any archived change in `openspec/changes/archive/2026-07-*` with a
  `tasks.md` (the task-wave shape: numbered tasks, phase groupings).
- `openspec/AGENTS.md` — the authoring workflow agents follow for
  proposals; the pilot must NOT fork it, only annotate it.

## Stages

### Stage 0 — Distill candidate + formula authoring (executor-safe)

1. Pick the exemplar: read 2-3 archived openspec changes' `tasks.md`
   (choose recent, typical ones — e.g. `redesign-status-usage-endpoints`,
   task IDs `[1.1]`-`[4.2]` visible in git log) and extract the recurring
   phase skeleton (schema → implementation → clients → tests, or the
   audit-wave equivalent).
2. Author `config/formulas/openspec-change.formula.toml` (location note:
   check `bd formula --help` for where formulas are expected to live /
   how import works — if bd expects them under `.beads/formulas/` or
   imports from anywhere, prefer a git-tracked `config/formulas/` +
   documented import command). Shape (validate field names against the
   fetched docs / `bd formula --help` — do NOT trust this sketch blindly):

```toml
description = "openspec change proposal executed as a task wave"
[vars.change_id]
  required = true
[vars.phases]
  # keep simple for the pilot: fixed 4-phase skeleton

[[steps]]
id = "schema"
title = "[{{change_id}}] phase 1 — schema/types"
[[steps]]
id = "impl"
title = "[{{change_id}}] phase 2 — implementation"
needs = ["schema"]
[[steps]]
id = "clients"
title = "[{{change_id}}] phase 3 — client consumption"
needs = ["impl"]
[[steps]]
id = "verify"
title = "[{{change_id}}] phase 4 — tests + verification"
needs = ["impl"]
```

3. Author `config/formulas/audit-wave.formula.toml` similarly (recon →
   audit (parallel-friendly) → verify → author-proposals → execute →
   reconcile), mining yesterday's wave-plan.json for the real step names.
4. Both files carry a header comment pointing at this plan and the bd docs
   (workflows/formulas).

Verification: `bd formula lint`/`bd cook --dry-run` if such read-only
validation exists (check `--help`); otherwise TOML-parse check
(`python3 -c "import tomllib,sys; tomllib.load(open(sys.argv[1],'rb'))" <file>`).

### Stage 1 — Docs wiring (executor-safe)

- `openspec/AGENTS.md`: add a short optional-path section — "Task waves MAY
  be seeded from `config/formulas/openspec-change.formula.toml` via
  `bd cook` + `bd mol pour --var change_id=<id>` instead of hand-creating
  the epic/tasks; molecule steps replace the hand-numbered `[N.M]` beads."
  Keep it optional until the pilot verdict.
- AGENTS.md (outside managed block): one line pointing wave workers at
  `bd ready --mol <id> --claim`.

### Stage 2 — Pilot pour (OPERATOR-GATED)

Emit for Leo, verbatim, in the report:

```
bd cook config/formulas/openspec-change.formula.toml
bd mol pour openspec-change --var change_id=<next-real-change>
bd mol show <molecule-id> --parallel
bd swarm validate <molecule-id>          # pre-flight: ready fronts, cycles, est. worker-sessions
```

Compare `bd swarm validate`'s ready-front output against what the apply
tooling's hand-written wave plan would have said — that comparison IS the
pilot's key evidence (see "The beads↔openspec seam" above).

Run the NEXT real openspec change through the molecule instead of
hand-created beads. During the wave: `bd ready --mol` / `bd mol progress`.

### Stage 3 — Verdict + optional distill (OPERATOR-GATED)

After the pilot wave ships, decide: adopt (make Stage 1's optional path the
default in openspec/AGENTS.md), adjust (edit the formula), or drop (delete
`config/formulas/`, revert docs — cheap by design). If adopting, also try
`bd mol distill` on one historical epic to compare against the hand-written
formula. Record the verdict in this plan's status row.

## Done criteria

- Stage 0: both formula files exist, TOML-valid, cook/lint-clean if
  checkable.
- Stage 1: docs sections present; openspec managed conventions untouched
  otherwise.
- Stage 2-3: operator-run; status row records poured molecule id and the
  verdict.

## Out of scope — do not touch

- Rewriting historical epics into molecules (forward-only).
- Gates inside formulas for the pilot (human/CI gates are a second
  iteration — keep step DAG plain `needs` first).
- Dashboard `bd mol progress` panels (follow-up on plan 057's feed if the
  pilot sticks).
- `bd swarm create` / coordinator orchestration (single-coordinator repo;
  `swarm validate` + `swarm status` ARE in scope — see the corrected
  assessment above).
- Editing the user-level `~/.claude` apply/feature commands (outside this
  repo; Stage 3's verdict feeds that decision, it doesn't make it).

## STOP conditions

- `bd formula` / `bd mol` subcommands absent or flag-gated in the installed
  1.1.0 → STOP, report exact `--help` output.
- If formula TOML field names in the docs don't match `bd cook`'s actual
  schema (fast-moving feature), conform to the binary, note the doc drift.
- If openspec/AGENTS.md's conventions are generated/managed by openspec
  tooling, add the section per its rules or STOP.

## Maintenance notes

- Molecules put real `blocks` edges into the graph — plan 055's
  `deriveReadySet` then starts genuinely sequencing dashboards' ready
  counts. Watch that interaction on the pilot wave.
- If adopted, the `[N.M]` task-title convention can eventually retire; do
  not retire it during the pilot (tooling like statusline pattern-matches
  titles — grep before ever changing title shapes).
