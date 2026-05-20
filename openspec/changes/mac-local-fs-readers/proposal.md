# Proposal: Mac-local FS readers for specs + credentials

## Change ID

mac-local-fs-readers

## Why

The dashboard-only routing decision (2026-05-19) made Nexus.app subscribe
only to the homelab agent over Tailscale. This was correct for TTS and
notifications (the homelab is the canonical notification brain), but
accidentally cut Nexus.app off from filesystem state that lives on THIS
Mac: OpenSpec proposals under `~/dev/*/openspec/changes/` and Claude Code
credentials under `~/.claude/.credentials/`. Specs and credentials are
machine-local — there's no benefit to round-tripping them through homelab,
and homelab has no copy of them anyway.

Current state: dashboard's SpecsView shows zero entries because homelab's
`/specs` returns `[]` (homelab has no Claude sessions, no `~/dev` workspace
to scan). CredentialsView shows `credentials: []` for the same reason. The
data sits on the Mac filesystem, unread.

## What Changes

Add two local filesystem readers to `NexusShared` and merge their output
with homelab data in `NexusAggregateClient`:

1. **`SpecsLocalReader`** — scans configured workspace roots
   (`~/dev/*/openspec/changes/`, plus archive subdirs if needed) and
   produces `[SpecSummary]` matching the existing wire shape. Computes
   `has_proposal/has_design/has_tasks` tri-state from filesystem presence.
   Computes `completedTasks/totalTasks` from `tasks.md` checkbox counts.

2. **`CredentialsLocalReader`** — reads
   `~/.claude/.credentials/` (or whatever the canonical CC credentials
   path is on this Mac — verify) and produces the same Codable shape that
   the dashboard's CredentialsView expects.

3. **`NexusAggregateClient.fetchSpecs()` / `fetchCredentials()`** — merge
   local reader output with any homelab response. Local sources are
   per-Mac, homelab sources are agent-wide; merge by deduplicating on
   primary key. For specs, the key is `(project, name)`. For credentials,
   the key is the credential fingerprint or account id.

4. **Workspace roots configuration** — extend Nexus.app Settings to let
   the user configure additional workspace roots beyond `~/dev/*`. Default
   discovers any `~/dev/<slug>/openspec/` directory. No-op if `~/dev` is
   absent.

## Context

- depends on: (none — agent-payload-completeness archived 2026-05-20)
- touches: `apps/swift/NexusShared/LocalSources/SpecsLocalReader.swift`, `apps/swift/NexusShared/LocalSources/CredentialsLocalReader.swift`, `apps/swift/NexusShared/LocalSources/WorkspaceRoots.swift`, `apps/swift/NexusShared/Networking/NexusAggregateClient.swift`, `apps/swift/nexus-mac/Sources/Dashboard/SpecsView.swift`, `apps/swift/nexus-mac/Sources/Dashboard/CredentialsView.swift`, `apps/swift/NexusSharedTests/SpecsLocalReaderTests.swift`, `apps/swift/NexusSharedTests/CredentialsLocalReaderTests.swift`

## Motivation

The dashboard-only decision sacrificed something we didn't notice
immediately: filesystem-resident state on the operator's machine. Three
specific failure modes:

- **SpecsView empty**: the user can't see their own open OpenSpec
  proposals from Nexus.app — the whole point of the Specs tab.
- **CredentialsView empty**: the credential-status surface that
  motivated `add-cc-credential-manager` is invisible.
- **Local-only operations have no UI**: future features like "show me my
  draft proposals" or "show me credential expiry" need a path to local
  filesystem reads regardless.

## Locked Decisions

- **Local-first for FS state**: specs and credentials are read directly
  from disk on the Mac. No agent involvement.
- **Hybrid merge**: NexusAggregateClient merges local + homelab fetches.
  If both have an entry with the same key, local wins (it's the source of
  truth for the operator's own state).
- **No file watcher initially**: views refresh on `.task` mount + manual
  pull-to-refresh. FSEvents-based live updates are a future follow-up.
- **Workspace discovery via glob**: `~/dev/*/openspec/changes/` is the
  default scan path. Configurable via Settings.

## Out of Scope

- File watchers / live filesystem events. Manual refresh is enough.
- Cross-Mac aggregation (each Mac sees its own local state plus the
  homelab's shared state — not other Macs').
- Editing specs/credentials from Nexus.app. Read-only.
- iCloud or external storage adapters.
