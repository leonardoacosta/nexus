# spine-migration Plan Context

## Previous Phase: v3

**Archived**: `docs/plan/archive/2026-05-17-v3/`
**Completion**: `docs/plan/archive/2026-05-17-v3/COMPLETION.md`
**Tag**: `v3-complete`

v3 was scoped with intent but executed organically — formal planning artifacts never
locked. Today's session retroactively force-archived v3 and consolidated the
architectural shift discovered mid-cycle into a coherent next-phase plan: **the spine
model**.

---

## The Architectural Shift

v3 inherited an aspirational "peer-to-peer mesh of equal agents" topology. Reality
proved it's a single developer + one homelab + one Mac + (soon) one iPhone + watchOS.
Everything peer-federated, every dual-purpose service, every cross-machine ingress
path exists to support a multi-developer topology that doesn't apply.

spine-migration is the consolidation. **Homelab is the hub.** Mac, iPhone, watchOS are
clients over Tailnet. One agent. One DB. One ingress. One Swift app (three Apple
targets). Web dashboard retires.

The full architectural diff lives in `docs/nexus-evolution.html` — 5 chapters,
52 evolution rows, 6 migration phases. That document is this plan's *scope-lock in
spirit*. The phases below mirror it.

---

## State at spine-migration Start

### Audit posture
- Composite score: 100/A (held through v3)
- Architecture confirmed: full TypeScript/Bun (Rust legacy fully migrated during v3)

### Codebase
- TypeScript files: ~340 (post-nexus-register retirement)
- Test files: ~107
- Apps: `agent`, `nextjs`, `nexus-statusline`, `swift/nexus`
- Packages: `core`, `db`, `ui`
- New artifact: `apps/swift/project.yml` (XcodeGen manifest for macOS + iOS + watchOS)

### Active openspec changes
- `consolidate-mac-tts-listener` — 5 open tasks, folds into spine-migration P4

### Beads queue
- `nx-tyq0n` — [CAPABILITY] cc-session-tracking (in-progress)
- `nx-69d9s` — [PROPOSAL] consolidate-mac-tts-listener (in-progress, folds into P4)
- `nx-pqx3i` — [IDEA, P4] watchOS voice-to-text (post-sprint)

### Today's session shipped (P1 work, ahead of formal phase start)
- Retired nexus-register (binary + deploy artifacts + dead event-writer code)
- Renamed nexus-status → nexus-statusline
- Wrote XcodeGen manifest
- Wrote architecture docs (topology + evolution)
- Wrote `safe-rename` helper (codified the rg+perl+git-diff rename pattern)

---

## Carry-Forward: Open Ideas (1)

| Slug / ID | Description |
| --- | --- |
| `nx-pqx3i` (P4, idea) | watchOS voice-to-text for in-flight question response. User receives notification on watch, dictates answer, agent routes back via `tmux send-keys`. Pairs with iOS embed-SwiftTerm work. **Defer to post-spine-migration.** |

---

## Carry-Forward: Deferred Tasks

### From consolidate-mac-tts-listener (5 open)

The spec's banner-click cancel feature lives in the bash listener via
`current-utterance.pid` IPC. In the spine model, the entire bash listener + player
stack gets absorbed by the Swift menu bar app — so these tasks fold into
spine-migration P4 (Swift owns audio) rather than being executed against the bash
implementation.

**Recommendation**: close `consolidate-mac-tts-listener` with a "superseded by
spine-migration P4" reason once P4 starts.

---

## Carry-Forward: Lessons from v3

1. **Responsive execution beats formal pipeline for single-dev work.** Don't force
   `/plan:scope` → `/plan:strategy` if openspec/changes/ is doing the job. spine-migration
   formalizes only what needs formalization (the six-phase migration order).

2. **Retirement isn't done until deploy artifacts are gone.** nexus-register's
   7-week deploy-layer stall taught us this. Future REMOVE rows must explicitly
   include deploy/install hook cleanup.

3. **Audit posture is worth holding.** Composite 100/A held through 46 spec
   additions during v3. Keep the audit-suppressions discipline.

4. **Codify recurring patterns as scripts.** Today's `safe-rename` is the first
   such codification. The rg+perl+git-diff pattern was used ad-hoc many times
   before being made first-class.

---

## The Six-Phase Migration Plan

(Full detail in `docs/nexus-evolution.html` Chapter 05 timeline.)

### P1 — Consolidation (week 1) — *partially shipped today*
Reap the obvious wins. Dead code, one-off services, scope drift.

