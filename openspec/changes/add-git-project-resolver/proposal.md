---
status: approved
approved-by: leo@leonardoacosta.dev
approved-at: 2026-05-17T20:26:38Z
---

# Proposal: Add git project resolver to session_start enrichment

## Change ID
`add-git-project-resolver`

## Phase
P2 cc-integration (parent: spine-migration · nx-ma6h8 · feature: nx-tgn1e)

## Summary
On `session_start`, derive the GitHub/Azure DevOps `{owner, repo}` from the session's `cwd` via `git remote get-url origin` and attach to the session row.

## Context
- Adds: `apps/agent/src/services/git-project.ts`
- Modifies: `packages/db/src/schema/sessions.ts` (+2 columns: `git_provider`, `git_owner_repo`)
- Modifies: `apps/agent/src/routes/hooks.ts` (call resolver in session_start handler)
- Migration: Drizzle migration to ALTER TABLE sessions

## Motivation
Today's `cwd` column stores raw filesystem paths. There's no way to query "all sessions in oo this week" or aggregate cost per repo. Deriving the git origin once at session_start gives us a stable, queryable identity.

## Requirements

### Requirement: session_start SHALL enrich with git repo identity when available

When `session_start` arrives with a `cwd`, the resolver SHALL run `git -C $cwd remote get-url origin` and parse the result. Supported URL forms:
- `https://github.com/owner/repo[.git]` → provider=`github`, owner_repo=`owner/repo`
- `git@github.com:owner/repo.git` → provider=`github`, owner_repo=`owner/repo`
- `https://dev.azure.com/org/project/_git/repo` → provider=`azdo`, owner_repo=`org/project/repo`

If the cwd is not a git repo or remote parse fails, both columns SHALL be NULL.

#### Scenario: oo session enriches
- **GIVEN** a session_start with `cwd=/home/leo/dev/oo`
- **WHEN** the resolver runs
- **THEN** `sessions.git_provider='github'` and `sessions.git_owner_repo='leonardoacosta/oo'`
