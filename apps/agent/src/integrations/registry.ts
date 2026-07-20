/**
 * Provider-keyed integration registry (agent-side).
 *
 * Each entry in `PROVIDER_DESCRIPTORS` pairs a provider id with its non-secret
 * `metadataSchema` (imported from `@nexus/core`, shared with the dashboard) and
 * a `testProbe` that calls the provider's upstream API with the *decrypted*
 * secret. `testProbe` lives here — never in `packages/core` — because it takes
 * the plaintext secret and must never run in the browser.
 *
 * Adding a provider is: append its id to `INTEGRATION_PROVIDERS` (in
 * `@nexus/core`), add its metadata schema there, and add one descriptor here.
 * The generic routes in `routes/integration-credentials.ts` dispatch off this
 * map — an unregistered provider is a 404 before any DB access.
 *
 * See design.md § ProviderDescriptor shape.
 *
 * Spec: openspec/changes/add-integration-registry/
 */

import { fetchWithTimeout } from "@nexus/core/fetch";
import { integrationMetadataSchemas } from "@nexus/core";

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
      if (!baseUrl) return { ok: false, statusCode: null };
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
  },
};
