/**
 * nexus-agent HTTP + WebSocket server entry point.
 *
 * This file has been slimmed down to just the `startServer()` function plus
 * backward-compat re-exports. The bulk of the logic lives in sibling modules:
 *
 * - server-websocket.ts          — ServerState, WS upgrade, WS handlers
 * - server-origin.ts             — isTailscaleOrigin, isDisallowedBrowserOrigin, withCors
 * - server-auth.ts               — CREDENTIAL_ID_RE
 * - server-state.ts              — _singletonState + healthCollector/streamManager exports
 * - server-health-handler.ts     — /health + /health/ingest handlers
 * - server-request-handler.ts    — createRequestHandler (main HTTP dispatcher)
 * - server-routes-credentials.ts — /credentials/* sub-dispatcher
 * - server-routes-specs.ts       — /specs/*, /commands/* sub-dispatchers
 *
 * Bind logic (drop-attach-secret-gate):
 *   - Default (no `bind_address` in agents.toml, or `bind_address = "0.0.0.0"`):
 *     bind to BOTH `127.0.0.1` and the Tailscale interface IP discovered via
 *     `tailscale ip -4` at boot. Tailscale unavailable → loopback-only with a
 *     warning. Two `Bun.serve` instances share the same handlers/state.
 *   - Explicit `bind_address` other than `"0.0.0.0"`: single bind, verbatim,
 *     no Tailscale shell-out.
 */

import type { Db } from "@nexus/db";
import type { ServerWebSocket, Server as BunServer } from "bun";
import { logger, parseConfig, getAgentsConfigPath } from "@nexus/core/node";
import { initNotificationRoutes } from "./routes/notifications";
import { initCredentialRoutes, getCredentialPool } from "./routes/credentials";
import {
  startCredentialWatcher,
  startActiveCredentialWatcher,
} from "./credentials/credential-watcher";
import { initCommandRoutes } from "./routes/commands";
import { initConfigLoader } from "./services/config-loader";
import {
  startProcessWatcher,
  type ProcessWatcherHandle,
} from "./services/process-watcher";
import type { WsData } from "./terminal/stream-manager";
import { safeFireAndForget } from "./utils/safe-fire-and-forget";
import type { AppContext } from "./context";
import { createWsHandlers } from "./server-websocket";
import { _singletonState } from "./server-state";
import { createRequestHandler } from "./server-request-handler";

// ── Backward-compat re-exports ──────────────────────────────────────────────
// Test files and downstream code import these directly from ./server.
export { ServerState } from "./server-websocket";
export { healthCollector, streamManager } from "./server-state";

const PORT = 7400;

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Resolve the Tailscale interface IPv4 at boot. Synchronous on purpose so
 * `startServer` can stay synchronous and `Bun.serve` can be invoked with the
 * resolved address. Returns `null` (and logs a warning) on any failure — the
 * server falls back to loopback-only which is a valid degraded mode.
 */
function discoverTailscaleIp(): string | null {
  try {
    const proc = Bun.spawnSync(["tailscale", "ip", "-4"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) {
      logger.warn(
        { exitCode: proc.exitCode },
        "tailscale ip -4 exited non-zero; binding loopback only",
      );
      return null;
    }
    const out = proc.stdout.toString().trim().split("\n")[0]?.trim() ?? "";
    if (!out || !IPV4_RE.test(out)) {
      logger.warn({ raw: out }, "tailscale ip -4 returned non-IPv4; binding loopback only");
      return null;
    }
    return out;
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "tailscale lookup threw; binding loopback only",
    );
    return null;
  }
}

/**
 * Read `bind_address` from `agents.toml`. Returns `undefined` when the config
 * is unreadable or unset — caller treats undefined and `"0.0.0.0"` identically
 * (default multi-bind).
 */
function readBindAddress(): string | undefined {
  const result = parseConfig(getAgentsConfigPath());
  if (!result.ok) return undefined;
  return result.config.bind_address;
}

/**
 * Wrapper returned by `startServer`. Behaves like a `Bun.Server` for the two
 * fields callers actually use (`port`, `stop`). When the agent multi-binds it
 * fans out `.stop()` across both underlying servers; `port` reports the first
 * (loopback) instance — which is what the index.ts startup log advertises.
 */
export interface NexusServer {
  readonly port: number;
  stop(closeActiveConnections?: boolean): void;
}

function combineServers(servers: BunServer<WsData>[]): NexusServer {
  const first = servers[0];
  if (!first) throw new Error("no servers bound — refusing to start");
  // Bun's `Server.port` is typed `number | undefined`; in practice it's always
  // resolved by the time `Bun.serve()` returns. Coalesce defensively.
  const resolvedPort = first.port ?? 0;
  return {
    get port() {
      return resolvedPort;
    },
    stop(closeActiveConnections?: boolean) {
      for (const s of servers) {
        try {
          s.stop(closeActiveConnections);
        } catch (err) {
          logger.warn(
            { error: err instanceof Error ? err.message : String(err) },
            "Bun.Server.stop() threw — continuing shutdown",
          );
        }
      }
    },
  };
}

interface ServeFactory {
  (hostname: string): BunServer<WsData>;
}

