/**
 * Zod schema for `GET /credentials/active`.
 *
 * The agent watches `~/.claude/.credentials.json` (a symlink to the
 * currently-active credential file) and exposes the matched pool
 * fingerprint here. Both ends — the Next.js server action and the
 * agent route handler — use this schema to avoid drift.
 */

import { z } from "zod";

export const credentialsActiveResponseSchema = z.object({
  /**
   * SHA-256 fingerprint of the currently-active credential, or null when
   * the file is missing / unparseable / has no matching pool row.
   */
  fingerprint: z.string().nullable(),
  /**
   * Absolute path the agent resolved via `fs.realpath()`. Useful for the
   * UI tooltip ("Claude Code is reading …/.config/nexus/credentials/acct-XYZ.json").
   */
  resolvedPath: z.string().nullable(),
  /** ISO-8601 timestamp of the most recent watch event. */
  observedAt: z.string(),
});

export type CredentialsActiveResponse = z.infer<
  typeof credentialsActiveResponseSchema
>;
