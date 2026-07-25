/**
 * Provider-keyed integration registry (agent-side).
 *
 * Each entry in `PROVIDER_DESCRIPTORS` pairs a provider id with its non-secret
 * `metadataSchema` (imported from `@nexus/core`, shared with the dashboard) and
 * a `testProbe` that calls the provider's upstream API with the *decrypted*
 * secret. `testProbe` lives here — never in `packages/core` — because it takes
 * the plaintext secret and must never run in the browser.
 *
 * ADDING A PROVIDER — every membership site, in order. Missing one fails
 * silently at runtime rather than at compile time, so treat this as a
 * checklist (`derive-tts-provider-lists`):
 *
 *   1. `INTEGRATION_PROVIDERS` — `packages/core/src/types/integrations.ts`.
 *      The id list; doubles as the provider literal-union type.
 *   2. `integrationMetadataSchemas` — same file. One zod schema per provider;
 *      the `Record` key type makes this one compile-enforced.
 *   3. `TTS_CAPABLE_INTEGRATION_PROVIDERS` — same file. ONLY if the provider
 *      does TTS. `TTS_VOICE_PROVIDERS` (the qualified `provider:voice` prefix
 *      allowlist) derives from it, so nothing else needs editing here.
 *   4. `PROVIDER_DESCRIPTORS` — this file. One descriptor: `metadataSchema`,
 *      `testProbe`, optional `listVoices`, optional `requiresSecret: false`.
 *   5. `ttsVoiceProviders` — `apps/swift/NexusShared/Observers/TTSObserver.swift`.
 *      A hand-maintained cross-language COPY of `TTS_VOICE_PROVIDERS`; no
 *      build step keeps it in sync, so a TTS-capable provider added in TS but
 *      not there is rejected by the Swift clients only.
 *
 * The generic routes in `routes/integration-credentials.ts` dispatch off
 * `PROVIDER_DESCRIPTORS` — an unregistered provider is a 404 before any DB
 * access.
 *
 * Any `requiresSecret: false` provider whose metadata includes a
 * user-supplied endpoint URL (like kokoro's `baseUrl`) MUST validate it with
 * the shared `isForbiddenTtsEndpointHost` guard (`@nexus/core`) — both at the
 * schema layer (`integrationMetadataSchemas`) and again before every fetch in
 * `testProbe`/`listVoices`, the same double-gate kokoro uses below. Skipping
 * either layer reopens the tailnet-peer-reaches-loopback surface
 * `harden-kokoro-baseurl` closed.
 *
 * See design.md § ProviderDescriptor shape.
 *
 * Spec: openspec/changes/add-integration-registry/
 */

import { fetchWithTimeout } from "@nexus/core/fetch";
import { integrationMetadataSchemas, isForbiddenTtsEndpointHost } from "@nexus/core";
import { kokoroLoopbackAllowed } from "./kokoro-loopback";

/**
 * Parses `baseUrl` and reports whether it fails the same scheme/host guard
 * the schema enforces (`isForbiddenTtsEndpointHost`, `@nexus/core`). Guards
 * rows persisted before the schema-level check existed
 * (`harden-kokoro-baseurl`) so a stale forbidden `baseUrl` never reaches
 * `fetch` even if it slipped past validation on write.
 *
 * `allowLoopback` relaxes the host half only (scheme is always enforced) and
 * is passed exclusively by the kokoro descriptor below, from
 * `kokoroLoopbackAllowed()` — the `NEXUS_KOKORO_ALLOW_LOOPBACK` escape hatch.
 */
function isForbiddenBaseUrl(baseUrl: string, allowLoopback = false): boolean {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return true;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return true;
  if (allowLoopback) return false;
  return isForbiddenTtsEndpointHost(url.hostname);
}

/**
 * The zod schema type, derived from the shared metadata-schema map so the
 * agent package doesn't need a direct `zod` dependency.
 */
type MetadataSchema =
  (typeof integrationMetadataSchemas)[keyof typeof integrationMetadataSchemas];

/** Result of a provider "Test connection" probe. */
export interface ProviderTestResult {
  ok: boolean;
  statusCode: number | null;
}

/** Result of a provider "list voices" probe (`provider-qualified-project-voices`). */
export interface ProviderListVoicesResult {
  ok: boolean;
  statusCode: number | null;
  voices: unknown[];
}

