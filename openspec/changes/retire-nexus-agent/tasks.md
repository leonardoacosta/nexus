---
stack: infra
---
<!-- beads:epic:nx-pdsv3 -->
<!-- beads:feature:nx-yhvkj -->

# Implementation Tasks

## DB Batch

- [ ] [1.1] Capture a pre-teardown row-count baseline for every table in the `nexus` database (`sessions`, `health_snapshots`, `notifications`, `credentials`, `projects`, `agents`) and write it to `deploy/decommission-baseline.txt` [beads:nx-sw19o]
- [ ] [1.2] `pg_dump` the full `nexus` database to a timestamped artifact outside the repo, then verify the dump by restoring into a scratch database and diffing row counts against the 1.1 baseline [beads:nx-k5lvc]
  - depends on: 1.1
- [ ] [1.3] Confirm the dump artifact is readable by a second process and record its absolute path plus byte size in `deploy/decommission-baseline.txt` [beads:nx-ncl20]
  - depends on: 1.2

## API Batch

- [ ] [2.1] Stop and disable the four nexus systemd user units (`nexus-agent.service`, `nexus-homelab-deploy.service`, `nexus-homelab-deploy.timer`, `nexus-listener.service`), then remove the unit files from `~/.config/systemd/user/` and run `systemctl --user daemon-reload` [beads:nx-tfy9z]
  - depends on: 1.3
- [ ] [2.2] Remove the agent socket at `~/.config/nexus/agent.sock` and the config directory `~/.config/nexus/` including `agents.toml` [beads:nx-ff3bk]
  - depends on: 2.1
- [ ] [2.3] Delete `apps/agent`, `apps/nexus-emit`, and `apps/nexus-statusline` from the repo, plus their workspace entries in the root `package.json` and any turbo task references [beads:nx-rnt71]
  - depends on: 2.1
- [ ] [2.4] Delete `packages/core` and `packages/db`, and remove the `POSTGRES_URL` and `NEXUS_*` entries from `deploy/secrets.env.example` [beads:nx-e5io5]
  - depends on: 2.3
- [ ] [2.5] Delete the `deploy/` tree including `install.sh`, `hooks.d/post-merge/02-deploy` (the SSH fan-out), `nexus-notifier.sh`, and `com.nexus.notifier.plist`, retaining only `deploy/decommission-baseline.txt` [beads:nx-au3bs]
  - depends on: 1.3
- [ ] [2.6] Remove the `nexus-agent` binary from `~/.local/bin/` on the homelab and confirm `command -v nexus-agent` and `command -v nexus-emit` both resolve to nothing [beads:nx-v34oc]
  - depends on: 2.1

## UI Batch

- [ ] [3.1] Delete `apps/swift` in full — `nexus-mac`, `nexus-ios`, `nexus-watch`, `NexusShared`, `project.yml`, and the generated `nexus.xcodeproj` [beads:nx-2metq]
- [ ] [3.2] Delete `apps/web` (`@nexus/web`) and its workspace entry [beads:nx-pe3d1]
- [ ] [3.3] Rewrite `README.md` and `.claude/CLAUDE.md` to describe the repo's retired state, naming `leonardoacosta/herdr-shepherd` as the successor for TTS and recording that session observability was retired without replacement [beads:nx-1fs82]
  - depends on: 2.3
- [ ] [3.4] Update `docs/nexus-topology.html` and `docs/nexus-evolution.html` with a dated retirement banner rather than deleting them, so the architecture history stays readable [beads:nx-t2r3j]
  - depends on: 3.3
- [ ] [3.5] Remove the `nx` entry from `~/.claude/scripts/config/projects.json` so fleet sweeps stop scanning a retired repo [type:config] [beads:nx-iihx1]
  - depends on: 3.3

## E2E Batch

- [ ] [4.1] With every nexus process stopped, trigger a notification from a live Claude Code session and confirm audible kokoro output through the herdr pipe; paste the command and the observed result as runtime evidence [beads:nx-rq7ux]
  - depends on: 2.1
- [ ] [4.2] Verify teardown: `systemctl --user list-unit-files | grep -c nexus` returns `0`, `test -S ~/.config/nexus/agent.sock` exits non-zero, and `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7400/health` fails to connect [beads:nx-8uri0]
  - depends on: 2.2
- [ ] [4.3] Confirm fleet non-breakage: run a cc hook end-to-end and check exit 0, then load the `harness` index page and confirm it renders with an empty nexus session list [beads:nx-j1rgp]
  - depends on: 4.1
- [ ] [4.4] Grep the fleet (`~/dev/cc`, `installfest`, `nova`, `mesh`, `harness`, `homelab`) for live references to `nexus-agent`, `:7400`, `nexus-emit`, and `agents.toml`; confirm every remaining hit is inside an `archive/` path or historical doc, and file a bead for any live one found [beads:nx-h85cb]
  - depends on: 4.3
- [ ] [4.5] Reboot the homelab and confirm no nexus unit starts and no journal error references a missing nexus binary or socket [beads:nx-n9ka1]
  - depends on: 4.2

## User Gate

- [ ] [5.1] [user:post] DECISION: disposition of the `nexus` Postgres database on the shared `homelab-postgres` container. searched: `deploy/POSTGRES_SCHEMA_MAP.md`, `.claude/CLAUDE.md` § Persistence, and the archived decommission specs; no documented pattern covers retiring a database from the shared multi-tenant container. [type:db] [beads:nx-46a63]
  - Option 1: Drop the `nexus` database after the 1.2 dump verifies — reclaims space, irreversible outside the dump
  - Option 2: Retain the database with no writer, revisit in 90 days — zero risk, leaves a dead DB on the shared container
  - Option 3: Drop all tables but keep the empty database and role — frees space, preserves the connection target if anything is missed
- [ ] [5.2] [user:post] DECISION: disposition of the `leonardoacosta/nexus` GitHub repo and the local checkout. searched: fleet history for a prior repo retirement and `~/.claude/rules/` for a documented archive convention; no pattern exists — `apps/nextjs` was deleted in-tree, never a whole repo. [type:config] [beads:nx-8kbwz]
  - Option 1: Archive on GitHub, keep the local checkout read-only — history stays browsable, no accidental writes
  - Option 2: Archive on GitHub, delete the local checkout — reclaims local disk, history still reachable
  - Option 3: Delete the repo outright — cleanest, permanently discards the architecture history
- [ ] [5.3] [user:post] DECISION: removal of `Nexus.app` and the launchd agent from the Mac, which needs GUI access Leo alone has. searched: `reference_mac_swift_deploy` and `project_mac_restore_gaps` memories confirming three irreducible Apple gates; no headless path exists for uninstalling a signed GUI app. [type:infra] [beads:nx-zo0nr]
  - Option 1: Leo removes `Nexus.app` and unloads the launchd plist in the same session as 4.1
  - Option 2: Leave the Mac app installed but unloaded, clean it up on the next Mac maintenance pass
