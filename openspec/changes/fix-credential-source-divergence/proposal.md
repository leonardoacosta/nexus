# Proposal: Fix credential source divergence (dashboard /credentials reflects real auth)

## Change ID

fix-credential-source-divergence

## Phase

Bug fix — re-scopes nx-t2q5n after exploration found the path fix is necessary but not sufficient.

## Summary

The dashboard `GET /credentials` is empty because three credential subsystems
have diverged with no canonical owner: (1) `cc-credential-manager.ts:39` reads
`~/.claude/credentials.json` (NO leading dot — wrong; file absent), (2)
`credentials/active-credential-watcher.ts:36` reads `~/.claude/.credentials.json`
(WITH dot — correct; file present, 1699 bytes on homelab), (3) the endpoint
`handleListCredentials()` serves `pool.list()` (the credential pool DB, fed by
`credential-watcher.ts` from `~/.config/nexus/credentials/acct-*.json`) — a
third source unrelated to the real Claude Code auth file. Fixing only the path
constant does NOT fix the dashboard. This change fixes the path AND designates
a canonical source so `/credentials` reflects the real active credential.

## Context

- touches: `apps/agent/src/cc-credential-manager.ts`, `apps/agent/src/credentials/active-credential-watcher.ts`, `apps/agent/src/routes/credentials/handlers-crud.ts`
- Re-scopes/resolves: nx-t2q5n

## Motivation

The Credentials dashboard view is dead on every agent host. Exploration
(2026-05-19) confirmed the real Claude Code OAuth file is
`~/.claude/.credentials.json` (dotted) and the credential-manager points at a
non-existent no-dot path, while the endpoint reads a separate empty pool. The
schema parser is correct (`claudeAiOauth.{accessToken,refreshToken,expiresAt,
subscriptionType}`) — only the path + the canonical-source wiring are wrong.

## Requirements

### Requirement: Credential manager reads the real Claude Code auth path

`cc-credential-manager` MUST read `~/.claude/.credentials.json` (leading dot)
by default, consistent with `active-credential-watcher`. Every no-dot
`credentials.json` reference in the credential subsystem MUST be reconciled.

### Requirement: GET /credentials reflects the real active credential

The `/credentials` endpoint MUST surface the real active Claude Code
credential read from `~/.claude/.credentials.json`. A single canonical source
MUST own this; the endpoint MUST NOT return empty when a valid
`.credentials.json` exists on the agent host.