/**
 * Describes one integration provider: the registry key, the schema validating
 * its `metadata` JSONB on PATCH, and a connection probe run server-side.
 */
export interface ProviderDescriptor {
  /** Registry key, e.g. "telegram". */
  provider: string;
  /** Validates the `metadata` column on PATCH. Shared with `@nexus/core`. */
  metadataSchema: MetadataSchema;
  /**
   * Whether this provider stores/uses a secret at all. Absent (undefined)
   * means `true` — every existing descriptor (telegram) keeps its current
   * secret-gated behavior unchanged. `false` (kokoro) skips the
   * `value_encrypted`/decrypt gate in `routes/integration-credentials.ts`
   * `handleTestConnection` entirely — the provider is self-hosted and has no
   * API key, just non-secret `metadata` (e.g. a `baseUrl`).
   */
  requiresSecret?: boolean;
  /**
   * Probe the provider with the decrypted secret + stored metadata. MUST NOT
   * throw — network/timeout failures resolve to `{ ok: false, statusCode: null }`.
   * For a `requiresSecret: false` provider, `secret` is always `""` — ignore it.
   */
  testProbe: (
    secret: string,
    metadata: Record<string, unknown>,
  ) => Promise<ProviderTestResult>;
  /**
   * Optional — providers that expose a voice catalog implement this so
   * `GET /integrations/:provider/voices` can proxy it generically. MUST NOT
   * throw; network/timeout failures resolve to `{ ok: false, statusCode:
   * null, voices: [] }`. Absent means the provider has no voice listing —
   * the generic route 404s rather than calling anything.
   */
  listVoices?: (
    secret: string,
    metadata: Record<string, unknown>,
  ) => Promise<ProviderListVoicesResult>;
}

export const PROVIDER_DESCRIPTORS: Record<string, ProviderDescriptor> = {
  telegram: {
    provider: "telegram",
    metadataSchema: integrationMetadataSchemas.telegram,
    testProbe: async (secret) => {
      try {
        const res = await fetchWithTimeout(
          `https://api.telegram.org/bot${secret}/getMe`,
          { method: "GET", timeout: 5_000 },
        );
        return { ok: res.ok, statusCode: res.status };
      } catch {
        // Network failure / timeout — no HTTP exchange occurred.
        return { ok: false, statusCode: null };
      }
    },
  },
  kokoro: {
    provider: "kokoro",
    metadataSchema: integrationMetadataSchemas.kokoro,
    requiresSecret: false,
    testProbe: async (_secret, metadata) => {
      const baseUrl = typeof metadata.baseUrl === "string" ? metadata.baseUrl : "";
      if (!baseUrl || isForbiddenBaseUrl(baseUrl, kokoroLoopbackAllowed())) {
        return { ok: false, statusCode: null };
      }
      try {
        const res = await fetchWithTimeout(`${baseUrl}/v1/audio/voices`, {
          method: "GET",
          timeout: 5_000,
        });
        return { ok: res.ok, statusCode: res.status };
      } catch {
        // Network failure / timeout — no HTTP exchange occurred.
        return { ok: false, statusCode: null };
      }
    },
    listVoices: async (_secret, metadata) => {
      const baseUrl = typeof metadata.baseUrl === "string" ? metadata.baseUrl : "";
      if (!baseUrl || isForbiddenBaseUrl(baseUrl, kokoroLoopbackAllowed())) {
        return { ok: false, statusCode: null, voices: [] };
      }
      try {
        const res = await fetchWithTimeout(`${baseUrl}/v1/audio/voices`, {
          method: "GET",
          timeout: 5_000,
        });
        if (!res.ok) return { ok: false, statusCode: res.status, voices: [] };
        const body: unknown = await res.json();
        // kokoro-fastapi returns `{ "voices": [...] }`; tolerate a bare array
        // too so a future/alternate deployment shape doesn't hard-fail here.
        const voices = Array.isArray(body)
          ? body
          : Array.isArray((body as { voices?: unknown[] })?.voices)
            ? (body as { voices: unknown[] }).voices
            : [];
        return { ok: true, statusCode: res.status, voices };
      } catch {
        // Network failure / timeout / bad JSON — no usable response.
        return { ok: false, statusCode: null, voices: [] };
      }
    },
  },
};
