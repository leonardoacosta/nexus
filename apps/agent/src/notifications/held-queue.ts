/**
 * Durable held queue (openspec/changes/context-aware-routing, Phase 1).
 *
 * Replaces the in-memory meeting buffer (`buffer.ts`'s `pendingIds` ring +
 * sidecar metadata) which lost held items on every agent restart (systemd
 * reload, post-merge deploy fan-out, OOM). Held / digested notifications now
 * persist in the `presence_holds` table and survive restart: on boot the agent
 * calls `loadPending()` and schedules a flush at each row's `hold_until`; on
 * flush the row is stamped `released_at` and a `PresenceHoldReleased` lifecycle
 * event fires.
 *
 * This is the durable side of the meeting-hold path (Rule 2). The notification
 * *payload* is stored verbatim as jsonb so it is restored intact across a
 * restart without re-deriving it from the rules engine.
 */

import type { Db } from "@nexus/db";
import { presenceHolds } from "@nexus/db";
import type { PresenceHold, PresenceHoldPayload } from "@nexus/db";
import { and, asc, eq, isNull, lte } from "drizzle-orm";
import { createLogger } from "@nexus/core/node";
import { lifecycleBus } from "../services/lifecycle-bus";

const log = createLogger("agent:notifications:held-queue");

/** Arguments for enqueuing a hold. */
export interface HoldInput {
  id: string;
  payload: PresenceHoldPayload;
  holdUntil: Date;
  reason?: string;
}

export class HeldQueue {
  private readonly db: Db;
  private readonly userId: string;
  /** Active flush timers keyed by hold id — cleared on flush / shutdown. */
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(db: Db, userId: string) {
    this.db = db;
    this.userId = userId;
  }

  /**
   * Persist a hold. Idempotent on the id (a duplicate id updates the existing
   * row's hold_until + payload rather than erroring) so a re-held notification
   * after a restart does not collide.
   */
  async hold(input: HoldInput): Promise<void> {
    await this.db
      .insert(presenceHolds)
      .values({
        id: input.id,
        userId: this.userId,
        payload: input.payload,
        holdUntil: input.holdUntil,
        reason: input.reason ?? null,
      })
      .onConflictDoUpdate({
        target: presenceHolds.id,
        set: {
          payload: input.payload,
          holdUntil: input.holdUntil,
          reason: input.reason ?? null,
          releasedAt: null,
        },
      });
    log.debug(
      { id: input.id, holdUntil: input.holdUntil.toISOString() },
      "held-queue: persisted hold",
    );
  }

  /**
   * Load every pending (unreleased) hold for this user, ordered by holdUntil.
   * Called on agent boot to rehydrate the queue across a restart.
   */
  async loadPending(): Promise<PresenceHold[]> {
    return this.db
      .select()
      .from(presenceHolds)
      .where(
        and(
          eq(presenceHolds.userId, this.userId),
          isNull(presenceHolds.releasedAt),
        ),
      )
      .orderBy(asc(presenceHolds.holdUntil));
  }

  /**
   * Flush a single hold by id: stamp `released_at = now()` and emit
   * `PresenceHoldReleased`. Returns the flushed row, or null if it was already
   * released / missing (idempotent — a double flush is a no-op).
   */
  async flush(id: string): Promise<PresenceHold | null> {
    const updated = await this.db
      .update(presenceHolds)
      .set({ releasedAt: new Date() })
      .where(
        and(eq(presenceHolds.id, id), isNull(presenceHolds.releasedAt)),
      )
      .returning();

    const row = updated[0];
    if (!row) return null;

    this.clearTimer(id);
    lifecycleBus.emit("PresenceHoldReleased", { id: row.id });
    log.info({ id: row.id }, "held-queue: flushed hold");
    return row;
  }

  /**
   * Flush every pending hold whose `hold_until` is at or before now. Returns
   * the flushed rows. Used on boot (catch up on holds that came due while the
   * agent was down) and by the scheduled flush tick.
   */
  async flushDue(now: Date = new Date()): Promise<PresenceHold[]> {
    const due = await this.db
      .select()
      .from(presenceHolds)
      .where(
        and(
          eq(presenceHolds.userId, this.userId),
          isNull(presenceHolds.releasedAt),
          lte(presenceHolds.holdUntil, now),
        ),
      )
      .orderBy(asc(presenceHolds.holdUntil));

    const flushed: PresenceHold[] = [];
    for (const row of due) {
      const r = await this.flush(row.id);
      if (r) flushed.push(r);
    }
    return flushed;
  }

  /**
   * Schedule a flush timer for a single hold at its holdUntil. A hold already
   * past due is flushed immediately. Re-scheduling the same id replaces the
   * prior timer.
   */
  scheduleFlush(id: string, holdUntil: Date, onFlush?: (row: PresenceHold) => void): void {
    this.clearTimer(id);
    const delay = Math.max(0, holdUntil.getTime() - Date.now());
    const timer = setTimeout(() => {
      void this.flush(id).then((row) => {
        if (row && onFlush) onFlush(row);
      });
    }, delay);
    // Don't keep the process alive solely for a pending flush.
    if (typeof timer === "object" && "unref" in timer) {
      (timer as { unref: () => void }).unref();
    }
    this.timers.set(id, timer);
  }

  /**
   * Rehydrate on boot: flush anything already due, then schedule timers for the
   * rest. Returns the rows flushed immediately.
   */
  async hydrate(onFlush?: (row: PresenceHold) => void): Promise<PresenceHold[]> {
    const flushedNow = await this.flushDue();
    if (onFlush) flushedNow.forEach(onFlush);
    const pending = await this.loadPending();
    for (const row of pending) {
      this.scheduleFlush(row.id, row.holdUntil, onFlush);
    }
    log.info(
      { flushedNow: flushedNow.length, scheduled: pending.length },
      "held-queue: hydrated from presence_holds",
    );
    return flushedNow;
  }

  /** Clear all timers — shutdown / test teardown. */
  shutdown(): void {
    for (const id of [...this.timers.keys()]) this.clearTimer(id);
  }

  private clearTimer(id: string): void {
    const t = this.timers.get(id);
    if (t) {
      clearTimeout(t);
      this.timers.delete(id);
    }
  }
}
