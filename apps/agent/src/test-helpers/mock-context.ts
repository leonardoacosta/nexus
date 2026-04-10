/**
 * Mock AppContext factory for tests.
 *
 * Creates an AppContext with in-memory stubs — no database, no real services.
 * The lifecycle bus is real (lightweight EventEmitter), everything else is
 * minimal stubs sufficient for route/service unit tests.
 */

import { LifecycleBus } from "../services/lifecycle-bus";
import { createSessionManager } from "../session-manager";
import { DedupMap, BoundedMap, type AppContext, type CommandState, type NotificationMode, type ProjectRules } from "../context";

/**
 * Create a minimal mock Db object that returns empty results.
 * Only stubs the methods actually used by route handlers.
 */
function createMockDb(): AppContext["db"] {
  const handler: ProxyHandler<object> = {
    get(_target, prop) {
      if (prop === "select") {
        return () => ({
          from: () => ({
            where: () => ({
              limit: () => Promise.resolve([]),
              orderBy: () => Promise.resolve([]),
            }),
            limit: () => Promise.resolve([]),
            orderBy: () => Promise.resolve([]),
          }),
        });
      }
      if (prop === "insert") {
        return () => ({
          values: () => ({
            onConflictDoUpdate: () => Promise.resolve(),
            returning: () => Promise.resolve([]),
          }),
        });
      }
      if (prop === "delete") {
        return () => ({
          where: () => Promise.resolve(),
        });
      }
      if (prop === "update") {
        return () => ({
          set: () => ({
            where: () => Promise.resolve(),
          }),
        });
      }
      // Return a no-op for anything else
      return () => new Proxy({}, handler);
    },
  };

  return new Proxy({}, handler) as AppContext["db"];
}

export interface MockContextOptions {
  /** Override encryption key (defaults to 32 zero bytes). */
  encryptionKey?: Buffer;
  /** Override prerotate threshold. */
  prerotateThreshold?: number;
  /** Override max notification history. */
  maxHistory?: number;
}

/**
 * Create a mock AppContext suitable for unit tests.
 *
 * Returns a real AppContext with:
 * - Mock db (proxy that returns empty results)
 * - Real session manager (lightweight, in-memory)
 * - Real lifecycle bus (lightweight EventEmitter)
 * - Empty command state maps
 * - Fresh dedup map
 */
export function createMockContext(options: MockContextOptions = {}): AppContext {
  const sessionManager = createSessionManager();

  const commandState: CommandState = {
    currentMode: "full",
    typeOverrides: new BoundedMap<string, NotificationMode>(),
    projectRules: new BoundedMap<string, ProjectRules>(),
    notificationHistory: [],
    maxHistory: options.maxHistory ?? 100,
  };

  return {
    db: createMockDb(),
    sessionManager,
    lifecycleBus: new LifecycleBus(),
    commandState,
    notificationDedup: new DedupMap(),
    encryptionKey: options.encryptionKey ?? Buffer.alloc(32, 0),
    prerotateThreshold: options.prerotateThreshold ?? 80,
  };
}

/**
 * Tear down a mock context — stops the session manager sweep timer.
 */
export function teardownMockContext(ctx: AppContext): void {
  ctx.sessionManager.stop();
  ctx.lifecycleBus.removeAllListeners();
  ctx.notificationDedup.clear();
}
