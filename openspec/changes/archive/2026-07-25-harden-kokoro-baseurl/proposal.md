---
order: 0724a
---

# Proposal: Harden kokoro `baseUrl` Against Tailnet→Host-Network Proxying

## Change ID
`harden-kokoro-baseurl`

> Advisor stamp: authored by the 2026-07-24 `/improve` advisor run against commit `9e4963b9`. Before starting, verify the cited excerpts below still match — if any file has drifted, STOP and report back instead of improvising.

## Summary
The kokoro integration's `baseUrl` metadata is validated only as "any URL" (`z.string().url()`), and the agent's `testProbe`/`listVoices` fetch `${baseUrl}/v1/audio/voices` — with `listVoices` returning the fetched response body to the caller. Because integration routes are deliberately unauthenticated (network-trust posture per `drop-attach-secret-gate` — see `apps/agent/src/server-auth.ts:6-16`), any tailnet peer can PATCH `baseUrl` to point at a loopback or link-local service on the agent host and read its HTTP responses through `GET /integrations/kokoro/voices`, or probe reachability via `POST /integrations/kokoro/test`. Add scheme + host validation so `baseUrl` can only name a plausible kokoro deployment.

## Context
- depends on:
- Modifies: `packages/core/src/types/integrations.ts` (the `integrationMetadataSchemas.kokoro` schema)
- Modifies: `apps/agent/src/integrations/registry.ts` (kokoro `testProbe` / `listVoices` — shared guard before fetch)
- Extends: `apps/agent/src/routes/notifications-voices.test.ts`-style route tests for `integration-credentials` (see Testing)
- touches: `packages/core/src/types/integrations.ts`, `apps/agent/src/integrations/registry.ts`, `apps/agent/src/routes/integration-credentials.test.ts` (or nearest existing suite), `packages/core/src/types/integrations.test.ts` (if present; else co-locate schema tests per repo convention)

## Current state (verified at `9e4963b9`)
`packages/core/src/types/integrations.ts:74-77`:
```ts
kokoro: z.object({
  baseUrl: z.string().url(),
  defaultVoice: z.string().min(1).optional(),
}),
```
`apps/agent/src/integrations/registry.ts:108,122` — both probes do:
```ts
const res = await fetchWithTimeout(`${baseUrl}/v1/audio/voices`, { method: "GET", timeout: 5_000 });
```
and `listVoices` (registry.ts:118-140) parses and **returns the response body** (`voices`) to the route caller.

## Motivation
Found by the 2026-07-24 advisor audit (security category, MED confidence). The agent's open-auth posture is a documented decision — the tailnet is the trust boundary — but `baseUrl` lets a tailnet peer *cross* that boundary: the fetch originates from the agent host, so it reaches loopback services and link-local/metadata addresses that the peer cannot reach directly. The sibling telegram probe is fixed-host (`api.telegram.org`, registry.ts:90) and has no such surface. The marginal risk is response-body disclosure (`listVoices`) and internal port-scanning (`testProbe` reflects status codes).

## Decision (recorded here, not left to the executor)
Legitimate kokoro deployments ARE on private RFC1918 addresses (self-hosted on the homelab LAN / tailnet), so blanket private-range blocking would break the feature. Policy:

1. **Scheme**: only `http:` / `https:` (also migrates off the zod-v4-deprecated chained `.url()` — use `z.url()` or a refine).
2. **Host**: reject loopback (`localhost`, `127.0.0.0/8`, `::1`) and link-local (`169.254.0.0/16`, `fe80::/10`) **literal** hosts at schema-validation time. RFC1918 and tailnet (100.64/10) hosts remain allowed.
3. **Accepted limitation** (record in code comment): DNS-rebinding to a loopback answer is not defended — that would need resolve-then-pin fetch plumbing. Exposure is tailnet-only (operator's own devices); not worth the complexity today. If the threat model changes, that is a NEW proposal.
4. Loopback stays testable: the check lives in one exported helper (e.g. `isForbiddenKokoroHost(hostname)`) so unit tests cover it without HTTP.

Escape hatch: if a legitimate local-dev workflow (kokoro on the same machine as the agent, `http://127.0.0.1:8880`) turns out to be in active use, STOP and report back — the fix would then need an env-var escape (`NEXUS_KOKORO_ALLOW_LOOPBACK=1`) and that's a maintainer call.

## Testing
- Schema unit tests (follow the co-located `*.test.ts` convention, e.g. `packages/core/src/config.test.ts` as the exemplar pattern): `https://kokoro.lan:8880` OK; `http://100.73.182.4:8880` OK; `http://127.0.0.1:8880` rejected; `http://localhost:8880` rejected; `http://169.254.169.254/` rejected; `ftp://x/` rejected; `https://[::1]/` rejected.
- Registry guard test: `testProbe`/`listVoices` with a forbidden persisted `baseUrl` (pre-existing row from before this change) return `{ ok: false, statusCode: null }` without fetching (stub `globalThis.fetch` and assert zero calls — follow the fetch-stub pattern in `apps/agent/src/notifications/channels/tts.test.ts:1-40`, incl. the `mock.module` spread-the-real-barrel rule nx-jlx1c).
- Gates: `pnpm typecheck && pnpm lint && bun test packages/core apps/agent/src/integrations` all green.

## Done Means
- Mechanical: new tests above pass; `pnpm typecheck`, `pnpm lint` green.
- Behavior: a PATCH of `baseUrl` to a loopback/link-local host is rejected with the schema 400; probes against a forbidden already-persisted row no-op instead of fetching.
- Done-when: no code path fetches a `baseUrl` whose literal host is loopback or link-local.

## Scope
- **IN**: kokoro schema validation, a single shared host-guard helper, its use in both registry probes, tests.
- **OUT**: any auth/header gate on the routes (explicitly settled by `drop-attach-secret-gate` — do not re-add); DNS-rebinding defenses (accepted limitation above); telegram provider (fixed-host, unaffected); the Swift clients (they call the agent, not kokoro-direct — verify only that `SettingsTtsView.persistKokoro()` (SettingsTtsView.swift:75) surfaces the new 400 error string, no Swift change expected).

## Maintenance note
Any future `requiresSecret: false` provider with a user-supplied endpoint URL must reuse the same host-guard helper — note this in the "add a provider" comment block at `registry.ts:~10`.