- [x] Retire nexus-register *(shipped today)*
- [x] Rename nexus-status → nexus-statusline *(shipped today)*
- [ ] Collapse `notifications/` to single file
- [ ] Collapse `credentials/` dir (interim, before P4 rewrite)
- [ ] Remove `services/peer-connector.ts`
- [ ] Remove `notifications/channels/slack.ts`
- [ ] Bump session-manager idle threshold 5m → 60m

### P2 — CC Integration (week 2)
Surface telemetry that's already arriving.

- [ ] Schema-drift detector + `hook_schema_fingerprints` table (1 fire / event_type / hour)
- [ ] `git-project-resolver` + sessions schema +2 cols (`git_provider`, `git_owner_repo`)
- [ ] `parent_session_id` + `child_role` tracking on sessions table
- [ ] Pino enforced everywhere + `script_errors` DB sink
- [ ] Drop `RECOGNIZED_EVENTS` allow-list — accept any hook payload

### P3 — Ingress Collapse (week 3)
One door in.

- [ ] AF_UNIX dispatcher reaches full feature parity with `/hooks`
- [ ] CC hook scripts switch to socket helper (`nc -U` or tiny shim binary)
- [ ] Update `~/.claude/settings.json` hooks to use the helper
- [ ] Delete `routes/hooks.ts` after one cycle of running both

### P4 — Apple Ecosystem (week 4-6) — *XcodeGen manifest shipped today*
Three targets, one codebase.

- [x] XcodeGen manifest written *(shipped today)*
- [ ] `xcodegen generate` + audit signing settings (Leo's call)
- [ ] Build `NexusShared` framework (models, NexusClient, observers)
- [ ] Scaffold `nexus-ios` (embeds SwiftTerm for in-app attach)
- [ ] Scaffold `nexus-watch` (notifications + permission grants)
- [ ] Swift takes ownership of ElevenLabs synthesis (key → Keychain)
- [ ] `cc-credential-manager.ts` (writes `~/.claude/credentials.json` directly)
- [ ] Remove `notifications/channels/tts.ts` + `desktop.ts`
- [ ] Supersede `consolidate-mac-tts-listener` spec (absorbed)

### P5 — Web Deprecation (week 7-8)
Swift reaches parity, web retires.

- [ ] Swift dashboard feature parity (specs, credentials, failures, notifications,
      projects, sessions, settings, health)
- [ ] Delete `apps/nextjs/`
- [ ] Delete `packages/ui/`
- [ ] Delete `deploy/nexus-dashboard.service`
- [ ] Delete `deploy/traefik/`
- [ ] Audit `deploy/nexus-bundle-manager.sh` — likely delete

### P6 — Final Cleanup (week 9)
Mac stops being a server.

- [ ] Delete `deploy/com.nexus.agent.plist` (no Mac agent)
- [ ] Delete `deploy/nexus-notifier.sh` + `notifier.plist` + `tts-player.plist`
- [ ] Delete `deploy/nexus-listener.ts` (decommissioned)
- [ ] Delete `deploy/nexus-stub.swift`
- [ ] Make `install.sh` env-aware (macOS → build Swift app, Linux → systemd)
- [ ] Document the spine officially

### Post-sprint (deferred)
- `nx-pqx3i` — watchOS voice-to-text for question response

---

## Open Questions for spine-migration

1. **`nexus-dashboard.service` removal timing** — kept while web is alive (P5).
   Coordinate removal with `apps/nextjs/` delete in same commit?
2. **`cc-credential-manager` rollout** — wrap `~/.claude/credentials.json` actively,
   or observe-only with manual swap UX in Swift app first?
3. **iOS APNS provisioning** — requires Apple Developer entitlement setup. When in P4?
4. **Tailscale ACLs** — verify Mac + iPhone both have Tailnet identity for the homelab
   agent. May need a Tailscale ACL update for the Swift app's HTTP/SSE access.

---

## Suggested Next Step

`/plan:strategy docs/plan/spine-migration` — run the formal pipeline to lock
scope-lock.md, prd.md, roadmap.md from this context. Or, continuing the v3 pattern,
treat this `context.md` + `docs/nexus-evolution.html` as the working plan and execute
P1 cleanup work directly via openspec/changes/ proposals.

**Recommendation**: skip the formal pipeline (v3 lesson). Execute P1 via openspec
change proposals starting next session. The phases in this doc are the
*architectural commitments*; openspec is the execution log.
