/**
 * Zod schemas for the `sessionId`-scoped usage extension to `GET /credentials`.
 *
 * Lets a caller pass `?sessionId=<id>` to `GET /credentials` and receive an
 * ADDITIVE `sessionUsage` field alongside the existing envelope — the account
 * (5H/7D usage) actually driving that session, resolved via
 * `resolveSessionAccountUsage` (`apps/agent/src/services/session-credential-resolve.ts`,
 * the same resolution `GET /statusline?sessionId=` uses — see that module's
 * doc comment for the resolution order and its honest limitation: a session
 * running on a DIFFERENT machine than the one serving the request has no
 * live signal today, so `accountId`/`fiveHour`/`sevenDay` come back `null`
 * rather than a guessed value).
 *
 * `sessionId` absent/empty → no session-scoped resolution attempted, and the
 * `sessionUsage` key is omitted entirely from the response (existing callers
 * of `GET /credentials` see zero change).
 */

import { z } from "zod";

/** `GET /credentials?sessionId=` query param. */
export const credentialsSessionIdQuery = z.object({
  sessionId: z.string().min(1).nullable(),
});
export type CredentialsSessionIdQuery = z.infer<
  typeof credentialsSessionIdQuery
>;

const usageWindow = z.object({
  used: z.number(),
  limit: z.number(),
  resetsAt: z.string().nullable(),
});

/**
 * Additive `sessionUsage` field on `GET /credentials` when `?sessionId=` is
 * given. `accountId`/`fiveHour`/`sevenDay` are `null` together — there is no
 * partial-resolution state — when the session is unknown or no live
 * credential signal exists for it.
 */
export const credentialsSessionUsageSchema = z.object({
  sessionId: z.string(),
  accountId: z.string().nullable(),
  fiveHour: usageWindow.nullable(),
  sevenDay: usageWindow.nullable(),
});
export type CredentialsSessionUsage = z.infer<
  typeof credentialsSessionUsageSchema
>;
