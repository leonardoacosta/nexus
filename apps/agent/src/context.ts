/**
 * AppContext — centralized application state.
 *
 * Replaces scattered module-level singletons with a single typed object
 * that can be passed to route handlers and services. This makes state
 * testable and prevents memory leaks from unbounded Maps/Sets.
 */

import type { Db } from "@nexus/db";
import type { SessionManager } from "./session-manager";
import type { LifecycleBus } from "./services/lifecycle-bus";

// ---------------------------------------------------------------------------
// Notification dedup map with TTL + max-size eviction
// ---------------------------------------------------------------------------

/** Default TTL for dedup entries: 5 minutes. */
export const DEDUP_TTL_MS = 5 * 60 * 1000;
/** Maximum number of dedup entries before bulk eviction. */
export const DEDUP_MAX_SIZE = 1000;
/** Number of oldest entries to evict when capacity is reached. */
const DEDUP_EVICT_BATCH = 100;

/**
 * A Map<string, number> wrapper that enforces TTL eviction and a max-size cap.
 *
 * - On every `set()`, entries older than `ttlMs` are removed.
 * - When the map exceeds `maxSize`, the oldest `DEDUP_EVICT_BATCH` entries
 *   are removed to make room.
 */
export class DedupMap {
  private readonly map = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly maxSize: number;

  constructor(ttlMs: number = DEDUP_TTL_MS, maxSize: number = DEDUP_MAX_SIZE) {
    this.ttlMs = ttlMs;
    this.maxSize = maxSize;
  }

  /** Check whether a key exists and has not expired. */
  has(key: string): boolean {
    const expiry = this.map.get(key);
    if (expiry === undefined) return false;
    if (expiry < Date.now()) {
      this.map.delete(key);
      return false;
    }
    return true;
  }

  /** Insert a key with an expiry timestamp. Triggers eviction. */
  set(key: string, expiryMs: number): void {
    this.evictExpired();
    this.map.set(key, expiryMs);
    if (this.map.size > this.maxSize) {
      this.evictOldest();
    }
  }

  /** Number of entries (including possibly expired ones). */
  get size(): number {
    return this.map.size;
  }

  /** Remove all entries. */
  clear(): void {
    this.map.clear();
  }

  /** Remove entries whose expiry is in the past. */
  private evictExpired(): void {
    const now = Date.now();
    for (const [k, exp] of this.map) {
      if (exp < now) this.map.delete(k);
    }
  }

  /** Remove the oldest entries until size is at 90% of max. */
  private evictOldest(): void {
    const target = Math.floor(this.maxSize * 0.9);
    for (const key of this.map.keys()) {
      if (this.map.size <= target) break;
      this.map.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// Command state types
// ---------------------------------------------------------------------------

/** Notification mode values. */
export type NotificationMode = "full" | "system" | "noduck" | "silent";

/** Per-project notification rules. */
export interface ProjectRules {
  verbosity: string;
  announce_agents: boolean;
  announce_specs: boolean;
  announce_sessions: boolean;
}

/** Bounded map for command-handler state (typeOverrides, projectRules). */
const COMMAND_STATE_MAX_SIZE = 500;

export class BoundedMap<K, V> extends Map<K, V> {
  private readonly maxSize: number;

  constructor(maxSize: number = COMMAND_STATE_MAX_SIZE) {
    super();
    this.maxSize = maxSize;
  }

  override set(key: K, value: V): this {
    // If at capacity and key is new, evict oldest entry
    if (this.size >= this.maxSize && !this.has(key)) {
      const firstKey = this.keys().next().value;
      if (firstKey !== undefined) this.delete(firstKey);
    }
    return super.set(key, value);
  }
}

// ---------------------------------------------------------------------------
// AppContext interface + factory
// ---------------------------------------------------------------------------

export interface CommandState {
  currentMode: NotificationMode;
  typeOverrides: BoundedMap<string, NotificationMode>;
  projectRules: BoundedMap<string, ProjectRules>;
  notificationHistory: Array<{
    timestamp: string;
    message: string;
    messageType?: string;
    channels?: string[];
    project?: string;
  }>;
  maxHistory: number;
}

export interface AppContext {
  db: Db;
  sessionManager: SessionManager;
  lifecycleBus: LifecycleBus;
  commandState: CommandState;
  notificationDedup: DedupMap;
  encryptionKey: Buffer;
  prerotateThreshold: number;
}

export interface CreateAppContextDeps {
  db: Db;
  sessionManager: SessionManager;
  lifecycleBus: LifecycleBus;
  encryptionKey: Buffer;
  prerotateThreshold: number;
}

/**
 * Create an AppContext from pre-initialized dependencies.
 *
 * Does NOT create the services — just wires together what's passed in
 * and initializes the shared mutable state containers.
 */
export function createAppContext(deps: CreateAppContextDeps): AppContext {
  return {
    db: deps.db,
    sessionManager: deps.sessionManager,
    lifecycleBus: deps.lifecycleBus,
    commandState: {
      currentMode: "full",
      typeOverrides: new BoundedMap<string, NotificationMode>(),
      projectRules: new BoundedMap<string, ProjectRules>(),
      notificationHistory: [],
      maxHistory: 100,
    },
    notificationDedup: new DedupMap(),
    encryptionKey: deps.encryptionKey,
    prerotateThreshold: deps.prerotateThreshold,
  };
}
