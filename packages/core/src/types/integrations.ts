/**
 * Zod schemas for the generic integration-credential registry.
 *
 * Shared between the agent (`apps/agent/src/integrations/registry.ts`,
 * `apps/agent/src/routes/integrations.ts`) and the dashboard
 * (`apps/web/src/app/integrations/[provider]/...`) so the wire shape stays
 * single-sourced. Backs the `integration_credentials` table
 * (`packages/db/src/schema/integrationCredentials.ts`).
 *
 * Spec: openspec/changes/add-integration-registry/
 */

import { z } from "zod";

/**
 * Registry of known provider ids. Seeded with `telegram`; adding a provider
 * appends one id here (and one descriptor in the agent registry). `as const`
 * so the array doubles as the source of the provider literal-union type.
 *
 * `kokoro` (add-kokoro-integration-provider) is the first `requiresSecret:
 * false` provider — see `ProviderDescriptor` in
 * `apps/agent/src/integrations/registry.ts` — no API key, just a self-hosted
 * `baseUrl`.
 */
export const INTEGRATION_PROVIDERS = ["telegram", "kokoro"] as const;

/**
 * Providers valid as the prefix of a qualified `provider:voice` project voice
 * override (`provider-qualified-project-voices`). `elevenlabs` predates the
 * generic integration registry (it has its own `elevenlabsCredentials` table,
 * not an `INTEGRATION_PROVIDERS` entry) but stays the implicit provider for a
 * bare, unqualified voice id — see `parseQualifiedVoice` below. `kokoro` is
 * the only `INTEGRATION_PROVIDERS` entry that supports TTS today (`telegram`
 * does not).
 */
export const TTS_VOICE_PROVIDERS: ReadonlySet<string> = new Set([
  "elevenlabs",
  "kokoro",
]);

/** Result of parsing a project voice-override id via `parseQualifiedVoice`. */
export interface QualifiedVoice {
  provider: string;
  voice: string;
}

/**
 * Parse a project voice-override id into its provider + voice components.
 * Splits on the FIRST `:` only, so a voice id may itself contain colons
 * downstream without ambiguity. No separator (the pre-qualification bare
 * format, e.g. an ElevenLabs UUID) defaults to `provider: "elevenlabs"` for
 * backward compat — existing `project_voice_overrides` rows need no
 * migration or re-save.
 */
export function parseQualifiedVoice(id: string): QualifiedVoice {
  const idx = id.indexOf(":");
  if (idx === -1) {
    return { provider: "elevenlabs", voice: id };
  }
  return { provider: id.slice(0, idx), voice: id.slice(idx + 1) };
}

/**
 * Per-provider Zod schemas for the `metadata` JSONB column. Each provider's
 * non-secret fields are validated against its entry before persist. Telegram
 * requires a non-empty `chatId`. Kokoro requires a valid `baseUrl` (its
 * self-hosted TTS endpoint) and an optional default voice.
 */
export const integrationMetadataSchemas: Record<
  (typeof INTEGRATION_PROVIDERS)[number],
  z.ZodTypeAny
> = {
  telegram: z.object({ chatId: z.string().min(1) }),
  kokoro: z.object({
    baseUrl: z.string().url(),
    defaultVoice: z.string().min(1).optional(),
  }),
};

/**
 * GET /integrations/:provider/credentials response (also returned by PATCH on
 * success).
 *
 * NEVER includes the raw secret or `value_encrypted`. `hasSecret` exposes only
 * the existence-bit; the full value is unrecoverable from this shape by design.
 */
export const integrationCredentialsResponse = z.object({
  provider: z.string(),
  hasSecret: z.boolean(),
  metadata: z.record(z.string(), z.unknown()),
  lastTestOkAt: z.string().nullable(),
  lastTestStatusCode: z.number().int().nullable(),
  agentId: z.string(),
});
export type IntegrationCredentialsResponse = z.infer<
  typeof integrationCredentialsResponse
>;

/**
 * PATCH /integrations/:provider/credentials body. All fields optional — only
 * the supplied ones are persisted (partial update). `metadata` is re-validated
 * against the descriptor's provider-specific schema before write.
 */
export const integrationPatchInput = z.object({
  secret: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type IntegrationPatchInput = z.infer<typeof integrationPatchInput>;
