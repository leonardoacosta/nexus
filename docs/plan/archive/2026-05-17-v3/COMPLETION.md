# Plan Completion: v3

## Phase: v3 (formal-scope, organic-execution)
## Completed: 2026-05-17
## Duration: 2026-04-17 → 2026-05-17 (~30 days)
## Archived via: `/plan:advance --force` (artifacts were never locked)

---

## Honest framing

v3 was scoped with intent (see `scope-lock.md` excerpts in `context.md`) but the formal
planning pipeline (`/plan:scope` → `/plan:design` → `/plan:roadmap` → `/plan:strategy`)
was never run. Only `context.md` existed; no `scope-lock.md`, no `prd.md`, no `roadmap.md`,
no `.locks/`. Work proceeded *responsively* — through openspec change proposals, beads
issues, audit findings, and direct architectural work — rather than top-down roadmap
execution.

This is the same pattern v2 acknowledged in its own COMPLETION.md ("v2's roadmap was
strategic scope, not an execution log"). v3 inherited that pattern. The next phase
(`spine-migration`) starts from this honest baseline: planning artifacts as
*architectural commitments*, not execution gates.

---

## Delivered (planned via v3 scope-lock)

- **nexus-register retirement** — landed today. Binary deleted, deploy hooks cleaned,
  ~491 LOC of dead code (file-based event writes to a nonexistent Rust watcher) removed.
  Originally scheduled in v3.1 ("Retire nexus-register"); stalled ~7 weeks at the
  deploy-hook layer until today's consolidation pass.
- **AF_UNIX socket ingestion** — `services/socket-server/dispatcher.ts` exists and is
  functional. Coexists with HTTP `/hooks` (collapse to single path is now in
  spine-migration P3).
- **Hook consolidation** — partial. Two telemetry scripts model (gate.sh + telemetry.sh)
  shipped per beads `cc-fyvwp`.

## Delivered (unplanned — built during v3 outside the formal scope)

- **`apps/nexus-statusline`** (originally `nexus-status`) — CC StatusLine extension,
  Bun-compiled, wired into `~/.claude/settings.json`. Renamed today during this
  archive cycle for clarity (`nexus-status` → `nexus-statusline`).
- **`apps/agent` (Bun rewrite)** — full TypeScript/Bun nexus-agent superseding the
  earlier Rust crates (which were archived). Postgres via Drizzle, axum HTTP +
  WebSocket + AF_UNIX socket, peer-connector federation, SSE subscriptions, etc.
- **`apps/swift/nexus`** — macOS menu bar app with active spec at
  `openspec/specs/swift-menubar-client/spec.md` (5 icon variants, panel summon, TTS
  player integration). Tests include `GhosttyLauncherTests.swift` (SSH-attach
  pattern prototype) and `LaunchAgentInstallerTests.swift`.
- **`apps/nextjs`** — full Next.js 15 web dashboard on port 3100 with pages for
  credentials, failures, health, integrations, notifications, projects, sessions,
  settings, specs. xterm.js terminal viewer. Sentry + PostHog instrumentation.
  *Deprecation candidate in spine-migration P5.*
- **Mac listener stack** — `deploy/nexus-notifier.sh` (bash SSE subscriber) +
  `tts-player.plist` + FIFO IPC + ducking modes. Functional but ripe for the
  Swift app to absorb (spine-migration P4).
- **Schema work** — sessions, sessionEvents, notifications, healthSnapshots,
  credentialEvents, elevenlabsCredentials tables. All managed via Drizzle ORM.
- **77 openspec changes archived** during v3.

## Architectural shift discovered during v3

Mid-cycle, the *real* architecture diverged from the planned "peer-to-peer mesh of
equal agents" toward what the spine-migration plan formalizes as **hub-and-spoke**:
homelab is the only dev box, Mac and iPhone are clients only, no peer federation.
The evolution doc (`docs/nexus-evolution.html`, shipped today) is the spike
articulating this shift.

## Deferred (carry-forward to spine-migration)

### Specs

- **`consolidate-mac-tts-listener`** — 5 open tasks. Spec context lives in beads
  `nx-69d9s` (proposal) under epic `nx-ga815`. Removed the Bun nexus-listener on
  2026-05-16 to fix double-audio; banner-click cancel via PID-file IPC is the
  remaining work. This spec's responsibilities largely fold into spine-migration P4
  (Swift app subsumes both notifier + player).

### Open beads (in-progress)

- `nx-tyq0n` — [CAPABILITY] cc-session-tracking
- `nx-69d9s` — [PROPOSAL] consolidate-mac-tts-listener
- `nx-pqx3i` — [IDEA, P4] watchOS voice-to-text for in-flight question response
  (created today, defer to post-spine-migration)

### Architectural commitments (the evolution doc)

The `docs/nexus-evolution.html` spike is the spine-migration scope-lock in spirit.
Six phases (P1–P6) ranging from "obvious wins" (collapse notifications dir,
remove peer-connector, drop slack) through "Apple ecosystem expansion" (iOS embeds
SwiftTerm, watchOS for notifications, Swift owns TTS) to "web deprecation"
(retire `apps/nextjs`) and "Mac stops being a server" (delete all Mac-side
launchd plists, no Mac nexus-agent).

---

## Metrics

| Measure | v3 start | v3 end |
| --- | --- | --- |
| TypeScript files | ~347 | ~340 (after retirement) |
| Active Cargo crates | Rust legacy (per CLAUDE.md) | 0 (full Bun migration) |
| openspec archive | 31 | 77 (46 added during v3) |
| Audit composite score | 100/A | 100/A (held steady) |
| Open beads | 74 (mostly stale) | ~3 in-progress (cleanup happened mid-v3) |
| Active Apple targets | 1 (macOS Swift) | 1 + XcodeGen manifest for 3 (spine-migration P4) |

---

## Lessons

### What worked

- **Responsive execution beat formal pipeline** for a single-developer project. Audit
  findings, beads issues, and direct architectural work delivered more than the
  formal `/plan:scope` → `/plan:strategy` → `/apply:all` pipeline would have. The
  pipeline is built for team coordination; one developer doesn't need its overhead.
- **The audit composite score (100/A) held steady** through 46 new specs — the
  audit-suppressions infrastructure proved its worth.
- **openspec/changes/ as the execution log** — proposal + tasks + delta-specs gave
  structure to each individual change without imposing roadmap pressure. 77 archived
  changes is the actual execution trail.
- **Beads for breadcrumbs** — capturing intent ("Retire nexus-register" → `cc-9v95f`)
  even when the work stalled meant today's session could pick up the thread and
  complete it.

### What didn't

- **Plan v3's scope-lock never got written.** v3 inherited v2's pattern of
  "scope-lock as informal text in context.md or scope-lock.md fragments." If the
  formal pipeline isn't going to be used, the planning artifacts should be
  simplified to match reality.
- **nexus-register retirement stalled at the deploy layer.** The decision was made
  (beads `cc-9v95f`, closed 2026-03-28) but the deploy hooks that built and
  installed the binary were never updated. Result: a "retired" service that was
  still being deployed for 7 weeks. *Lesson: closing a retirement bead means
  removing the deploy artifacts too, not just the source.*
- **Two redundant ingress paths.** HTTP `/hooks` + AF_UNIX socket both feed the
  same dispatcher. Justified during v3 ("cross-machine + local-fast") but with
  spine-migration's "homelab is the only dev box" decision, only socket is needed.
- **The `credentials/` subsystem was misnamed.** Built for Claude credential
  rotation but ended up serving only ElevenLabs encryption. spine-migration P4
  rights this: a real `cc-credential-manager` writes `~/.claude/credentials.json`,
  ElevenLabs key moves to macOS Keychain.

### What should have been done in MVP

- Pino logging enforced from the start. Today's ad-hoc `createLogger` usage means
  no DB sink, no error capture wrapper, no client surface for warnings/errors.
  Carries forward as spine-migration P2.
- Schema-drift detection. The hardcoded `RECOGNIZED_EVENTS` allow-list silently
  drops new CC hook fields. With CC adding `SubagentStart`, `SubagentStop`,
  `TaskCompleted`, `TeammateIdle`, etc., the silent drop is a real telemetry
  gap. Carries forward as spine-migration P2.

---

## Pointers

- Spec archive: `openspec/changes/archive/` (77 entries)
- Beads: `nx-tyq0n`, `nx-69d9s`, `nx-pqx3i` (in-flight or backlog)
- Architecture spike: `docs/nexus-topology.html` (current shape), `docs/nexus-evolution.html` (target shape)
- Next plan: `docs/plan/spine-migration/context.md`
- Tag: `v3-complete` (this commit)
