/**
 * FailureBuffer — in-memory ring buffer for recent failures.
 *
 * Provides a lightweight, in-process failure tracker. Entries expire
 * after 24 hours and the buffer is capped at 100 entries.
 *
 * This is a simpler alternative to the Rust agent's SQL-backed
 * FailureBuffer. For the Bun agent, we keep it in-memory since
 * the PostgreSQL schema doesn't have a failures table.
 */

import { createLogger } from "@nexus/core/node";

const log = createLogger("agent:services:failure-buffer");

/** Maximum entries in the ring buffer. */
const MAX_ENTRIES = 100;

/** Entries older than this are evicted (ms). */
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FailureEntry {
  timestamp: Date;
  source: string;
  message: string;
  stack?: string;
  context?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Buffer
// ---------------------------------------------------------------------------

export class FailureBuffer {
  private entries: FailureEntry[] = [];

  /** Add a failure entry, evicting old entries if necessary. */
  add(failure: FailureEntry): void {
    // Evict expired entries first.
    this.evictExpired();

    // If at capacity, remove the oldest entry.
    if (this.entries.length >= MAX_ENTRIES) {
      this.entries.shift();
    }

    this.entries.push(failure);

    log.debug(
      { source: failure.source, count: this.entries.length },
      "failure recorded",
    );
  }

  /** List all non-expired entries (newest first). */
  list(): FailureEntry[] {
    this.evictExpired();
    // Return a copy, newest first.
    return [...this.entries].reverse();
  }

  /** Get the count of entries in the buffer. */
  count(): number {
    this.evictExpired();
    return this.entries.length;
  }

  /** Clear all entries. */
  clear(): void {
    this.entries = [];
  }

  /** Evict entries older than TTL. */
  private evictExpired(): void {
    const cutoff = Date.now() - TTL_MS;
    this.entries = this.entries.filter(
      (e) => e.timestamp.getTime() > cutoff,
    );
  }
}

// Module-level singleton.
let _instance: FailureBuffer | null = null;

/** Get the singleton failure buffer. */
export function getFailureBuffer(): FailureBuffer {
  if (!_instance) {
    _instance = new FailureBuffer();
  }
  return _instance;
}

/** Reset the singleton (for testing). */
export function resetFailureBuffer(): void {
  _instance = null;
}
