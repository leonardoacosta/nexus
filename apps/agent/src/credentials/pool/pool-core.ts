import type { Db } from "@nexus/db";
import { credentials, ccProfileEvents } from "@nexus/db";
import { eq, and, sql, asc, gt, gte, lte, inArray } from "drizzle-orm";
import { logger } from "@nexus/core/node";
import { fetchWithTimeout } from "@nexus/core/fetch";
import {
  getCredentialById,
  queryAllCredentials,
  queryExpiredCooldowns,
  queryStaleLeases,
} from "../store";
import type { CredentialRow } from "../store";
import { encrypt, decrypt } from "../encryption";
import {
  computeCredentialFingerprint,
  extractCredentialMetadata,
  CredentialParseError,
} from "../credentials.helpers";
import type { Buffer } from "node:buffer";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SpanStatusCode } from "@opentelemetry/api";
import { getTracer } from "../../otel";
import { CredentialDeleteError } from "./errors";
import type {
  CredentialPromoteResult,
  ManualSwapResult,
  CredentialDuplicateEntry,
  CredentialListEntry,
} from "./types";
import { recordFailure } from "../../services/credential-pool/rate-limit-tracker";
import { recordSwap } from "../../services/credential-pool/swap-tracker";

/** Default cooldown duration in milliseconds (5 minutes). */
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

/** Default lease TTL in milliseconds (30 minutes). */
const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1000;

/** Five-hour window in milliseconds for predictive pre-rotation utilization check. */
const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;