/**
 * Architectural note (drop-attach-secret-gate): we run two `Bun.serve`
 * instances rather than one bound to `0.0.0.0`. Bun does not expose a
 * native multi-hostname API; spinning up a second server with the same
 * port + handlers is the only portable way to bind to both loopback and
 * the Tailscale interface while refusing every other interface.
 */
function bindServers(
  bindAddress: string | undefined,
  serve: ServeFactory,
): BunServer<WsData>[] {
  // Explicit override (anything other than "0.0.0.0") → single bind, verbatim.
  if (bindAddress && bindAddress !== "0.0.0.0") {
    logger.info({ bindAddress }, "binding agent: explicit bind_address override");
    return [serve(bindAddress)];
  }

  // Default: loopback + Tailscale (when discoverable).
  const servers: BunServer<WsData>[] = [serve("127.0.0.1")];
  const tsIp = discoverTailscaleIp();
  if (tsIp) {
    servers.push(serve(tsIp));
    logger.info({ loopback: "127.0.0.1", tailscale: tsIp }, "binding agent: loopback + tailscale");
  } else {
    logger.warn(
      "Tailscale interface unavailable — binding loopback only (degraded mode)",
    );
  }
  return servers;
}

export function startServer(
  port: number = PORT,
  db?: Db,
  options?: { encryptionKey?: import("node:buffer").Buffer; prerotateThreshold?: number },
  _ctx?: AppContext,
): NexusServer {
  // Use the module singleton state so that module-level `healthCollector` and
  // `streamManager` exports remain valid references to the running server's state.
  const state = _singletonState;

  // Track DB-backed background subsystems so graceful shutdown can stop them.
  let processWatcher: ProcessWatcherHandle | null = null;

  // Initialize subsystems that need the DB.
  // initNotificationRoutes is async (mutex-guarded) — fire-and-forget here
  // since server startup itself is synchronous and the manager will be ready
  // well before the first real request arrives.
  if (db) {
    safeFireAndForget(initNotificationRoutes(db), "init-notification-routes");
    initCredentialRoutes(db, {
      encryptionKey: options?.encryptionKey,
      prerotateThreshold: options?.prerotateThreshold,
    });

    // Refresh credential metadata from disk (expiresAt, mcpProviders, etc.)
    // Fire-and-forget — stale metadata doesn't block server startup.
    const pool = getCredentialPool();
    if (pool) {
      safeFireAndForget(pool.refreshMetadata(), "credential-metadata-refresh");
      // Watch credential directory for new/changed files
      startCredentialWatcher(pool);
      // Watch ~/.claude/.credentials.json symlink for active-account tracking
      startActiveCredentialWatcher(pool);
    }

    // Process watcher: 30s reconcile loop that keeps the `sessions` table
    // in sync with live `claude` processes on this machine. First pass
    // fires immediately, subsequent ticks scheduled internally. Stopped
    // by `wrapper.stop()` below.
    processWatcher = startProcessWatcher(db);
  }

  // Initialize subsystems that do not need the DB.
  initConfigLoader();
  initCommandRoutes();

  const handler = createRequestHandler(state, db);
  const wsHandlers = createWsHandlers(state);

  const serve: ServeFactory = (hostname) =>
    Bun.serve<WsData>({
      port,
      hostname,
      // SSE streams (e.g. /events/stream, /specs/events) hold connections open
      // for minutes-to-hours with sparse keepalive frames. Bun's default
      // idleTimeout is 10s, which silently closes those streams ~10s after the
      // last byte. 255s (the maximum) is well past the longest keepalive
      // interval (30s) used by any handler. See nx-4p8n.
      idleTimeout: 255,
      fetch(req: Request, server: import("bun").Server<WsData>) {
        return handler(req, server);
      },
      websocket: wsHandlers,
    });

  const bindAddress = readBindAddress();
  const servers = bindServers(bindAddress, serve);
  const baseWrapper = combineServers(servers);

  // Wrap the base wrapper so graceful shutdown also tears down the
  // process-watcher interval. Without this the loop keeps running after
  // the server stops, holding the event loop open during integration
  // tests and dev restarts.
  const wrapper: NexusServer = processWatcher
    ? {
        get port() {
          return baseWrapper.port;
        },
        stop(closeActiveConnections?: boolean) {
          try {
            processWatcher?.stop();
          } catch (err) {
            logger.warn(
              { error: err instanceof Error ? err.message : String(err) },
              "process-watcher stop threw — continuing shutdown",
            );
          }
          baseWrapper.stop(closeActiveConnections);
        },
      }
    : baseWrapper;

  logger.info(
    {
      port: wrapper.port,
      bindings: servers.map((s) => s.hostname ?? "(unknown)").join(","),
    },
    "nexus-agent started",
  );
  return wrapper;
}

// Type re-export so test/code consumers that previously typed against
// `Bun.Server` continue to compile if they only used `port` / `stop()`.
export type { ServerWebSocket };

// ── Test-only exports ───────────────────────────────────────────────────────
// `bindServers` and `discoverTailscaleIp` are exported solely for unit tests
// (see server-bind.test.ts). Production callers should not use these directly.
export const __testing = {
  bindServers,
  discoverTailscaleIp,
};

