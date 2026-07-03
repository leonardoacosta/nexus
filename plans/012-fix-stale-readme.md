# Plan 012: Correct the README so it documents the shipped product (Swift dashboards + web terminal, Postgres, real launch-agent labels)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 64a206ff..HEAD -- README.md`
> If `README.md` changed since this plan was written, compare the
> "Current state" excerpts against the live file before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: docs
- **Planned at**: commit `64a206ff`, 2026-07-03

## Why this matters

`README.md` is the primary onboarding doc, and it markets software that no
longer exists. The headline product and the entire Key Bindings reference
describe a terminal TUI that was retired — while the README's own Architecture
diagram already shows Swift dashboards (`Nexus.app` / iOS / watchOS) plus a web
terminal. The package table calls `packages/db` "SQLite" when it is Drizzle
Postgres (all tables `pgTable`; the env var is `POSTGRES_URL`; migrated
2026-04-03). The "Install as Service" section tells macOS users to
`launchctl bootstrap` a `com.nexus.agent.plist` that the installer never
produces. Result: a reader onboards to deleted features, provisions the wrong
datastore engine, and runs a launchctl command that targets a nonexistent file.
This plan makes every one of those facts match the repo.

## Current state

Files (only one is edited):

- `README.md` — the stale onboarding doc; every wrong fact below is in it.
- `packages/db/src/schema/sessions.ts:4` — confirms Postgres: the schema imports
  `pgTable` from `drizzle-orm/pg-core` (all 28 schema files in
  `packages/db/src/schema/` use `pgTable`). It is NOT SQLite.
- `deploy/install.sh` — the macOS installer. Lines 174, 207, 244 define the ONLY
  three launch-agent labels it installs and bootstraps:
  `dev.leonardoacosta.nexus.deploy`, `dev.leonardoacosta.nexus.ios-deploy`,
  `dev.leonardoacosta.nexus.presence`. Line 327 comment: **"macOS runs NO
  nexus-agent daemon under the spine model — it is a pure Swift app + Tailnet
  member."** There is no `com.nexus.agent.plist` and no agent-daemon plist on macOS.
- `deploy/dev.leonardoacosta.nexus.deploy.plist`,
  `deploy/launchagents/dev.leonardoacosta.nexus.ios-deploy.plist`,
  `deploy/launchagents/dev.leonardoacosta.nexus.presence.plist` — the actual
  shipped plists (the `dev.leonardoacosta.nexus.*` naming).
- `apps/web/package.json` — `@nexus/web`, a Next.js browser terminal (`next@^16`,
  `@wterm/ghostty` WASM terminal, `dev` on port 7402). It is a real workspace app
  and is MISSING from the README package table.
- `tests/e2e/playwright/` — 7 Playwright specs covering the web terminal
  (`web-terminal-journey.spec.ts`, `read-only-viewer.spec.ts`,
  `phone-terminal-journey.spec.ts`, `renderer-throughput.spec.ts`,
  `desktop-attach-verify.spec.ts`, `disconnect-restore-verify.spec.ts`,
  `phone-wide-verify.spec.ts`).

Confirmed there is NO TUI: no `apps/*` TUI target, and no `ink`/`blessed`/`ratatui`
dependency anywhere in the workspace `package.json` files. The TUI referenced by
the README is deleted software.

The exact stale text to replace (from the live `README.md` at commit `64a206ff`):

Lines 1–5 (intro):
```
# Nexus

Peer-to-peer terminal dashboard for managing Claude Code sessions across all your machines.

Each dev server runs a lightweight agent daemon. The TUI aggregates sessions from all agents over Tailscale, letting you monitor, stream, and attach to any Claude Code session from a single terminal.
```

Lines 7–16 (Features list):
```
## Features

- **Dashboard** — all sessions across all machines, grouped by project
- **Live streaming** — read-only event stream for any session (`a` to attach)
- **Full attach** — SSH + tmux takeover for managed sessions (`A` to attach)
- **Start sessions remotely** — spawn Claude Code on any agent via command palette
- **System health** — CPU, memory, disk, Docker status per machine
- **Projects overview** — registered projects with active session counts
- **Command palette** — fuzzy-filter navigation with `:` or `/`
- **Auto-discovery** — agents watch Claude Code's `sessions.json` with no instrumentation needed
```

Line 44 (package table row):
```
| `packages/db`                    | SQLite schema + drift detector                                         |
```

