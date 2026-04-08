import { logger } from "@nexus/core";
import type { WatcherEvent, WatcherCommand } from "@nexus/core";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { safeFireAndForget } from "./utils/safe-fire-and-forget";

/** Resolve the watcher binary path — prefer release, fall back to debug.
 *
 * When running as a compiled Bun binary, `import.meta.dir` resolves to `/`
 * (not the source directory). So we first look beside the agent binary using
 * `process.execPath`, then fall back to the source-relative path for dev runs.
 */
function resolveWatcherBinary(): string {
  // Production: look for nexus-watcher beside the agent binary
  const binDir = dirname(process.execPath);
  const beside = join(binDir, "nexus-watcher");
  if (existsSync(beside)) return beside;

  // Development fallback: relative to source tree
  const base = join(import.meta.dir, "../../../packages/watcher/target");
  const release = join(base, "release/nexus-watcher");
  if (existsSync(release)) return release;
  const debug = join(base, "debug/nexus-watcher");
  if (existsSync(debug)) return debug;

  throw new Error(
    `Watcher binary not found at ${beside}, ${release}, or ${debug}. Build with: cd packages/watcher && cargo build --release`,
  );
}

export interface WatcherBridge {
  /** Send a command to the watcher process. */
  send(command: WatcherCommand): void;
  /** Shut down the bridge and the watcher process. */
  shutdown(): void;
}

export interface WatcherBridgeOptions {
  onEvent: (event: WatcherEvent) => void;
  /** Override binary path (used in tests). */
  binaryPath?: string;
}

/**
 * Spawn the Rust watcher binary and bridge its IPC events into typed callbacks.
 *
 * Handles crash detection with exponential backoff restart:
 * 1s -> 2s -> 4s -> ... -> max 30s. Backoff resets after 60s of stable uptime.
 */
export function createWatcherBridge(
  options: WatcherBridgeOptions,
): WatcherBridge {
  const binaryPath = options.binaryPath ?? resolveWatcherBinary();
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let stopped = false;
  let backoffMs = 1000;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let uptimeTimer: ReturnType<typeof setTimeout> | null = null;
  let lineBuffer = "";

  function processLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const event = JSON.parse(trimmed) as WatcherEvent;
      if (!event.type) return;
      options.onEvent(event);
    } catch {
      logger.warn({ line: trimmed }, "watcher-bridge: failed to parse line");
    }
  }

  function spawn(): void {
    if (stopped) return;

    logger.info({ binaryPath }, "watcher-bridge: spawning watcher");
    lineBuffer = "";

    proc = Bun.spawn([binaryPath], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });

    // Reset backoff after 60s of stable uptime
    uptimeTimer = setTimeout(() => {
      backoffMs = 1000;
    }, 60_000);

    // Read stdout as a stream, parse newline-delimited JSON
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();

    safeFireAndForget((async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          lineBuffer += decoder.decode(value, { stream: true });
          const lines = lineBuffer.split("\n");
          // Keep the last incomplete chunk in the buffer
          lineBuffer = lines.pop()!;
          for (const line of lines) {
            processLine(line);
          }
        }
        // Process any remaining data in buffer
        if (lineBuffer.trim()) {
          processLine(lineBuffer);
          lineBuffer = "";
        }
      } catch (err) {
        logger.error({ error: err }, "watcher-bridge: stdout stream closed unexpectedly");
      }
    })(), "watcher-bridge-stdout-reader");

    // Watch for process exit
    safeFireAndForget(proc.exited.then((code) => {
      if (uptimeTimer) clearTimeout(uptimeTimer);
      uptimeTimer = null;
      proc = null;

      if (stopped) return;

      logger.warn({ code, backoffMs }, "watcher-bridge: watcher exited");
      restartTimer = setTimeout(() => {
        backoffMs = Math.min(backoffMs * 2, 30_000);
        spawn();
      }, backoffMs);
    }), "watcher-bridge-process-exit");
  }

  function send(command: WatcherCommand): void {
    if (!proc || !proc.stdin) {
      logger.warn("watcher-bridge: cannot send command, no active process");
      return;
    }
    const stdin = proc.stdin as import("bun").FileSink;
    stdin.write(new TextEncoder().encode(JSON.stringify(command) + "\n"));
    try {
      const result = stdin.flush();
      // flush() returns number | Promise<number> — catch async rejections too
      if (result && typeof (result as Promise<number>).catch === "function") {
        (result as Promise<number>).catch((err: unknown) => {
          logger.warn({ error: err }, "watcher-bridge: stdin flush failed (async)");
        });
      }
    } catch (err) {
      logger.warn({ error: err }, "watcher-bridge: stdin flush failed");
    }
  }

  function shutdown(): void {
    stopped = true;
    if (restartTimer) clearTimeout(restartTimer);
    if (uptimeTimer) clearTimeout(uptimeTimer);
    restartTimer = null;
    uptimeTimer = null;

    if (proc) {
      // Try graceful shutdown first
      send({ type: "shutdown" });
      // Force kill after 2s if still alive
      const killTimer = setTimeout(() => {
        proc?.kill();
      }, 2000);
      safeFireAndForget(proc.exited.then(() => clearTimeout(killTimer)), "watcher-bridge-shutdown-exit");
    }
  }

  // Start immediately
  spawn();

  return { send, shutdown };
}
