# Plan 058: Make the documented bd workflow real — SessionStart prime, permissions hygiene, AGENTS.md truth-up

> **Executor instructions**: Follow this plan step by step, run every
> verification command, honor STOP conditions, and update this plan's row in
> `plans/README.md` when done. `bd remember` WRITES to the shared beads
> database — do NOT run it from an isolated worktree/CI context; Step 4
> emits the commands for the operator instead.
>
> **Drift check (run first)**:
> `git diff --stat 9c4c61ed..HEAD -- .claude/settings.json .claude/settings.local.json AGENTS.md`
> On mismatch with the excerpts, re-read and adapt; on structural surprise
> (e.g. a hooks block already added), STOP.

## Status

- **Priority**: P2
- **Effort**: S–M
- **Risk**: LOW (config + docs; the one behavioral addition — the hook — is additive and self-evident to revert)
- **Depends on**: none
- **Category**: workflow-gap / dx
- **Planned at**: commit `9c4c61ed`, 2026-07-19

## Why this matters

AGENTS.md promises a bd-centric workflow that no tooling enforces:

- `AGENTS.md` (BEADS INTEGRATION block): "Run `bd prime` for detailed
  command reference" and "Use `bd remember` for persistent knowledge — do
  NOT use MEMORY.md files". Reality: **zero** invocations of `bd prime` or
  `bd remember` anywhere in `.claude/`, `scripts/`, or `apps/`; no
  SessionStart hook exists (`.claude/settings.json` holds only a
  `permissions` block). Every CC session starts cold and the memory
  convention is fiction.
- `.claude/settings.local.json` pre-approves `Bash(rm .git/hooks/pre-push)`
  — deletion of the hook that chains the db-push guard and bd's pre-push
  integration — plus stale foreign-machine paths
  (`/home/nyaptor/dev/nx/...`) from another environment.
- `Bash(bd:*)` blanket-allows destructive verbs (`bd delete --force --hard`,
  `bd prune`, `bd flatten`) indistinguishably from reads.

bd 1.1.0's Claude Code integration (docs: integrations/claude-code) is a
SessionStart hook running `bd prime --hook-json` (~1-2k tokens of workflow
context + memories, re-fires after compaction). The docs prefer CLI+hooks
over MCP explicitly.

## Current state — verified (at 9c4c61ed)

`.claude/settings.json` (entire file):

```json
{
  "permissions": {
    "allow": [
      "Bash(cargo:*)",
      "Bash(rustup:*)",
      "Bash(bd:*)",
      "Bash(git:*)",
      "Write(.claude/*)",
      "Edit(*)"
    ]
  }
}
```

`.claude/settings.local.json` allow entries include:
`"Bash(rm -f /home/nyaptor/dev/nx/.git/index.lock)"`,
`"Edit(/home/nyaptor/dev/nx/*)"`, `"Bash(rm .git/hooks/pre-push)"`.

(Also note: `Bash(cargo:*)` / `Bash(rustup:*)` allow a toolchain retired in
2026-04 — dead entries, remove as a ride-along.)

## Steps

### Step 1 — SessionStart hook, WITH a priming budget

**Context — the over-priming concern is real and previously decided.** This
repo deliberately chose `profile:minimal` for the AGENTS.md beads block
(the marker at `AGENTS.md:39` says so) precisely to avoid heavyweight
per-session priming. A naive `bd prime` hook can regress that: prime output
(~1-2k tokens) + memories re-injects on EVERY session start AND re-fires
after every compaction, stacking on top of CLAUDE.md + the AGENTS.md static
block. The hook is only a win if the budget is measured and duplication is
removed. So:

1. **Measure before enabling.** Run `bd prime` and `bd prime --hook-json`
   (read-only) and record byte/approx-token size in your report.
   **Budget gate: if prime output exceeds ~6 KB (~1.5k tokens), do NOT
   enable the full-prime hook.** Instead check `bd prime --help` for a
   slim/quiet mode; if none exists, fall back to a minimal custom hook
   command that injects only the high-value dynamic state:
   `bd ready --limit 5 --json && bd list --status in_progress --json`
   (what changed since last session — the part a static file can never
   carry) and record that prime-proper was rejected on budget.
2. **De-duplicate, don't stack.** If the prime hook IS enabled, shrink the
   redundant static content in the same change: the AGENTS.md Quick
   Reference table duplicates what prime injects — cut the table down to a
   pointer ("session context is auto-primed; see `bd prime`"). One source,
   not two. (Only touch OUTSIDE the managed markers; if the managed block
   itself duplicates, note it — `bd setup` owns that block and a
   regeneration with a lighter profile is an operator action.)
3. **Scope the trigger.** Claude Code SessionStart hooks support matchers
   on the start source (startup / resume / compaction — verify against
   current hooks docs). Prefer firing on `startup` only, NOT on every
   compaction re-fire, unless the measured budget is trivially small.
   Record which matcher shipped.
