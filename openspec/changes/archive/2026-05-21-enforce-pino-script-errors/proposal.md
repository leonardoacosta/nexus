---
status: approved
approved-by: leo@leonardoacosta.dev
approved-at: 2026-05-17T20:26:38Z
---

# Proposal: Enforce Pino logging everywhere + script_errors DB sink

## Change ID
`enforce-pino-script-errors`

## Phase
P2 cc-integration (parent: spine-migration · nx-ma6h8 · feature: nx-0bxdw)

## Summary
Audit every script entrypoint to use `createLogger` from `@nexus/core/node`. Add a Pino WARN+ transport that writes to a new `script_errors` table. Wrap every script's `main()` in an error catch that persists context.

## Context
- Adds: `packages/db/src/schema/scriptErrors.ts` (Drizzle table)
- Adds: `packages/core/src/node/pino-db-transport.ts` (Pino transport)
- Modifies: `packages/core/src/node/logger.ts` (wire transport)
- Audits: all scripts in `apps/agent/`, `apps/nexus-statusline/`, `scripts/`, `deploy/`

## Motivation
`createLogger` exists but usage is inconsistent (~50% of scripts ad-hoc `console.log`). No central place to query "what warnings/errors happened in the last 24h." Surface in Swift app's errors pane (P4) requires a queryable sink.

## Requirements

### Requirement: WARN+ log entries SHALL persist to script_errors

When any Pino logger emits at level WARN or higher, the transport SHALL write a row to `script_errors` with: ts, script, level, message, error_class, stack, context (JSON).

### Requirement: every script main SHALL be wrapped in error catch

Every script entrypoint SHALL be wrapped in `withErrorCapture(async () => { /* main */ })` from `@nexus/core/node`. Uncaught throws SHALL be persisted as WARN+ rows before re-raising.

#### Scenario: script crashes are queryable
- **GIVEN** a script throws an uncaught exception
- **WHEN** `SELECT * FROM script_errors WHERE level='error' ORDER BY ts DESC LIMIT 1`
- **THEN** returns one row containing the script name, stack trace, and process context
