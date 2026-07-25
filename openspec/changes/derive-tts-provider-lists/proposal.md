---
order: 0724h
---

# Proposal: Derive TTS Provider Membership from a Single Source

## Change ID
`derive-tts-provider-lists`

> Advisor stamp: 2026-07-24 `/improve` run against commit `9e4963b9`. Verify cited lines before starting; STOP on drift.

## Summary
TTS provider membership is hand-synced across three TypeScript sites — `INTEGRATION_PROVIDERS` (`packages/core/src/types/integrations.ts:25`), `TTS_VOICE_PROVIDERS` (`:36`), `PROVIDER_DESCRIPTORS` keys (`apps/agent/src/integrations/registry.ts:83`) — plus a fourth copy in Swift (`TTSObserver.swift` provider chain). A future TTS-capable provider added to the registry but missed in `TTS_VOICE_PROVIDERS` silently 400s all its project-voice writes at `notifications-voices.ts:95`. Derive `TTS_VOICE_PROVIDERS` from a declared TTS-capable subset of `INTEGRATION_PROVIDERS` (plus the documented legacy `elevenlabs` special case), add a registry↔core assertion test, and cross-reference the Swift copy in the add-a-provider comment. Deliberately NO plugin framework — a derived const and one assertion.

## Context
- depends on: `harden-kokoro-baseurl`
- touches: `packages/core/src/types/integrations.ts`, `apps/agent/src/integrations/registry.ts`, `apps/agent/src/integrations/registry.test.ts`

## Motivation
Found by the 2026-07-24 advisor audit (tech-debt, MED confidence). `elevenlabs` is deliberately NOT an `INTEGRATION_PROVIDERS` entry (legacy own-table, documented at `integrations.ts:27-35`), so the lists cannot merge outright — but the kokoro overlap is a manual-sync trap the add-a-provider comment (`registry.ts:~10`) doesn't mention. Depends on `harden-kokoro-baseurl` because both write the same region of `integrations.ts` and `registry.ts`; land the hardening first so this diff applies on top.

## Testing
- Unit: `TTS_VOICE_PROVIDERS` equals `{"elevenlabs"} ∪ ttsCapable(INTEGRATION_PROVIDERS)`; membership unchanged at base (`elevenlabs`, `kokoro`).
- Assertion test in `registry.test.ts`: every `PROVIDER_DESCRIPTORS` key ∈ `INTEGRATION_PROVIDERS` (fails on drift in either direction for descriptor-backed providers).
- `pnpm typecheck`, `bun test packages/core apps/agent/src/integrations` green.

## Done Means
- Adding a TTS-capable provider to the single declared list makes the voices route accept its qualified ids with no second edit.
- Core↔registry drift fails a test instead of silently 400ing at runtime.
- The add-a-provider comment names every site, including the Swift `TTSObserver` copy (comment cross-reference only — no Swift code change).

## Scope
- **IN**: the derived const + flag/list in `integrations.ts`, the assertion test, the comment update.
- **OUT**: Swift-side codegen of the list (cross-ref comment only); removing the `elevenlabs` special case; any provider-plugin abstraction; `notifications-voices.ts` (consumes the Set unchanged).