4. Hook shape — replicate `bd setup claude --check`'s output
   DETERMINISTICALLY in `.claude/settings.json` (hand-written beats running
   the installer in a worktree), with the fail-soft guard:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [
          { "type": "command", "command": "bd prime --hook-json 2>/dev/null || true" }
        ]
      }
    ]
  },
  "permissions": { ... }
}
```

(Adapt matcher syntax to the real hooks schema; `|| true` so a machine
without bd never breaks session start.) If the beads Claude Code PLUGIN is
installed (check `bd setup claude --check` warnings / `.claude/` plugin
refs), skip the hook entirely — double-priming — and record it.

**Ongoing guard (put in the report + AGENTS.md note):** the priming budget
is re-checked whenever memories are added — `bd prime | wc -c` after any
`bd remember`, and a quarterly `bd memories` curation pass (delete/merge
anything stale, hard cap ~10 memories). Memories are the only unbounded
input to prime size; capping them caps the hook forever.

### Step 2 — Permissions hygiene

- `settings.local.json`: delete the three stale/foreign entries quoted
  above (keep the rest).
- `settings.json`: remove `Bash(cargo:*)` and `Bash(rustup:*)` (retired
  toolchain). Keep `Bash(bd:*)` (the documented workflow depends on write
  verbs) but add a `deny` list for the irreversible verbs:

```json
"deny": [
  "Bash(bd delete:*)",
  "Bash(bd prune:*)",
  "Bash(bd flatten:*)",
  "Bash(bd admin:*)"
]
```

Verify the exact allow/deny precedence semantics against current Claude
Code docs (deny wins over allow) before finalizing; if prefix-form
`Bash(bd delete:*)` is not the correct matcher syntax for subcommands, use
the working equivalent and note it.

### Step 3 — AGENTS.md truth-up

Outside the managed BEADS INTEGRATION markers, add a short "How this is
enforced" note: SessionStart hook runs `bd prime` automatically (so the
"Run bd prime" instruction is now descriptive, not aspirational); memories
are expected to exist (Step 4). Do not edit inside the managed markers
(bd regenerates that block).

### Step 4 — Seed memories (OPERATOR HANDOFF — do not execute)

**Division of labor — do NOT backfill CLAUDE.md/Claude-memory content into
bd wholesale.** The question "would we gain anything by backfilling beads
memory with Claude memory?" has a mostly-no answer, and the reasoning
belongs in the repo:

| Knowledge lives in | Because | Reaches |
|---|---|---|
| `.claude/CLAUDE.md` / `~/.claude/rules` | Repo/global facts a HUMAN commits: architecture, conventions, build commands. Git-synced across machines already; loaded by every CC session already. | All CC sessions, no prime needed |
| `bd remember` | Facts an AGENT discovers MID-SESSION that must survive to the next session WITHOUT a git commit, and bead-workflow-coupled facts (they ride the same Dolt sync as the issues they describe). | Sessions that prime, both machines |
| Neither (a bead) | Anything actionable — work is an issue, not a memory. | `bd ready` |

Backfilling CLAUDE.md into memories would double-inject the same content
every session — the exact over-priming failure Step 1 guards against. The
gain of `bd remember` is the *commit-free agent write path*, not a better
CLAUDE.md. Rule of thumb for agents (goes in the AGENTS.md note): "if it
belongs in CLAUDE.md, propose a CLAUDE.md edit; `bd remember` is for what
you learned today that the next session needs before that edit lands, and
for bead-workflow facts. Max ~10 memories; curate quarterly."

Seed set (Leo runs once on a machine with the real db — three memories,
all bead-workflow-coupled, none duplicating CLAUDE.md):

```
bd remember "nexus-agent dashboards read beads via the JSONL watcher cache (apps/agent/src/services/cached-bead-source.ts) — never add per-request bd spawns to routes (crash-loop nx-6lrf7)" --key nx-read-path
bd remember "nx 'ready' = derived not-closed-and-not-blocked (includes in_progress), see deriveReadySet in bead-rollup.ts — do not use bd ready CLI semantics in agent code" --key nx-ready-semantics
bd remember "Session end: run scripts/bd-session-end.sh (merge-slot-serialized pull/dolt-push/push) and bd orphans --details to close shipped-but-open beads first" --key nx-session-end
```

(Adjust the second memory if plan 055 has not landed yet; adjust the third
if plan 059 has not.) After seeding: `bd prime | wc -c` — confirm the
budget gate from Step 1 still holds.

### Step 5 — Verify

- Fresh CC session on this repo starts without error and the transcript
  shows primed bd context (operator confirms; you verify the hook JSON is
  syntactically valid: `python3 -m json.tool .claude/settings.json`).
- `git diff` touches only `.claude/settings.json`,
  `.claude/settings.local.json`, `AGENTS.md`.

## Done criteria (machine-checkable)

- `python3 -m json.tool .claude/settings.json` exits 0 and output contains
  `SessionStart` (and either `bd prime` or the documented slim-fallback
  command, per the Step 1 budget gate).
- Report records: measured `bd prime` size in bytes, the budget verdict,
  and which trigger matcher shipped.
- `grep -c "nyaptor\|rm .git/hooks/pre-push" .claude/settings.local.json` → 0.
- `grep -c "cargo\|rustup" .claude/settings.json` → 0.
- `grep -c "bd delete" .claude/settings.json` → ≥ 1 (deny entry).
- AGENTS.md managed block byte-identical
  (`git diff AGENTS.md` shows changes only outside the markers).

## Out of scope — do not touch

- `.beads/hooks/*` regeneration (`bd hooks install` is a write against the
  shared repo state — operator action, listed in plans/README.md).
- Installing the beads Claude Code plugin (maintainer choice; hook path
  chosen here per docs' CLI-first guidance).
- MCP server setup (docs recommend against it when the CLI is available).

## STOP conditions

- If `bd setup claude --check` reveals a materially different hook
  mechanism than the sketch (schema drift in Claude Code hooks), follow the
  `--check` output, and if that conflicts with this repo's existing
  `.claude` layout, STOP and report.
- If `settings.local.json` entries are actively used by a live automation
  (grep scripts/ for socat/pkill patterns matching them), STOP on those
  specific entries and report instead of deleting.

## Maintenance notes

- After bd upgrades, `bd setup claude --check` again — the hook command
  shape may evolve (the managed AGENTS.md block version-bumps on its own).
- The deny-list is the ONLY guard on destructive bd verbs; if the
  maintainer later wants agents pruning wisps (plan 062), carve
  `bd purge` allowance deliberately.
