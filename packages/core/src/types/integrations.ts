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
 * The subset of `INTEGRATION_PROVIDERS` that can synthesize speech. `telegram`
 * is a messaging provider and is deliberately absent. A new TTS-capable
 * provider is added here as well as to `INTEGRATION_PROVIDERS` above.
 */
export const TTS_CAPABLE_INTEGRATION_PROVIDERS = ["kokoro"] as const;

/**
 * Providers valid as the prefix of a qualified `provider:voice` project voice
 * override (`provider-qualified-project-voices`). Derived from
 * `TTS_CAPABLE_INTEGRATION_PROVIDERS` rather than hand-listed, so a new
 * TTS-capable integration provider can never be silently omitted here
 * (`derive-tts-provider-lists`).
 *
 * `elevenlabs` is the one hard-coded member: it predates the generic
 * integration registry (it has its own `elevenlabsCredentials` table, not an
 * `INTEGRATION_PROVIDERS` entry) but stays the implicit provider for a bare,
 * unqualified voice id — see `parseQualifiedVoice` below.
 */
export const TTS_VOICE_PROVIDERS: ReadonlySet<string> = new Set<string>([
  "elevenlabs",
  ...TTS_CAPABLE_INTEGRATION_PROVIDERS,
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
 * Rejects loopback (`localhost`, `127.0.0.0/8`, `::1`) and link-local
 * (`169.254.0.0/16`, `fe80::/10`) literal hostnames — the addresses that let a
 * tailnet peer PATCH a TTS endpoint `baseUrl` to reach services on the agent
 * host itself rather than a real TTS deployment (`harden-kokoro-baseurl`).
 * RFC1918 and tailnet (100.64.0.0/10) hosts are NOT rejected — self-hosted
 * kokoro deployments legitimately live there.
 *
 * Accepted limitation: this is a literal-hostname check only, not a resolved
 * one — DNS rebinding to a loopback/link-local answer is not defended against.
 * That would need resolve-then-pin fetch plumbing; exposure is tailnet-only
 * (the operator's own devices), so it isn't worth the complexity today. If
 * the threat model changes, that's a new proposal, not an extension here.
 *
 * Escape hatch: `harden-kokoro-baseurl`'s proposal (§ Decision) pre-authorized
 * `NEXUS_KOKORO_ALLOW_LOOPBACK=1` for the legitimate local-dev case (kokoro on
 * the agent host itself, `http://127.0.0.1:8880`) — the regression this guard
 * caused in `apps/agent/src/routes/integration-credentials.test.ts`. The env
 * read lives in `apps/agent` (`integrations/kokoro-loopback.ts`); this helper
 * stays a pure, always-strict predicate. Callers opt out, it never opts out
 * for them, and the opt-out is kokoro-only.
 */
export function isForbiddenTtsEndpointHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (host === "localhost" || host === "::1") return true;
  if (host.startsWith("127.")) return true;
  if (host.startsWith("169.254.")) return true;
  if (host.startsWith("fe80:")) return true;
  return false;
}

/**
 * Validates a TTS-endpoint `baseUrl`: scheme must be `http`/`https` and the
 * hostname must not be loopback/link-local (`isForbiddenTtsEndpointHost`
 * above). Any future `requiresSecret: false` provider with a user-supplied
 * endpoint URL should reuse this schema rather than re-deriving the check.
 */
function ttsEndpointBaseUrl(allowLoopback = false) {
  return z.string().refine(
    (v) => {
      let url: URL;
      try {
        url = new URL(v);
      } catch {
        return false;
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") return false;
      if (allowLoopback) return true;
      return !isForbiddenTtsEndpointHost(url.hostname);
    },
    { message: "baseUrl must be an http(s) URL with a non-loopback, non-link-local host" },
  );
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
    baseUrl: ttsEndpointBaseUrl(),
    defaultVoice: z.string().min(1).optional(),
  }),
};

/**
 * Loopback-permissive twin of `integrationMetadataSchemas.kokoro`, used ONLY
 * when `apps/agent` observes `NEXUS_KOKORO_ALLOW_LOOPBACK=1`
 * (`integrations/kokoro-loopback.ts`). Scheme validation is unchanged — this
 * relaxes the loopback/link-local host check and nothing else, for kokoro and
 * no other provider (`harden-kokoro-baseurl` § Decision escape hatch).
 */
export const kokoroMetadataSchemaAllowingLoopback = z.object({
  baseUrl: ttsEndpointBaseUrl(true),
  defaultVoice: z.string().min(1).optional(),
});

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
