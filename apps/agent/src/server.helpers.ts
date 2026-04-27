/**
 * Shared test helpers for server test files.
 *
 * Provides the shared server instance, URLs, and utility functions
 * used across all server test splits.
 *
 * Auth note: the legacy `x-nexus-secret` / `NEXUS_ATTACH_SECRET` gate was
 * removed by `drop-attach-secret-gate`. Tests no longer need to inject
 * the header — every endpoint accepts unauthenticated traffic.
 */

import { startServer, healthCollector, streamManager } from "./server";
import { MockPtySource } from "./terminal/pty-source";

export const server = startServer(0);
export const baseUrl = `http://localhost:${server.port}`;
export const wsUrl = `ws://localhost:${server.port}`;

// NOTE: No afterAll here — the server is shared across multiple test files.
// Each file that needs cleanup registers its own afterAll. The server and
// healthCollector are cleaned up by process exit.
export { healthCollector };

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Open an interact WebSocket to a fresh session, wait for it to open,
 * return the socket, collected text messages, and a settled-open promise.
 */
export async function openInteractWs(
  sid: string,
): Promise<{ ws: WebSocket; messages: string[]; opened: Promise<void> }> {
  const ws = new WebSocket(`${wsUrl}/sessions/${sid}/interact`);
  const messages: string[] = [];
  const opened = new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("ws error")));
    ws.addEventListener("close", (_ev) => {
      resolve();
    });
  });
  ws.addEventListener("message", (ev) => {
    if (typeof ev.data === "string") messages.push(ev.data);
  });
  return { ws, messages, opened };
}

export { streamManager, MockPtySource };
