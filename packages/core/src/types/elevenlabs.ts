/**
 * Zod schemas for ElevenLabs credential management.
 *
 * Shared between the agent (`apps/agent/src/routes/elevenlabs-credentials.ts`,
 * `elevenlabs-voices.ts`) and the dashboard (`apps/nextjs/.../elevenlabs/...`)
 * so the wire shape stays single-sourced.
 *
 * Spec: openspec/changes/add-elevenlabs-credential/
 */

import { z } from "zod";

/**
 * PATCH /elevenlabs/credentials body. All fields optional — only the supplied
 * ones are persisted (partial update).
 */
export const elevenlabsPatchInput = z.object({
  apiKey: z.string().min(1).optional(),
  voiceId: z.string().min(1).optional(),
  voiceName: z.string().min(1).optional(),
});
export type ElevenlabsPatchInput = z.infer<typeof elevenlabsPatchInput>;

/**
 * GET /elevenlabs/credentials response (also returned by PATCH on success).
 *
 * NEVER includes the raw API key or `value_encrypted`. `hasKey` exposes only
 * the existence-bit; the full value is unrecoverable from this shape by
 * design.
 */
export const elevenlabsCredentialsResponse = z.object({
  hasKey: z.boolean(),
  voiceId: z.string().nullable(),
  voiceName: z.string().nullable(),
  lastTestOkAt: z.string().nullable(),
  lastTestStatusCode: z.number().int().nullable(),
  agentId: z.string(),
});
export type ElevenlabsCredentialsResponse = z.infer<
  typeof elevenlabsCredentialsResponse
>;

/**
 * POST /elevenlabs/credentials/test response. `subscription` is present only
 * when ElevenLabs returned a 2xx with parseable subscription data.
 */
export const elevenlabsTestResponse = z.object({
  ok: z.boolean(),
  statusCode: z.number().int(),
  subscription: z
    .object({
      tier: z.string(),
      characterCount: z.number().int(),
      characterLimit: z.number().int(),
      nextResetUnix: z.number().int(),
    })
    .optional(),
});
export type ElevenlabsTestResponse = z.infer<typeof elevenlabsTestResponse>;

/**
 * GET /elevenlabs/voices response. The agent caches the upstream response
 * for 1 hour per agent and returns this shape on every request.
 */
export const elevenlabsVoicesResponse = z.object({
  voices: z.array(
    z.object({
      voiceId: z.string(),
      name: z.string(),
      labels: z.record(z.string(), z.string()).optional(),
    }),
  ),
});
export type ElevenlabsVoicesResponse = z.infer<
  typeof elevenlabsVoicesResponse
>;
