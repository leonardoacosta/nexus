# Plan 062: Store hygiene — wisps convention, conservative prune/flatten runbook, metadata execution hints

> **Executor instructions**: This plan produces a RUNBOOK + conventions
> docs. Every `bd` command that mutates the store is OPERATOR-ONLY — the
> executor writes documents and never runs prune/purge/flatten/remember.
> Update this plan's row in `plans/README.md` when done.
>
> **Drift check (run first)**:
> `git diff --stat 9c4c61ed..HEAD -- docs/ AGENTS.md .beads/config.yaml`

## Status

- **Priority**: P3
- **Effort**: S–M (docs; the risk lives in the operator commands, which is why they get a runbook)
- **Depends on**: none (058's deny-list keeps agents away from these verbs — good pairing)
- **Category**: workflow / hygiene
- **Planned at**: commit `9c4c61ed`, 2026-07-19

## Why this matters

The store is 2,220 issues, 96% closed, 1.95 MB JSONL — every watcher parse,
fleet walk, and `bd` invocation carries that history. bd 1.1.0 provides a
hygiene toolchain the repo uses none of:

- **Wisps** (`bd create --ephemeral`, `bd mol wisp`): ephemeral beads for
  operational work with no audit value (the "chore(beads): flush export"
  class, device-install checks, one-off verification runs). Excluded from
  federation push; bulk-deleted by `bd purge` / `bd mol wisp gc`.
- **`bd prune --older-than <dur>`** + **`bd flatten`**: permanently delete
  old closed beads and reclaim Dolt storage.
- **`metadata`** (arbitrary JSON per issue): the sanctioned extension point
  — this repo's routing hints live in flat label strings
  (`owner:api-engineer`, `parallel`, `type:api` — 151/106/133 uses), which
  agents must string-parse.

The tension to respect: **prune is irreversible**, and this repo's commit
messages cite bead IDs (`[nx-xxxxx]`) as the primary cross-reference from
code history to intent — Wave 5's audit used exactly those references.
Pruned IDs become dangling citations. Hence: conservative horizon,
dry-run-first, backup-gated, and a documented exclusion rule.

## Current state

- `.beads/backup/` exists (bd's backup dir); `.beads/config.yaml` has
  defaults (no `no-db`, no events-export).
- Label conventions in live use (counts above, from the 2026-07-19 JSONL).
- `docs/` carries operator runbooks (exemplar:
  `docs/runbook-credential-encryption.md` — read it and match its
  structure/tone).
- bd metadata conventions (docs core-concepts/metadata): keys like
  `execution_agent_type`, `execution_parallel_group` are the documented
  execution-hint convention; `bd:` and `_` prefixes reserved; metadata is
  NOT label-indexed (filtering needs `bd sql`/jq).

## Steps

### Step 1 — `docs/runbook-beads-hygiene.md`

Following the credential runbook's structure, write sections:

1. **When to run** — store growth signal (JSONL > ~3 MB or parse-visible
   latency), roughly quarterly.
2. **Backup first** — `bd backup` (confirm exact syntax via `--help`) +
   verify `.beads/backup/` artifact exists; plus note that `git show` of
   old `chore(beads): flush` commits preserves JSONL snapshots forever.
3. **Prune, conservatively** — the exact sequence, each with a dry-run
   first:
   - `bd prune --older-than 180d --dry-run` → review list; the exclusion
     rule: any bead whose ID appears in `git log --oneline --since=<1y>`
     output should survive (provide the one-liner:
     `bd prune --older-than 180d --dry-run | <extract ids> | while read id; do git log --oneline --grep="$id" | head -1; done` —
     write it properly against the real dry-run output format, checked via
     `--help`).
   - `bd prune --older-than 180d --force` only after review.
   - `bd flatten` afterward to actually reclaim Dolt storage — with its
     own warning block (squashes ALL Dolt history; do it only right after
     a verified backup + `bd dolt push` so peers re-clone cleanly — check
     the docs' recovery/history-squash guidance and cite it).
4. **Cross-machine order** — prune/flatten on ONE machine, push, then
   verify the other machine pulls cleanly BEFORE deleting any backups
   (Dolt history rewrite + a second writer is the recovery-playbook
   scenario; sequence it explicitly).
5. **Expected effect** — JSONL shrink verifiable via `wc -l
   .beads/issues.jsonl`; watcher/fleet reads speed up proportionally.
6. **Routine sweeps that PREVENT the backlog rot** (each with its explicit
   purpose stated in the runbook, one line each): `bd epic close-eligible`
   — closes epics whose children are all closed (the open-Sentry-epic
   class); `bd mol stale` — molecules complete but unclosed; `bd stale
   --days 30` — untouched open beads (plan 057 automates the feed;
   this runbook documents the manual sweep). These are non-destructive and
   safe to run any time — say so explicitly so a cautious reader doesn't
   lump them in with prune.

### Step 2 — Wisps convention (docs)

In AGENTS.md (outside the managed block), a short "Ephemeral work" note:
operational beads with no audit value (flush chores, one-off env checks,
device-install verifications) SHOULD be created `bd create --ephemeral`;
they are purged wholesale via `bd purge` (runbook §) instead of aging into
the permanent store. Include the one distinguishing question: "would a
future audit ever cite this bead? No → wisp."

### Step 3 — Routing-data convention: labels vs assignee vs metadata (docs)

New section in the runbook (or a sibling `docs/beads-conventions.md` if the
runbook gets long — executor's call, note it). **Write it for a reader with
zero bd context — every advantage stated explicitly, nothing assumed.**
The doc must contain this three-mechanism table (adapt wording, keep the
content):

| Mechanism | What it is | What it's FOR (explicit advantages) | What it CANNOT do | nx today |
|---|---|---|---|---|
| **Labels** (`owner:api-engineer`, `type:api`, `parallel`) | Flat indexed strings on an issue | The ONLY mechanism `bd ready --label` / `bd list --label` can filter on server-side; cheap; visible in every list view | No structure (string-parse to read `owner:X`); bd attaches no semantics — an `owner:` label does NOT assign anybody | 151× owner:, 133× type:, 106× parallel — the whole routing scheme lives here |
| **Assignee** (the real field: `bd assign <id> <who>`, `bd update --claim`, `bd ready --assignee/--unassigned`) | A first-class column bd's coordination machinery operates on | `--claim` is ATOMIC (assignee+in_progress in one op — two sessions cannot both win); `bd ready --unassigned` finds unclaimed work; `bd swarm status` shows active-with-assignee; `bd mol pour --assignee` seeds a whole wave to an agent | Only one value; not a taxonomy | **Essentially unused** — nx routes with `owner:` labels, which bd's claim/ready/swarm machinery cannot see. This mismatch is the section's headline: `owner:api-engineer` as a label is invisible to `bd ready --assignee api-engineer` |
| **Metadata** (arbitrary JSON: `execution_agent_type`, `execution_parallel_group`, custom `nexus.*` keys) | Per-issue JSON blob, the documented extension point | Structured, typed payload — no string-parsing; the documented `execution_*` keys are a cross-tool convention orchestrators read BEFORE spawning subagents (model/effort are fixed at launch: `bd show <id> --json \| jq .metadata`); `nexus.*` prefix is the sanctioned home for nexus-agent-specific fields (`bd:` and `_` prefixes reserved) | NOT indexed — cannot filter `bd ready` on it; reading requires `--json`+jq or `bd sql` | Unused |

And the explicit convention that follows from it:

- **Role/kind taxonomy** (`owner:`, `type:`) → stays in labels (it's a
  filterable taxonomy, exactly what labels are for) — BUT the doc must say
  plainly: an `owner:` label expresses *intended* routing; the *actual*
  claim is the assignee field, set via `--claim`. The two coexist:
  `bd ready --label owner:api-engineer --unassigned` = "unclaimed work
  intended for the api role".
- **Live "who has it"** → assignee via `--claim`, never a label (atomicity
  is the advantage; a label-write is not atomic with status).
- **Rich orchestration payload** (suggested model, parallel group, effort)
  → metadata `execution_*` / `nexus.*` keys, with one worked
  `bd update <id> --metadata` example (confirm flag syntax via
  `bd update --help`).
- Explicitly: convention doc, not a migration — existing labels stay; the
  assignee field starts being used by plan 059's `--claim` discipline; new
  orchestration data goes to metadata.

### Step 4 — Operator handoff

Report ends with the copy-paste block: backup → dry-run prune → review →
prune → flatten → push → peer-verify, each line annotated. No command run
by the executor.

## Done criteria (machine-checkable)

- `test -f docs/runbook-beads-hygiene.md` → true; contains "dry-run",
  "flatten", "backup", and the cross-machine ordering section.
- `grep -c "ephemeral" AGENTS.md` → ≥ 1 (outside managed block).
- Metadata convention documented with the reserved-prefix warning.
- Every mutating command in the runbook is preceded by a dry-run or backup
  step (self-audit the doc before finishing).

## Out of scope — do not touch

- Running any prune/purge/flatten/backup (operator-only, forever).
- `.beads/config.yaml` changes (events-export, no-db etc. — separate
  decisions, not needed here).
- Label→metadata migration tooling (convention-only per Step 3).
- `bd compact` (AI summarization, token cost — explicitly not recommended;
  say so in the runbook so it isn't "discovered" later).

## STOP conditions

- If `bd prune --help` shows no `--dry-run` (doc/binary skew), STOP the
  runbook's prune section and report — a runbook advising irreversible
  deletion without dry-run must not ship.
- If `.beads/backup/` semantics are unclear from `--help` (what's actually
  restorable), keep the git-history-snapshot note as the primary recovery
  path and say so explicitly.

## Maintenance notes

- After the first real prune, plan 056's shape-fixture may reference pruned
  IDs — regenerate the fixture (it samples live JSONL).
- If plan 061's molecules are adopted, wisp-molecules (`bd mol wisp`) are
  the natural form for operational check-runs — cross-reference the
  runbook then.
- The 180d horizon is a starting point; revisit after observing how often
  audits actually cite old bead IDs.
