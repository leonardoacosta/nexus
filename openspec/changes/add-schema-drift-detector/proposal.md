---
status: approved
approved-by: leo@leonardoacosta.dev
approved-at: 2026-05-17T20:26:38Z
---

# Proposal: Add hook schema-drift detector

## Change ID
`add-schema-drift-detector`

## Phase
P2 cc-integration (parent: spine-migration · nx-ma6h8 · feature: nx-q9wv4)

## Summary
Detect when Claude Code starts sending new or changed fields in hook payloads. Fingerprint each event_type's payload shape; on drift, emit a `HookSchemaDrift` event (rate-limited 1 fire / event_type / hour).

## Context
- Adds: `apps/agent/src/services/schema-drift.ts`
- Adds: `packages/db/src/schema/hookSchemaFingerprints.ts` (Drizzle table: event_type, fingerprint, first_seen, last_seen)
- Modifies: `apps/agent/src/routes/hooks.ts` (call drift detector before dispatch)
- Related: `drop-recognized-events-allowlist` (P2.5 · nx-uptrm) — drift detector replaces the silent-drop behavior

## Motivation
Today's `RECOGNIZED_EVENTS` allow-list silently drops unknown event types and unknown fields. With CC adding `SubagentStart`, `SubagentStop`, `TaskCompleted`, `TeammateIdle`, etc., the silent drop is a real telemetry gap. The detector turns those drops into visible events.

## Requirements

### Requirement: every hook payload SHALL be fingerprinted

For each incoming hook payload, the detector SHALL compute a SHA-256 of the sorted top-level key set. The fingerprint SHALL be persisted to `hook_schema_fingerprints` keyed by `(event_type, fingerprint)`.

### Requirement: new (event_type, fingerprint) pairs SHALL emit HookSchemaDrift

When a new fingerprint is observed for an event_type, the detector SHALL emit a `HookSchemaDrift` event to the lifecycle bus. Rate limit: at most one `HookSchemaDrift` event per `event_type` per hour.

#### Scenario: CC adds a new field to PreToolUse
- **GIVEN** PreToolUse has fingerprint `abc...` known for 30 days
- **WHEN** CC updates and starts sending PreToolUse with an extra `tool_id` field (new fingerprint `def...`)
- **THEN** the first such payload triggers exactly one `HookSchemaDrift` event with both fingerprints in the payload
