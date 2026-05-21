---
status: approved
approved-by: leo@leonardoacosta.dev
approved-at: 2026-05-17T20:26:38Z
---

# Proposal: Remove Slack notification channel

## Change ID
`remove-slack-channel`

## Phase
P1 consolidation (parent: spine-migration · nx-ma6h8 · feature: nx-mm056)

## Summary
Delete `apps/agent/src/notifications/channels/slack.ts` and its webhook dispatcher path from the notification manager.

## Context
- Deletes: `apps/agent/src/notifications/channels/slack.ts`
- Modifies: `apps/agent/src/notifications/manager.ts` (drop slack route from channel switch)
- Modifies: existing `notifications` schema rows with `channel: 'slack'` remain as historical record (no migration)

## Motivation
Per spine-migration scope, Slack is no longer part of the notification dispatch matrix. Swift app + macOS UNNotificationCenter handle all user-facing notification surfaces. The Slack webhook adds a maintained dependency for zero current use.

## Requirements

### Requirement: slack channel MUST NOT route

After this change, sending a notification with `channel: ['slack']` SHALL log a warning and silently drop the slack dispatch (other channels in the array still route normally).

#### Scenario: slack-only notification is dropped
- **GIVEN** Slack channel is removed
- **WHEN** `POST /notifications/send {channel: ['slack'], ...}` arrives
- **THEN** the request returns 200 with `dispatched: []` and a `script_errors` row is written (P2.4) describing the dropped channel
