import { logger } from "@nexus/core";
import { startServer } from "./server";
import { createWatcherBridge } from "./watcher-bridge";
import { createSessionManager } from "./session-manager";

const server = startServer();
const sessionManager = createSessionManager();

let watcherBridge: ReturnType<typeof createWatcherBridge> | null = null;

try {
  watcherBridge = createWatcherBridge({
    onEvent: (event) => sessionManager.handleWatcherEvent(event),
  });
  logger.info("watcher bridge started");
} catch (err) {
  // Watcher binary not found — agent still runs, just without session detection
  logger.warn("watcher bridge unavailable, session detection disabled", {
    error: err instanceof Error ? err.message : String(err),
  });
}

function shutdown() {
  logger.info("shutting down nexus-agent");
  sessionManager.stop();
  watcherBridge?.shutdown();
  server.stop();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
