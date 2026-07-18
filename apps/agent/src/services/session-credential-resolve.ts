/**
 * Resolves the credential/account actually driving a given session, using
 * only signals nx already has TODAY — no new Claude Code-side instrumentation
 * required. Shared by `GET /statusline?sessionId=` (`../routes/statusline.ts`)
 * and `GET /credentials?sessionId=` (`../routes/credentials/handlers-crud.ts`)
 * so both endpoints compose the exact same resolution instead of re-deriving
 * it.
 *
 * ## Resolution order
 *
 * 1. `sessions.credential_id` — an explicit binding written by
 *    `bindSessionCredential` (`services/socket-server/dispatcher.ts`) when a
 *    `session_start` socket event carries a `credential_fingerprint`. This is
 *    the most authoritative signal when present, so it is honored first —
 *    but as of this writing NO real caller ever sends
 *    `credential_fingerprint` (confirmed: zero matches for that field
 *    anywhere in the CC-hook-emitting side of the stack), so this branch is
 *    dead in production today. It is kept as the first check so a future
 *    direct binding is used transparently rather than being shadowed by step 2.
 *
 * 2. The REQUESTING PROCESS's own active-credential snapshot
 *    (`getActiveCredentialSnapshot()`, `../credentials/credential-watcher.ts`),
 *    used ONLY when `session.machine` equals this process's own agent
 *    identity (`getAgentId()`, `@nexus/core/node`).
 *
 *    Why this is safe and not an approximation: nx-agent is deployed ONE
 *    PROCESS PER MACHINE (`agents` table: one row per host, each self-
 *    registering via `upsertSelfInRegistry`), and each process watches only
 *    its OWN host's `~/.claude/.credentials.json` — the single live OAuth
 *    credential file Claude Code maintains for that machine. Every terminal
 *    session running on a given machine necessarily shares that SAME file
 *    (there is only one `~/.claude/.credentials.json` per machine), so "the
 *    account this session is using" and "the account currently active on
 *    this machine" are literally the same fact whenever the session's
 *    machine equals the machine serving the request — which is the common
 *    case, since a caller (e.g. cc-tmux) talks to `localhost:7400` to ask
 *    about its own, same-machine session. This is NOT a lesser fallback; it
 *    is the actual precision ceiling Claude Code's one-credential-file-per-
 *    machine design allows.
 *
 * 3. `null` — no live signal. Either the session belongs to a DIFFERENT
 *    machine than the one serving this request (this process has no
 *    visibility into a remote host's in-memory snapshot), or the local
 *    snapshot has no fingerprint yet (agent just started / file missing),
 *    or the fingerprint has no matching `credentials` row. Callers should
 *    treat `null` as "no session-scoped signal available" and apply
 *    whatever their own pre-existing fallback was (e.g. a global
 *    freshest-active pick) — this resolver does not guess.
 */

import { eq } from "drizzle-orm";
import type { Db } from "@nexus/db";
import { credentials } from "@nexus/db";
import { getAgentId } from "@nexus/core/node";
import type { Account5H7D } from "@nexus/core";
import { getActiveCredentialSnapshot } from "../credentials/credential-watcher";

/** A `credentials` row's usage columns — the subset this module reads. */
export interface CredentialUsageRow {
  id: string;
  usage5hUsed: number | null;
  usage5hLimit: number | null;
  usage5hResetAt: Date | null;
  usage7dUsed: number | null;
  usage7dLimit: number | null;
  usage7dResetAt: Date | null;
}

/** Map a `credentials` row to the `Account5H7D` wire shape. */
export function toAccount5H7D(row: CredentialUsageRow): Account5H7D {
  return {
    accountId: row.id,
    fiveHour: {
      used: row.usage5hUsed ?? 0,
      limit: row.usage5hLimit ?? 0,
      resetsAt: row.usage5hResetAt ? row.usage5hResetAt.toISOString() : null,
    },
    sevenDay: {
      used: row.usage7dUsed ?? 0,
      limit: row.usage7dLimit ?? 0,
      resetsAt: row.usage7dResetAt ? row.usage7dResetAt.toISOString() : null,
    },
  };
}

async function lookupCredentialUsageBy(
  db: Db,
  predicate: ReturnType<typeof eq>,
): Promise<Account5H7D | null> {
  const [row] = await db.select().from(credentials).where(predicate).limit(1);
  return row ? toAccount5H7D(row) : null;
}

/** The subset of a `sessions` row this resolver needs. */
export interface SessionCredentialFields {
  credentialId: string | null;
  machine: string | null;
}

/**
 * Resolve the account (5H/7D usage) actually driving `session`, or `null`
 * when no real signal is available. See the file-level doc for the
 * resolution order and why step 2 is exact, not approximate.
 */
export async function resolveSessionAccountUsage(
  db: Db,
  session: SessionCredentialFields,
): Promise<Account5H7D | null> {
  // 1. Explicit binding (dead in production today; see file doc).
  if (session.credentialId) {
    const acct = await lookupCredentialUsageBy(
      db,
      eq(credentials.id, session.credentialId),
    );
    if (acct) return acct;
  }

  // 2. Same-machine live snapshot — the only case with a real signal.
  if (session.machine && session.machine === getAgentId()) {
    const snap = getActiveCredentialSnapshot();
    if (snap.fingerprint) {
      const acct = await lookupCredentialUsageBy(
        db,
        eq(credentials.fingerprint, snap.fingerprint),
      );
      if (acct) return acct;
    }
  }

  // 3. No live signal for a remote machine's session, or an unresolved
  // local one — never guess.
  return null;
}
