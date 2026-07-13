/**
 * Zod schemas for the session-keyed context-window API.
 *
 * Shared between the agent (`apps/agent/src/routes/session-context.ts`,
 * `apps/agent/src/server-request-handler.ts`) and the statusline
 * (`apps/nexus-statusline/src/context-guard.ts`) so the wire shape stays
 * single-sourced. Backs the agent's in-memory, session-id-keyed
 * context-window store (ephemeral render-time state, NOT a Postgres table).
 *
 * Spec: openspec/changes/add-session-context-api/
 */

import { z } from "zod";

/**
 * POST /sessions/:id/context body. `usedPercentage` is a finite number in
 * `[0, 100]`; `contextWindowSize` when present is a positive integer.
 */
export const sessionContextPatchInput = z.object({
  usedPercentage: z.number().min(0).max(100),
  contextWindowSize: z.number().int().positive().optional(),
});
export type SessionContextPatchInput = z.infer<typeof sessionContextPatchInput>;

/**
 * GET /sessions/:id/context response for a fresh entry. `contextWindowSize` is
 * nullable (absent when the writer never supplied it); `updatedAt` is ISO 8601.
 */
export const sessionContextResponse = z.object({
  sessionId: z.string(),
  usedPercentage: z.number(),
  contextWindowSize: z.number().nullable(),
  updatedAt: z.string(),
});
export type SessionContextResponse = z.infer<typeof sessionContextResponse>;
