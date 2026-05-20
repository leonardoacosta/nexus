# Proposal: Homelab emits specs + credentials over /specs + /credentials

## Change ID

homelab-emits-specs-credentials

## Why

After the dashboard-only routing decision (2026-05-19), Nexus.app on Mac
talks only to the homelab agent over Tailscale. But Nexus.app's Specs and
Credentials tabs are empty because both endpoints return empty payloads:

- `GET /specs` returns `[]` — the spec-watcher service isn't actually
  scanning the homelab's workspace tree (`/home/nyaptor/dev/*/openspec/changes/`)
  despite the spec-watcher capability being deployed.
- `GET /credentials` returns `{credentials: [], activeFingerprint: null}` —
  the credential-pool service isn't reading `/home/nyaptor/.claude/.credentials/`
  to surface CC auth state.

The Mac side is correctly wired (`fetchSpecs` + `fetchCredentials` already
called on view mount). The fix is server-side: the homelab agent must
actually scan and emit. The architectural correction is "homelab scans,
Mac consumes" — replaces the wrong-way `mac-local-fs-readers` scaffold
(superseded pre-apply 2026-05-20).

## What Changes

Two agent-side capabilities get teeth:

1. **spec-watcher actually scans** — confirm `/home/nyaptor/dev/*/openspec/changes/`
   glob is in the configured workspace roots, scan on startup + every
   configured interval (60s default per project memory). Emit
   SpecSnapshot for each `<project>/openspec/changes/<spec>/` directory
   found. Populate the existing `has_proposal/has_design/has_tasks`
   tri-state shipped by agent-payload-completeness.

2. **credential-pool actually reads** — `handleListCredentials` (or
   equivalent) reads `~/.claude/.credentials/` on the agent's host (here:
   homelab's nyaptor home dir). For each credential entry, project a row
   into the response shape `{credentials: [...], activeFingerprint: ...}`.
   Determine active fingerprint from the symlink at
   `~/.claude/.credentials/active` (or whatever the canonical CC
   convention is — verify on disk first).

3. **Workspace root configuration** — expose the spec-watcher's workspace
   roots in `~/.config/nexus/` config so it doesn't require code changes
   to add a new dev directory. Default: `~/dev`. Per-agent, persists
   across restarts.

## Context

- depends on: (none — agent-payload-completeness archived 2026-05-20)
- touches: `apps/agent/src/services/spec-watcher/poller.ts`, `apps/agent/src/services/spec-watcher/parser.ts`, `apps/agent/src/services/spec-watcher/config.ts`, `apps/agent/src/routes/specs.ts`, `apps/agent/src/services/credential-pool/reader.ts`, `apps/agent/src/services/credential-pool/index.ts`, `apps/agent/src/routes/credentials.ts`, `apps/agent/src/routes/specs.test.ts`, `apps/agent/src/routes/credentials.test.ts`, `apps/agent/src/services/spec-watcher/poller.test.ts`

## Motivation

Three concrete failure modes the user hit today (2026-05-20):

- **SpecsView empty** despite 30+ active OpenSpec proposals on homelab
  (`/home/nyaptor/dev/nx/openspec/changes/` has many active specs visible
  to anyone with shell access).
- **CredentialsView empty** despite homelab's CC installation having auth
  state. The credential-manager work shipped in earlier specs assumed
  credentials would surface but the read path was never wired.
- **Wasted ceremony**: the mac-local-fs-readers spec scaffolded earlier
  today was architecturally backwards — duplicating logic the agent
  already owns. Superseded pre-apply.

## Locked Decisions

- **Homelab as canonical FS scanner** for both specs and credentials.
  Mac doesn't scan anything; it consumes the agent's emitted shape.
- **No Mac agent revival** for this work — the dashboard-only architecture
  stays intact. Specs and credentials flow Mac-ward over Tailscale.
- **Per-agent workspace roots** — each agent (homelab today, others
  later) decides what to scan. The Mac dashboard simply aggregates
  whatever agents in `agents.toml` report.
- **Existing wire contracts unchanged** — `/specs` already has
  has_proposal/has_design/has_tasks (agent-payload-completeness shipped).
  `/credentials` already has `{credentials, activeFingerprint}` shape.
  This spec only populates them with actual data.

## Out of Scope

- File watchers (FSEvents/inotify-based live updates). The 60s poll is
  sufficient for v1.
- Multi-machine credential aggregation. Each agent emits its own host's
  credentials. Federation across multiple agents is a future concern.
- Editing specs/credentials from Nexus.app. Read-only.
- Spec archive enumeration. `/specs` returns active changes only (not
  archived/<date>-* dirs). That'd belong in a separate spec.