Line 101 (macOS post-install):
```
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.nexus.agent.plist
```

Lines 124–136 (Key Bindings section — the whole TUI keybinding block):
```
## Key Bindings

| Key       | Action                     |
| --------- | -------------------------- |
| `Tab`     | Cycle screens              |
| `j`/`k`   | Navigate up/down           |
| `Enter`   | Select / view detail       |
| `a`       | Stream attach (read-only)  |
| `A`       | Full attach (SSH + tmux)   |
| `n`       | Start new session          |
| `s`       | Stop session (from detail) |
| `:` `/`   | Command palette            |
| `q` `Esc` | Back / quit                |
```

Repo doc conventions to honor (from `.claude/CLAUDE.md`): the clients are the
"Dashboard" (Swift `Nexus.app` / iOS / watchOS sharing `NexusShared`) plus the
`apps/web` browser terminal; the datastore is "Drizzle schema (PostgreSQL)".
Do NOT use emojis anywhere in the file.

## Commands you will need

| Purpose            | Command                                                        | Expected on success |
|--------------------|---------------------------------------------------------------|---------------------|
| Drift check        | `git diff --stat 64a206ff..HEAD -- README.md`                 | no output (unchanged) |
| Stale-fact grep    | `grep -n "SQLite\|TUI\|com.nexus.agent" README.md`            | NOTHING after the fix |
| Modified-files check | `git status --porcelain`                                    | only `README.md` listed |

There is no build/typecheck/test gate for this change — verification is grep +
a human read-through.

## Scope

**In scope** (the only file you may modify):
- `README.md`

**Out of scope** (do NOT touch, even though they look related):
- `apps/nextjs/` and the `--dashboard` flag row in the README — that is the
  separate **legacy** Next.js dashboard, already correctly labelled "legacy" in
  the Flags table (line 110). Leave it as-is; it is not the `apps/web` browser
  terminal.
- `deploy/install.sh` and any `.plist` file — you are only correcting the doc,
  not the installer.
- Any source, schema, or config file — this is a docs-only change.
- The Architecture diagram (lines 20–30) and the inbound hook-flow diagram
  (lines 46–54) — they are already correct; do not rewrite them.

## Git workflow

- Branch: `advisor/012-fix-stale-readme`
- One commit; conventional-commit style, e.g.
  `docs: correct README — Swift dashboards + web terminal, Postgres, real plist labels`
- Do NOT push or open a PR.

## Steps

### Step 1: Fix the intro (lines 1–5)

Replace the intro so it describes the shipped product — Swift dashboards plus a
web terminal, peer-to-peer over Tailscale — with no "TUI" and no "single
terminal" framing. Target shape:

```
# Nexus

Peer-to-peer dashboard for managing Claude Code sessions across all your machines.

Each dev server runs a lightweight agent daemon. Swift dashboards (`Nexus.app`,
iOS, watchOS) and a Next.js web terminal aggregate sessions from every agent over
Tailscale, letting you monitor, stream, and attach to any Claude Code session
from any client.
```

**Verify**: `grep -n "TUI\|single terminal" README.md` → no matches in the intro.

### Step 2: Rewrite the Features list (lines 7–16)

Remove the TUI keybinding references (`a`/`A` attach, command palette `:`/`/`)
and describe the current clients. Keep the accurate capabilities (dashboard,
streaming, full attach, remote start, health, projects, auto-discovery) but
phrase them client-neutrally. Target shape:

```
## Features

- **Dashboard** — all sessions across all machines, grouped by project, in the Swift apps (macOS / iOS / watchOS)
- **Web terminal** — browser-based terminal (`apps/web`) for streaming and attaching to sessions
- **Live streaming** — read-only event stream for any session
- **Full attach** — SSH + tmux takeover for managed sessions
- **Start sessions remotely** — spawn Claude Code on any agent
- **System health** — CPU, memory, disk, Docker status per machine
- **Projects overview** — registered projects with active session counts
- **Auto-discovery** — agents watch Claude Code's `sessions.json` with no instrumentation needed
```

**Verify**: `grep -n '`a` to attach\|`A` to attach\|command palette' README.md`
→ no matches.

### Step 3: Correct the `packages/db` row and add `apps/web` (package table, ~line 44)

Change the `packages/db` row from "SQLite schema + drift detector" to
"PostgreSQL schema (Drizzle) + drift detector". Then add an `apps/web` row.
Preserve the table's column alignment (pad with spaces to match the existing
`| ... | ... |` widths). Target rows:

