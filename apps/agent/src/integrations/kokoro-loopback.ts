/**
 * `NEXUS_KOKORO_ALLOW_LOOPBACK` — the local-dev escape hatch
 * `harden-kokoro-baseurl` (§ Decision) pre-authorized for the one legitimate
 * loopback case: kokoro running on the same host as the agent
 * (`http://127.0.0.1:8880`). Set to `"1"` to opt out; anything else keeps the
 * strict guard.
 *
 * Kokoro-only by construction — the two consumers (`integrations/registry.ts`
 * probe guards, `routes/integration-credentials.ts` PATCH metadata schema)
 * both gate on `provider === "kokoro"` before consulting this. The underlying
 * `isForbiddenTtsEndpointHost` guard in `@nexus/core` stays pure and always
 * strict; the env read lives here so `packages/core` never touches
 * `process.env`.
 *
 * Read at call time, not module load, so tests can scope the flag to a single
 * `describe` via `beforeEach`/`afterEach`.
 */
export function kokoroLoopbackAllowed(): boolean {
  return process.env.NEXUS_KOKORO_ALLOW_LOOPBACK === "1";
}
