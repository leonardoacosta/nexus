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
 */
export const INTEGRATION_PROVIDERS = ["telegram"] as const;

/**
 * Per-provider Zod schemas for the `metadata` JSONB column. Each provider's
 * non-secret fields are validated against its entry before persist. Telegram
 * requires a non-empty `chatId`.
 */
export const integrationMetadataSchemas: Record<
  (typeof INTEGRATION_PROVIDERS)[number],
  z.ZodTypeAny
> = {
  telegram: z.object({ chatId: z.string().min(1) }),
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