```
| `apps/web`                       | Next.js browser terminal (Ghostty WASM) — covered by tests/e2e/playwright |
| `packages/db`                    | PostgreSQL schema (Drizzle) + drift detector                          |
```

Place the `apps/web` row logically — after the `apps/swift/NexusShared` row and
before `packages/core`, so all `apps/*` rows stay grouped.

**Verify**: `grep -n "SQLite" README.md` → no matches; `grep -n "apps/web" README.md`
→ one match.

### Step 4: Fix the macOS "Install as Service" post-install (lines 100–102)

The installer already installs AND bootstraps its launch agents
(`dev.leonardoacosta.nexus.deploy`, `.ios-deploy`, `.presence`) itself, and macOS
runs no `nexus-agent` daemon. Remove the bogus
`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.nexus.agent.plist`
line. Replace the macOS post-install block so it reflects reality — the installer
handles the launch agents; the user just opens the app. Target shape for the
macOS post-install comment + commands (lines ~100–103):

```
# macOS post-install — install.sh already bootstraps the GUI launch agents
# (dev.leonardoacosta.nexus.deploy / .ios-deploy / .presence). Just launch the app:
open /Applications/Nexus.app
```

Do NOT invent a new `launchctl` line pointing at any agent-daemon plist — none
exists on macOS.

**Verify**: `grep -n "com.nexus.agent" README.md` → no matches.

### Step 5: Delete the Key Bindings section (lines 124–136)

The entire `## Key Bindings` section documents the deleted TUI. Remove the
`## Key Bindings` heading and its table completely (through the `` | `q` `Esc` |
Back / quit | `` row). Leave the surrounding sections (`## Configuration` above,
`## Ports` below) intact and separated by a single blank line.

**Verify**: `grep -n "Key Bindings\|Cycle screens\|Stream attach" README.md`
→ no matches.

### Step 6: Final read-through

Read the whole edited `README.md` top to bottom. Confirm the prose now
consistently describes Swift dashboards + web terminal (no TUI, no keybindings),
Postgres, and the real launch-agent behavior — and that no formatting is broken
(tables aligned, code fences balanced, no emojis introduced).

**Verify**: `grep -n "SQLite\|TUI\|com.nexus.agent" README.md` → **NOTHING**.

## Test plan

No automated tests — this is a docs change with no runtime surface. Verification
is entirely grep + human read-through:

- `grep -n "SQLite\|TUI\|com.nexus.agent" README.md` → returns nothing.
- `git status --porcelain` → only `README.md` shown as modified.
- A human reads the rendered README and confirms the headline product,
  package table, and install instructions match the shipped repo.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -n "SQLite\|TUI\|com.nexus.agent" README.md` returns no output
- [ ] `grep -n "apps/web" README.md` returns exactly one match (the new package-table row)
- [ ] The `## Key Bindings` section no longer exists (`grep -n "Key Bindings" README.md` empty)
- [ ] `git status --porcelain` lists only `README.md`
- [ ] No emojis were introduced (`grep -nP "[\x{1F000}-\x{1FAFF}\x{2600}-\x{27BF}]" README.md` empty)
- [ ] `plans/README.md` status row for 012 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check shows `README.md` changed since commit `64a206ff`, and the
  "Current state" excerpts no longer match the live file at the quoted line numbers.
- `packages/db/src/schema/sessions.ts` does NOT import `pgTable` (would mean the
  DB is not Postgres and the SQLite correction is wrong — re-verify before editing).
- `deploy/install.sh` no longer defines the `dev.leonardoacosta.nexus.*` labels,
  or a `com.nexus.agent` plist has since been added (the plist correction would
  then be wrong).
- Any edit would require touching a file outside `README.md`.

## Maintenance notes

For whoever owns the README next:

- If the web terminal (`apps/web`) or a Swift client is renamed/removed, or the
  launch-agent labels in `deploy/install.sh` change, the intro, package table,
  and Install-as-Service section here must be updated in lockstep.
- Reviewer should scrutinize: (1) no reintroduced TUI/SQLite/`com.nexus.agent`
  language, (2) package-table column alignment preserved, (3) the legacy
  `apps/nextjs` `--dashboard` flag row (line ~110) is left untouched and not
  conflated with the new `apps/web` row.
- Deferred out of scope: no wider README restructure or new sections — this plan
  only corrects the wrong facts named above.