/** Credential pool with lease/release/cooldown lifecycle. */
export class CredentialPool {
  private db: Db;
  private cooldownMs: number;
  private leaseTtlMs: number;
  private encryptionKey: Buffer | null;
  private prerotateThreshold: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    db: Db,
    options?: {
      cooldownMs?: number;
      leaseTtlMs?: number;
      encryptionKey?: Buffer;
      prerotateThreshold?: number;
    },
  ) {
    this.db = db;
    this.cooldownMs = options?.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.leaseTtlMs = options?.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    this.encryptionKey = options?.encryptionKey ?? null;
    this.prerotateThreshold = options?.prerotateThreshold ?? 0.85;
  }

  // ─── Internal helpers ───────────────────────────────────────────────────────

  private requireKey(): Buffer {
    if (!this.encryptionKey) {
      throw new Error(
        "CredentialPool: encryption key not configured. " +
          "Pass encryptionKey to constructor or set NEXUS_ENCRYPTION_KEY.",
      );
    }
    return this.encryptionKey;
  }

  /**
   * Persist a credential lifecycle event to the audit table.
   * Fire-and-forget — failures are logged but never block the caller.
   */
  private async emitEvent(
    credentialId: string,
    eventType: string,
    sessionId?: string | null,
    metadata?: Record<string, unknown> | null,
  ): Promise<void> {
    try {
      await this.db.insert(ccProfileEvents).values({
        id: randomUUID(),
        profileId: credentialId,
        eventType,
        sessionId: sessionId ?? null,
        metadata: metadata ?? null,
      });
    } catch (err) {
      logger.warn(
        { credentialId, eventType, error: err instanceof Error ? err.message : String(err) },
        "failed to persist credential event",
      );
    }
  }

  /**
   * Probe the Anthropic /api/oauth/profile endpoint and persist account
   * identity fields on the credential row. Best-effort: caller should
   * `.catch()` the returned promise.
   *
   * Exposed publicly so route handlers (handleRefreshIdentity /
   * handleRefreshIdentityAll) can re-probe individual rows whose identity
   * fields are blank. The original constructor-time best-effort probe in
   * `add()` continues to call this method internally — no callsite change.
   */
  async probeIdentity(
    credentialId: string,
    plaintext: string,
  ): Promise<void> {
    let accessToken: string;
    try {
      const parsed = JSON.parse(plaintext);
      accessToken = parsed?.claudeAiOauth?.accessToken;
      if (!accessToken || typeof accessToken !== "string") return;
    } catch {
      return;
    }

    const res = await fetchWithTimeout(
      "https://api.anthropic.com/api/oauth/profile",
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 5_000,
      },
    );
    if (!res.ok) {
      logger.debug(
        { credentialId, status: res.status },
        "identity probe returned non-200",
      );
      return;
    }

    const profile = (await res.json()) as {
      account?: { uuid?: string; full_name?: string; email?: string };
      organization?: { uuid?: string; name?: string };
    };

    await this.db
      .update(credentials)
      .set({
        accountEmail: profile.account?.email ?? null,
        accountName: profile.account?.full_name ?? null,
        accountUuid: profile.account?.uuid ?? null,
        orgName: profile.organization?.name ?? null,
        orgUuid: profile.organization?.uuid ?? null,
      })
      .where(eq(credentials.id, credentialId));

    logger.info(
      {
        credentialId,
        email: profile.account?.email,
        org: profile.organization?.name,
        event: "credential.identity_probed",
      },
      "credential identity probed successfully",
    );
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Add a new credential to the pool (value is encrypted at rest).
   *
   * Computes the credential's fingerprint from the decrypted plaintext and
   * attaches the new row to its duplicate group. If no row in the same group
   * exists yet, the new row becomes the group's primary. Otherwise the row
   * is inserted with `is_primary = false`; the caller / a follow-up step
   * decides whether to promote it.
   *
   * Throws `CredentialParseError` (re-thrown with original `code` set) if
   * the plaintext cannot be parsed as an OAuth blob — HTTP handlers should
   * translate this to a 400.
   */
  async add(credential: {
    id: string;
    name: string;
    type: string;
    value_plaintext: string;
  }): Promise<"inserted" | "updated"> {
    const key = this.requireKey();

    // Compute the fingerprint up front. If parsing fails, surface the typed
    // error so the HTTP layer can return 400 BAD_REQUEST instead of 500.
    let fingerprint: string;
    try {
      fingerprint = computeCredentialFingerprint(credential.value_plaintext);
    } catch (err) {
      if (err instanceof CredentialParseError) {
        throw err;
      }
      throw new CredentialParseError(
        `failed to compute credential fingerprint: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const valueEncrypted = encrypt(credential.value_plaintext, key);
    const metadata = extractCredentialMetadata(credential.value_plaintext);
    const now = new Date();

    const outcome = await this.db.transaction(async (tx) => {
      // Re-import guard: a row with the SAME fingerprint AND SAME name is the
      // same pool file re-imported (token refresh rewrites acct-*.json in place;
      // the refresh token — hence the fingerprint — is stable across access-token
      // refreshes). Update it in place so its lease / cooldown / rate-limit state
      // survives, instead of appending a duplicate row. A fingerprint match with a
      // DIFFERENT name is a distinct pool file for the same account (by-design
      // duplicate group) and MUST fall through to the insert path below.
      const sameFileRows = await tx
        .select()
        .from(credentials)
        .where(
          and(
            eq(credentials.fingerprint, fingerprint),
            eq(credentials.name, credential.name),
          ),
        )
        .limit(2); // fetch 2 so we can detect the ambiguous >1 case

      if (sameFileRows.length > 1) {
        // Data drift: more than one row already shares this (fingerprint, name).
        // Refuse to guess which to update — surface it (STOP condition).
        throw new Error(
          `credential re-import ambiguous: ${sameFileRows.length} rows share fingerprint+name for "${credential.name}"`,
        );
      }

      const existingSameFile = sameFileRows[0] ?? null;
      if (existingSameFile !== null) {
        await tx
          .update(credentials)
          .set({
            // Refresh the token material + volatile metadata only. Preserve
            // status / leasedBy / leasedAt / cooldownUntil / rateLimitCount /
            // isPrimary / duplicateGroupId / id / createdAt untouched.
            valueEncrypted,
            encryptionKeyId: "v1",
            subscriptionType: metadata.subscriptionType,
            rateLimitTier: metadata.rateLimitTier,
            expiresAt: metadata.expiresAt,
            mcpProviders: metadata.mcpProviders,
            updatedAt: now,
          })
          .where(eq(credentials.id, existingSameFile.id));

        logger.info(
          {
            id: existingSameFile.id,
            name: credential.name,
            fingerprint,
            event: "credential.reimport_updated",
          },
          "credential re-import updated existing row in place",
        );
        return "updated" as const;
      }

      // Resolve the duplicate-group anchor for this fingerprint. Prefer the
      // duplicateGroupId already carried by ANY row that currently has this
      // exact fingerprint -- regardless of that row's own name or
      // isPrimary -- over blindly minting a fresh group id equal to the
      // fingerprint itself. This matters because `updateSecret()`
      // intentionally rotates a row's `fingerprint` in place while leaving
      // `duplicateGroupId` untouched (the stable per-account anchor, by
      // design survives a refresh-token rotation -- see updateSecret()'s
      // doc above). So a row's CURRENT fingerprint does not always equal
      // its own duplicateGroupId. Without this lookup, a re-observation of
      // that same (rotated) fingerprint under a different derived name --
      // e.g. active-credential-watcher's `acct-<fp8>` fallback after an
      // agent restart resets its in-memory rotation tracking -- would miss
      // the `(fingerprint, name)` re-import guard above AND miss this
      // group lookup (whose OLD anchor no longer equals the new
      // fingerprint), and mint a second, disconnected duplicateGroupId for
      // what is actually the same account: two rows sharing a fingerprint
      // but disagreeing on duplicateGroupId (nx-9qsmb.2).
      const anyRowWithFingerprint = await tx
        .select()
        .from(credentials)
        .where(eq(credentials.fingerprint, fingerprint))
        .limit(1);
      const groupId = anyRowWithFingerprint[0]?.duplicateGroupId ?? fingerprint;

      // Look for an existing primary in the same duplicate group.
      const existingPrimaryRows = await tx
        .select()
        .from(credentials)
        .where(
          and(
            eq(credentials.duplicateGroupId, groupId),
            eq(credentials.isPrimary, true),
          ),
        )
        .limit(1);

      const existingPrimary = existingPrimaryRows[0] ?? null;
      const isFirstInGroup = existingPrimary === null;

      // Determine whether the new row should outrank the current primary.
      // Newest mtime (updatedAt) wins; tiebreak alphabetical name ascending.
      // First-in-group is unconditionally primary.
      let newRowIsPrimary = isFirstInGroup;
      if (existingPrimary !== null) {
        const newMtime = now.getTime();
        const oldMtime = existingPrimary.updatedAt.getTime();
        if (newMtime > oldMtime) {
          newRowIsPrimary = true;
        } else if (newMtime === oldMtime) {
          newRowIsPrimary =
            credential.name.localeCompare(existingPrimary.name) < 0;
        }
      }

      await tx.insert(credentials).values({
        id: credential.id,
        name: credential.name,
        type: credential.type,
        valueEncrypted,
        encryptionKeyId: "v1",
        // NULL = shared across all agents (current implicit behavior).
        agentId: null,
        status: "available",
        leasedBy: null,
        leasedAt: null,
        cooldownUntil: null,
        rateLimitCount: 0,
        fingerprint,
        duplicateGroupId: groupId,
        isPrimary: newRowIsPrimary,
        subscriptionType: metadata.subscriptionType,
        rateLimitTier: metadata.rateLimitTier,
        expiresAt: metadata.expiresAt,
        mcpProviders: metadata.mcpProviders,
        createdAt: now,
        updatedAt: now,
      });

      // If the new row is taking over as primary, demote the existing one
      // in the same transaction so the group has exactly one primary at all
      // times.
      if (newRowIsPrimary && existingPrimary !== null) {
        await tx
          .update(credentials)
          .set({ isPrimary: false })
          .where(eq(credentials.id, existingPrimary.id));
        logger.info(
          {
            id: credential.id,
            demotedId: existingPrimary.id,
            fingerprint,
            event: "credential.primary_swap",
          },
          "credential primary swapped on add (newer mtime)",
        );
      }

      return "inserted" as const;
    });

    // Update-in-place re-imports return early — no "added" event / probe for an
    // in-place refresh of an existing row.
    if (outcome === "updated") {
      return "updated";
    }

    void this.emitEvent(credential.id, "added", null, { name: credential.name, fingerprint });

    logger.info(
      { id: credential.id, name: credential.name, fingerprint },
      "credential added to pool",
    );

    // Best-effort: probe Anthropic profile API for account identity.
    // Non-blocking — failures are logged but never surface to the caller.
    this.probeIdentity(credential.id, credential.value_plaintext).catch(
      (err) =>
        logger.warn(
          { id: credential.id, err },
          "best-effort identity probe failed on add",
        ),
    );

    return "inserted";
  }

  /**
   * Lease the next available credential of the given type.
   *
   * Weighted round-robin: prefers credentials with fewer historical rate-limit
   * events (rate_limit_count ASC), then oldest-lease-first (leased_at ASC NULLS FIRST).
   *
   * The read + update is wrapped in a transaction with SELECT FOR UPDATE to
   * prevent concurrent callers from double-leasing the same credential.
   *
   * Returns the credential row with the decrypted value, or null if exhausted.
   */
  async lease(type: string, leasedBy: string): Promise<CredentialRow | null> {
    const span = getTracer().startSpan("credential.lease", {
      attributes: { type, leasedBy },
    });
    try {
      return await (async () => {
        const result = await this.db.transaction(async (tx) => {
          // Recover expired cooldowns inside the lease transaction so
          // cooldown-recovery and lease-selection are atomic. Running this
          // outside the tx (the previous behaviour) opened a rotation race:
          // a row recovered by the standalone UPDATE could be SELECT-FOR-UPDATE
          // leased by a concurrent lease() call before this caller's select ran,
          // double-leasing the same credential. Folding the recovery into the
          // tx makes the recover-UPDATE + lease SELECT FOR UPDATE one unit.
          const now = new Date();
          const expired = await tx
            .select()
            .from(credentials)
            .where(
              and(
                eq(credentials.status, "cooldown"),
                lte(credentials.cooldownUntil, now),
              ),
            );

          if (expired.length > 0) {
            const recoveredIds = expired.map((c) => c.id);
            // The status guard here is load-bearing, not redundant with the
            // `expired` SELECT above: under READ COMMITTED, a concurrent
            // lease() call's recovery UPDATE can block on this row's lock,
            // then unblock after this transaction commits. Postgres only
            // re-evaluates the UPDATE's own WHERE clause against the new row
            // version (EvalPlanQual) — an `id IN (...)`-only WHERE still
            // matches and would stomp a freshly-leased row back to
            // "available", double-leasing it. Requiring status = "cooldown"
            // makes the re-check fail once this row has moved on.
            await tx
              .update(credentials)
              .set({
                status: "available",
                leasedBy: null,
                leasedAt: null,
                cooldownUntil: null,
              })
              .where(
                and(
                  inArray(credentials.id, recoveredIds),
                  eq(credentials.status, "cooldown"),
                ),
              );

            for (const credential of expired) {
              logger.info(
                { id: credential.id, event: "credential.cooldown_exited" },
                "credential recovered from cooldown",
              );
            }
          }

          // Weighted round-robin: ORDER BY rate_limit_count ASC, leased_at ASC NULLS FIRST.
          // SAFE: static SQL fragment, no user input interpolated. Drizzle's asc()
          // helper does not support NULLS FIRST; the literal column name matches
          // the schema mapping credentials.leasedAt → "leased_at" column.
          const rows = await tx
            .select()
            .from(credentials)
            .where(
              and(
                eq(credentials.status, "available"),
                eq(credentials.type, type),
                // credential-identity: only primary rows are leaseable.
                // Non-primary duplicates remain visible in GET /credentials
                // but never participate in lease selection.
                eq(credentials.isPrimary, true),
              ),
            )
            .orderBy(
              asc(credentials.rateLimitCount),
              sql`leased_at asc nulls first`,
            )
            .for("update")
            .limit(1);

          if (rows.length === 0) {
            return null;
          }

          const credential = rows[0]!;

          await tx
            .update(credentials)
            .set({ status: "leased", leasedBy, leasedAt: now, cooldownUntil: null })
            .where(eq(credentials.id, credential.id));

          // Re-fetch within the transaction to get the final state
          const updated = await tx
            .select()
            .from(credentials)
            .where(eq(credentials.id, credential.id))
            .limit(1);

          return updated[0] ?? null;
        });

        if (result === null) {
          logger.warn({ type }, "credential pool exhausted");
          return null;
        }

        // Decrypt the stored value before returning to the caller
        const key = this.requireKey();
        const decryptedRow: CredentialRow = {
          ...result,
          valueEncrypted: result.valueEncrypted
            ? decrypt(result.valueEncrypted, key)
            : null,
        };

        logger.info(
          { id: result.id, type, leasedBy, event: "credential.leased" },
          "credential leased",
        );
        void this.emitEvent(result.id, "leased", leasedBy);
        return decryptedRow;
      })();
    } catch (err) {
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  }

  /** Release a leased credential back to available. */
  async release(id: string): Promise<boolean> {
    const span = getTracer().startSpan("credential.release", {
      attributes: { id },
    });
    try {
      return await (async () => {
        const credential = await getCredentialById(this.db, id);
        if (!credential) {
          logger.warn({ id }, "release failed — credential not found");
          return false;
        }

        if (credential.status !== "leased") {
          logger.warn({ id, status: credential.status }, "release failed — credential not in leased state");
          return false;
        }

        await this.db
          .update(credentials)
          .set({ status: "available", leasedBy: null, leasedAt: null, cooldownUntil: null })
          .where(eq(credentials.id, id));

        logger.info({ id, event: "credential.released" }, "credential released");
        void this.emitEvent(id, "released");
        return true;
      })();
    } catch (err) {
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  }

  /**
   * Put a credential on cooldown (e.g., after rate limit detection).
   *
   * Atomically increments rate_limit_count and sets status to cooldown.
   * Returns the cooled-down credential row and the next available credential (or null).
   */
  async reportRateLimit(
    id: string,
    leasedBy: string,
  ): Promise<{ cooledDown: CredentialRow; next: CredentialRow | null } | null> {
    const span = getTracer().startSpan("credential.cooldown", {
      attributes: { id },
    });
    try {
      return await (async () => {
        const credential = await getCredentialById(this.db, id);
        if (!credential) return null;

        // Record the 429 against the credential's fingerprint so the
        // /credentials reader can project `rateLimit429Count` (24h window).
        if (credential.fingerprint) {
          recordFailure(credential.fingerprint, 429);
        }

        const cooldownUntil = new Date(Date.now() + this.cooldownMs);

        // Atomically increment rate_limit_count and transition to cooldown.
        // SAFE: static SQL fragment, no user input interpolated. Column name
        // matches the schema mapping credentials.rateLimitCount → "rate_limit_count".
        await this.db
          .update(credentials)
          .set({
            status: "cooldown",
            leasedBy: null,
            leasedAt: null,
            cooldownUntil,
            rateLimitCount: sql`rate_limit_count + 1`,
          })
          .where(eq(credentials.id, id));

        logger.info(
          { id, cooldown_until: cooldownUntil, event: "credential.cooldown_entered" },
          "credential on cooldown (rate limited)",
        );
        void this.emitEvent(id, "cooldown_entered", leasedBy, { cooldown_until: cooldownUntil.toISOString() });

        const cooledDown = (await getCredentialById(this.db, id))!;

        // Try to lease the next available credential of the same type
        const next = await this.lease(credential.type, leasedBy);

        // Record the auto-swap on both fingerprints (rate-limited → next).
        if (next) {
          recordSwap(cooledDown.fingerprint, next.fingerprint);
        }

        return { cooledDown, next };
      })();
    } catch (err) {
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  }

  /**
   * Return the decrypted plaintext value for a credential, or null if not found.
   * Used by the health-check endpoint to probe the credential without leasing it.
   */
  async getDecrypted(id: string): Promise<string | null> {
    const row = await getCredentialById(this.db, id);
    if (!row) return null;
    if (!row.valueEncrypted) return null;
    const key = this.requireKey();
    return decrypt(row.valueEncrypted, key);
  }

  /**
   * Overwrite a credential's token material after an out-of-band OAuth
   * refresh (see `services/credential-refresh-job.ts`).
   *
   * Unlike `add()`, this recomputes the fingerprint from
   * `newPlaintextBlob`'s `claudeAiOauth.refreshToken` — an OAuth refresh
   * grant rotates the refresh token, so matching by the OLD
   * `(fingerprint, name)` pair (what `add()` does) would miss and INSERT a
   * duplicate row instead of updating this one. `duplicateGroupId` is
   * intentionally left untouched: per the schema comment on
   * `credentials.duplicateGroupId`, it is the stable per-account anchor and
   * MUST survive a refresh-token rotation, unlike `fingerprint` itself.
   * `status`/`leasedBy`/`cooldownUntil`/`isPrimary`/`rateLimitCount` are all
   * left untouched for the same reason `add()`'s update-in-place path
   * preserves them.
   *
   * @throws {CredentialParseError} if `newPlaintextBlob` does not carry a
   *   non-empty `claudeAiOauth.refreshToken` — surfaced so a malformed
   *   refresh response can never silently corrupt a pool row.
   */
  async updateSecret(
    id: string,
    newPlaintextBlob: object,
    newExpiresAt: Date,
  ): Promise<void> {
    const key = this.requireKey();
    const plaintext = JSON.stringify(newPlaintextBlob);

    // Re-throws CredentialParseError as-is (same contract as add()) — a
    // caller passing a blob with no refreshToken is a programming error, not
    // a runtime condition to swallow.
    const fingerprint = computeCredentialFingerprint(plaintext);
    const valueEncrypted = encrypt(plaintext, key);

    await this.db
      .update(credentials)
      .set({
        valueEncrypted,
        encryptionKeyId: "v1",
        expiresAt: newExpiresAt,
        fingerprint,
        updatedAt: new Date(),
      })
      .where(eq(credentials.id, id));

    logger.info(
      {
        id,
        fingerprint: fingerprint.slice(0, 8),
        event: "credential.secret_updated",
      },
      "credential secret updated after OAuth refresh",
    );
    void this.emitEvent(id, "secret_updated", null, { fingerprint });
  }

  /**
   * Promote the given credential to `is_primary = true` within its duplicate
   * group, atomically demoting whoever currently holds the primary slot.
   *
   * Idempotent: if the row is already primary, returns immediately with
   * `previousPrimary = null` so callers can skip side effects (audit log,
   * symlink swap) on no-op promotions.
   *
   * @throws Error("credential not found") when `id` is unknown.
   * @throws Error("cross-group promotion not allowed") when the existing
   *   primary belongs to a different `duplicate_group_id` than `id` — this
   *   should never happen in steady state and indicates a data drift bug.
   */
  async promote(id: string): Promise<CredentialPromoteResult> {
    const span = getTracer().startSpan("credential.promote", {
      attributes: { id },
    });
    try {
      return await (async () => {
        return this.db.transaction(async (tx) => {
          const targetRows = await tx
            .select()
            .from(credentials)
            .where(eq(credentials.id, id))
            .limit(1);
          const target = targetRows[0];
          if (!target) {
            throw new Error("credential not found");
          }

          const groupId = target.duplicateGroupId ?? target.fingerprint;

          // Idempotent no-op if already primary.
          if (target.isPrimary) {
            return {
              groupId,
              newPrimary: target.id,
              previousPrimary: null,
            };
          }

          const currentPrimaryRows = await tx
            .select()
            .from(credentials)
            .where(
              and(
                eq(credentials.duplicateGroupId, groupId),
                eq(credentials.isPrimary, true),
              ),
            )
            .limit(1);
          const currentPrimary = currentPrimaryRows[0] ?? null;

          // Defensive guard: if a primary somehow exists in a different
          // duplicate_group_id (data drift), refuse to swap and surface the
          // inconsistency to the caller.
          if (
            currentPrimary !== null &&
            (currentPrimary.duplicateGroupId ?? currentPrimary.fingerprint) !==
              groupId
          ) {
            throw new Error("cross-group promotion not allowed");
          }

          if (currentPrimary !== null) {
            await tx
              .update(credentials)
              .set({ isPrimary: false })
              .where(eq(credentials.id, currentPrimary.id));
          }

          await tx
            .update(credentials)
            .set({ isPrimary: true })
            .where(eq(credentials.id, target.id));

          logger.info(
            {
              id: target.id,
              demotedId: currentPrimary?.id ?? null,
              fingerprint: groupId,
              event: "credential.promoted",
            },
            "credential promoted to primary",
          );

          const newPrimaryId = target.id;
          const previousPrimary = currentPrimary?.id ?? null;
          void this.emitEvent(newPrimaryId, "promoted", null, { previous_primary: previousPrimary });

          return {
            groupId,
            newPrimary: newPrimaryId,
            previousPrimary,
          };
        });
      })();
    } catch (err) {
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  }

  /**
   * Force the pool to prefer a specific credential by parking the current
   * best-available on a timed cooldown. Intended for external callers (tmux
   * menus) that need to manually switch the active credential.
   *
   * @returns The swap result, or `null` if `targetId` is not found in the DB.
   * @throws Error("target credential is in cooldown") when the target is
   *   currently cooling down and cannot be activated.
   */
  async manualSwap(targetId: string): Promise<ManualSwapResult | null> {
    const span = getTracer().startSpan("credential.manual_swap", {
      attributes: { targetId },
    });
    try {
      return await (async () => {
        // 1. Look up targetId in the DB.
        const target = await getCredentialById(this.db, targetId);
        if (!target) {
          return null;
        }

        // 2. If target is in cooldown status, throw.
        if (target.status === "cooldown") {
          throw new Error("target credential is in cooldown");
        }

        // 3. Find the current "best available" credential (excluding the target).
        const bestRows = await this.db
          .select()
          .from(credentials)
          .where(
            and(
              eq(credentials.status, "available"),
              eq(credentials.isPrimary, true),
            ),
          )
          .orderBy(
            asc(credentials.rateLimitCount),
            sql`leased_at asc nulls first`,
          )
          .limit(2); // fetch up to 2 so we can exclude target and still have one

        const bestAvailable = bestRows.find((r) => r.id !== targetId) ?? null;

        // If no other best-available found, target is already the only/best.
        if (!bestAvailable) {
          logger.info(
            { targetId, event: "credential.manual_swap" },
            "manual swap: target is already best-available, no parking needed",
          );
          return { parked: null, activated: target };
        }

        // 4. Park the best-available credential on cooldown.
        const cooldownUntil = new Date(Date.now() + this.cooldownMs);
        await this.db
          .update(credentials)
          .set({
            status: "cooldown",
            cooldownUntil,
            leasedBy: null,
            leasedAt: null,
          })
          .where(eq(credentials.id, bestAvailable.id));

        // 5. Emit credential events for both.
        void this.emitEvent(bestAvailable.id, "manual_swap_out");
        void this.emitEvent(targetId, "manual_swap_in");

        // 6. Re-fetch both rows to return the final state.
        const parkedRow = await getCredentialById(this.db, bestAvailable.id);
        const activatedRow = await getCredentialById(this.db, targetId);

        // Record manual swap event so /credentials lastSwapAt reflects it.
        recordSwap(parkedRow?.fingerprint, activatedRow?.fingerprint);

        logger.info(
          {
            targetId,
            parkedId: bestAvailable.id,
            cooldownUntil,
            event: "credential.manual_swap",
          },
          "manual swap: parked current best-available, target is now preferred",
        );

        return { parked: parkedRow, activated: activatedRow! };
      })();
    } catch (err) {
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  }

  /**
   * Delete a credential by id with orphan protection.
   *
   * Behavior:
   * - Unknown id → throws `Error("credential not found")`.
   * - `is_primary = false`, OR group size 1 → row is deleted unconditionally.
   * - `is_primary = true` AND group has more than one member:
   *   - No `opts.promoteId` → throws `CredentialDeleteError` with the list
   *     of eligible sibling ids; HTTP layer translates to 409.
   *   - With `opts.promoteId` → promotes the named sibling first
   *     (re-using `promote()` semantics), then deletes the original row.
   *
   * All DB writes for the multi-member primary case run in a single
   * transaction so a crash mid-delete cannot leave the group without a
   * primary.
   */
  async deleteById(
    id: string,
    opts?: { promoteId?: string },
  ): Promise<void> {
    const span = getTracer().startSpan("credential.delete", {
      attributes: { id },
    });
    try {
      return await (async () => {
        await this.db.transaction(async (tx) => {
          const targetRows = await tx
            .select()
            .from(credentials)
            .where(eq(credentials.id, id))
            .limit(1);
          const target = targetRows[0];
          if (!target) {
            throw new Error("credential not found");
          }

          const groupId = target.duplicateGroupId ?? target.fingerprint;

          // Fetch every member of the same duplicate group so we can decide
          // whether orphan protection applies and so the error response can
          // name the eligible promotion targets.
          const groupMembers = await tx
            .select()
            .from(credentials)
            .where(eq(credentials.duplicateGroupId, groupId));

          const isMultiMember = groupMembers.length > 1;
          const isPrimary = target.isPrimary;

          // Primary of a multi-member group requires explicit promotion.
          if (isPrimary && isMultiMember) {
            const siblings = groupMembers
              .filter((m) => m.id !== target.id)
              .map((m) => m.id);

            if (!opts?.promoteId) {
              throw new CredentialDeleteError(
                `cannot delete primary credential ${id}: group has ${groupMembers.length} members, must specify a sibling id via promoteId`,
                siblings,
              );
            }

            if (!siblings.includes(opts.promoteId)) {
              throw new CredentialDeleteError(
                `promoteId ${opts.promoteId} is not a sibling of ${id}`,
                siblings,
              );
            }

            // Inline promotion (cannot call this.promote because it opens
            // its own transaction). Demote target, promote sibling.
            await tx
              .update(credentials)
              .set({ isPrimary: false })
              .where(eq(credentials.id, target.id));
            await tx
              .update(credentials)
              .set({ isPrimary: true })
              .where(eq(credentials.id, opts.promoteId));

            logger.info(
              {
                id: target.id,
                promotedId: opts.promoteId,
                fingerprint: groupId,
                event: "credential.promoted",
              },
              "credential promoted to primary (delete-with-promote)",
            );
          }

          // Finally, delete the original row.
          await tx.delete(credentials).where(eq(credentials.id, target.id));

          logger.info(
            {
              id: target.id,
              fingerprint: groupId,
              promotedId: opts?.promoteId ?? null,
              event: "credential.deleted",
            },
            "credential deleted from pool",
          );
          void this.emitEvent(id, "deleted", null, { fingerprint: groupId });
        });
      })();
    } catch (err) {
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  }

  /**
   * Sibling entry nested under a primary credential's `duplicates` array.
   * Intentionally omits `valueEncrypted` and any token material.
   */
  // eslint-disable-next-line @typescript-eslint/member-ordering
  // (kept inline so the type lives next to its only consumer)

  /** List all credentials with status info (no values exposed). */
  async list(): Promise<CredentialListEntry[]> {
    const rows = await queryAllCredentials(this.db);

    // Index every row by its duplicate group so primaries can attach a
    // `duplicates` array of their non-primary siblings without N extra
    // queries. Rows without a duplicate_group_id (legacy pre-backfill) fall
    // back to their fingerprint, then to a synthetic group keyed by id.
    type SafeRow = Omit<CredentialRow, "valueEncrypted">;
    const groupMap = new Map<string, SafeRow[]>();
    const safeRows: SafeRow[] = rows.map(({ valueEncrypted: _e, ...rest }) => rest);

    for (const row of safeRows) {
      const groupKey = row.duplicateGroupId ?? row.fingerprint ?? `__id:${row.id}`;
      const bucket = groupMap.get(groupKey) ?? [];
      bucket.push(row);
      groupMap.set(groupKey, bucket);
    }

    return safeRows.map((row) => {
      if (!row.isPrimary) {
        // Non-primary rows appear at the top level too (per spec) but
        // without a nested duplicates array.
        return row satisfies CredentialListEntry;
      }
      const groupKey =
        row.duplicateGroupId ?? row.fingerprint ?? `__id:${row.id}`;
      const siblings = (groupMap.get(groupKey) ?? [])
        .filter((m) => m.id !== row.id)
        .map<CredentialDuplicateEntry>((m) => ({
          id: m.id,
          name: m.name,
          fingerprint: m.fingerprint,
          duplicateGroupId: m.duplicateGroupId,
          isPrimary: m.isPrimary,
          status: m.status,
          subscriptionType: m.subscriptionType,
          rateLimitTier: m.rateLimitTier,
          expiresAt: m.expiresAt,
          accountEmail: m.accountEmail,
          accountName: m.accountName,
          accountUuid: m.accountUuid,
          orgName: m.orgName,
          orgUuid: m.orgUuid,
          mcpProviders: m.mcpProviders,
          createdAt: m.createdAt,
          updatedAt: m.updatedAt,
        }));
      return { ...row, duplicates: siblings };
    });
  }

  /**
   * Re-read credential files from disk and update metadata columns
   * (expiresAt, subscriptionType, rateLimitTier, mcpProviders) for each
   * credential whose fingerprint matches a DB row.
   */
  async refreshMetadata(): Promise<number> {
    const credDir = join(process.env.HOME ?? "", ".config/nexus/credentials");

    let allFiles: string[];
    try {
      allFiles = await readdir(credDir);
    } catch {
      logger.warn({ dir: credDir }, "credential directory not found, skipping metadata refresh");
      return 0;
    }

    const files = allFiles.filter((f) => f.startsWith("acct-") && f.endsWith(".json"));
    let updated = 0;

    for (const file of files) {
      try {
        const plaintext = await readFile(join(credDir, file), "utf-8");
        const fingerprint = computeCredentialFingerprint(plaintext);
        const metadata = extractCredentialMetadata(plaintext);

        await this.db
          .update(credentials)
          .set({
            expiresAt: metadata.expiresAt,
            subscriptionType: metadata.subscriptionType,
            rateLimitTier: metadata.rateLimitTier,
            mcpProviders: metadata.mcpProviders,
            updatedAt: new Date(),
          })
          .where(eq(credentials.fingerprint, fingerprint));

        updated++;
      } catch (err) {
        logger.warn(
          { file, error: err instanceof Error ? err.message : String(err) },
          "failed to refresh credential metadata",
        );
      }
    }

    if (updated > 0) {
      logger.info({ updated, total: files.length }, "credential metadata refreshed from disk");
      void this.emitEvent("system", "metadata_refreshed", null, { updated, total: files.length });
    }
    return updated;
  }

  /** Recover credentials whose cooldown has expired. */
  async recoverExpiredCooldowns(): Promise<number> {
    const expired = await queryExpiredCooldowns(this.db);
    if (expired.length === 0) return 0;

    const ids = expired.map((c) => c.id);

    await this.db
      .update(credentials)
      .set({ status: "available", leasedBy: null, leasedAt: null, cooldownUntil: null })
      .where(inArray(credentials.id, ids));

    for (const credential of expired) {
      logger.info(
        { id: credential.id, event: "credential.cooldown_exited" },
        "credential recovered from cooldown",
      );
    }
    return expired.length;
  }

  /** Clean up stale leases (leased longer than TTL). */
  async cleanupStaleLeases(): Promise<number> {
    const threshold = new Date(Date.now() - this.leaseTtlMs);
    const stale = await queryStaleLeases(this.db, threshold);
    if (stale.length === 0) return 0;

    const ids = stale.map((c) => c.id);

    await this.db
      .update(credentials)
      .set({ status: "available", leasedBy: null, leasedAt: null, cooldownUntil: null })
      .where(inArray(credentials.id, ids));

    for (const credential of stale) {
      logger.info(
        { id: credential.id, event: "credential.stale_lease_released" },
        "stale lease released",
      );
    }
    return stale.length;
  }

  /**
   * Check all currently-leased credentials for predictive pre-rotation.
   *
   * A credential is proactively rotated when its 5-hour utilization rate
   * (rate_limit_count / maximum_per_5h) reaches the configured threshold.
   *
   * Since we track cumulative hits rather than a sliding-window rate, we use
   * the leasedAt timestamp as a proxy: if the credential has accumulated hits
   * in a short window, the density approaches the threshold.
   *
   * Simplified implementation: rotate any credential whose rate_limit_count
   * incremented at all within the last 5 hours (i.e., leasedAt is within the
   * window AND rate_limit_count > 0). Full utilization tracking deferred to a
   * future change when the usage API is integrated.
   */
  async checkPrerotation(): Promise<number> {
    const windowStart = new Date(Date.now() - FIVE_HOUR_MS);

    // Find leased credentials that have accumulated rate limit hits in the window
    const leasedRows = await this.db
      .select()
      .from(credentials)
      .where(
        and(
          eq(credentials.status, "leased"),
          gt(credentials.rateLimitCount, 0),
          gte(credentials.leasedAt, windowStart),
        ),
      );

    let rotated = 0;
    for (const cred of leasedRows) {
      // Compute a simplified utilization: assume a cap of 50 calls/5h (Anthropic default)
      const cap = 50;
      const utilization = (cred.rateLimitCount ?? 0) / cap;
      if (utilization >= this.prerotateThreshold && cred.leasedBy) {
        logger.info(
          {
            id: cred.id,
            utilization,
            threshold: this.prerotateThreshold,
            event: "credential.prerotation_triggered",
          },
          "predictive pre-rotation: rotating credential before exhaustion",
        );
        await this.reportRateLimit(cred.id, cred.leasedBy);
        rotated++;
      }
    }
    return rotated;
  }

  /** Start periodic cleanup of expired cooldowns and stale leases. */
  startCleanup(intervalMs: number = 60_000): void {
    this.cleanupTimer = setInterval(async () => {
      await this.recoverExpiredCooldowns().catch((err) =>
        logger.error({ err }, "cleanup: recoverExpiredCooldowns failed"),
      );
      await this.cleanupStaleLeases().catch((err) =>
        logger.error({ err }, "cleanup: cleanupStaleLeases failed"),
      );
      await this.checkPrerotation().catch((err) =>
        logger.error({ err }, "cleanup: checkPrerotation failed"),
      );
    }, intervalMs);
  }

  /** Stop the cleanup timer. */
  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}
