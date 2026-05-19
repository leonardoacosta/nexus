# Proposal: Folder-based project auto-discovery + removable reference

## Change ID

folder-based-project-autodiscovery

## Phase

Feature — unifies three symptoms (empty /specs, empty Projects, "claude" session names) behind one discovery mechanism.

## Summary

Three "project list" notions never converge: spec-watcher polls only the
static `~/.claude/scripts/config/projects.json` (empty on agent hosts →
`/specs` always `[]`); `routes/projects.ts:43` derives projects purely from
sessions (`projectId ?? "(unregistered)"` → all "(unregistered)"); a scanner
exists (`projects-discovered.ts:212`) but is `.git`-only, on-demand, never run
at startup. This change adds one startup+periodic folder scanner (markers
`.git` OR `openspec/`) feeding `db/project-registry`, consumed by spec-watcher
AND `/projects`, plus a persisted removable (`hidden`) reference so the user
can prune a discovered project and the scanner won't resurrect it.

## Context

- touches: `apps/agent/src/services/spec-watcher/poller.ts`, `apps/agent/src/db/project-registry.ts`, `apps/agent/src/routes/projects.ts`, `apps/agent/src/routes/projects-discovered.ts`, `apps/swift/nexus-mac/Sources/Dashboard/ProjectsView.swift`, `packages/db/src/schema/projects.ts`
- Resolves: nx-6gbsf; unblocks the projects-empty symptom; feeds nx-tbxgd (session project resolution)

## Motivation

`/openspec:explore` (2026-05-19) confirmed spec/project ingestion is gated
behind a project registry that is never populated on agent hosts (homelab has
27 real openspec changes the watcher ignores). Auto-discovery by folder
contents — exactly the user's direction — collapses nx-6gbsf, the empty
Projects view, and the session-name half of nx-tbxgd into one mechanism, with
a removable reference so discovery does not become noise.

## Requirements

### Requirement: Folder-based project auto-discovery at startup and on interval

The agent MUST discover projects by scanning configured dev-roots for a
directory containing `.git` OR `openspec/`, at startup and on a periodic
interval, persisting them via `db/project-registry` `upsertProjectLocations`.

### Requirement: spec-watcher consumes the project registry

spec-watcher MUST enumerate projects from `db/project-registry` (the
auto-discovered set), not solely the static `projects.json`.

### Requirement: /projects aggregates the registry and excludes hidden

`GET /projects` MUST aggregate the discovered registry and MUST exclude any
project flagged hidden.

### Requirement: A project reference is removable and stays removed

A project MUST be removable via a persisted `hidden` flag (a `PATCH
/projects/:id`); the auto-discovery scanner MUST NOT un-hide a hidden project
on re-scan.
