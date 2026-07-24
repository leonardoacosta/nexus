/**
 * Unit tests for `startSocketServer`'s post-bind file-mode hardening
 * (chmod-agent-socket, task 1.1) — the bound socket file must report mode
 * 0600 regardless of which path it binds: an explicit `options.socketPath`
 * (the shape callers use for the default path) and a path resolved from the
 * `NEXUS_SOCKET` env var via `resolveSocketPath()` (no explicit
 * `options.socketPath` passed, so `startSocketServer` falls through to
 * `options.socketPath ?? resolveSocketPath()`).
 *
 * Uses real filesystem sockets under a per-test temp path (no mocking —
 * `Bun.listen`'s unix-socket bind and `chmodSync` are both real I/O, and
 * nothing else in this suite needs stubbing), following the plain-fixture
 * convention of `pane-translation.test.ts` in this same directory. Never
 * binds the real `/tmp/nexus-agent.sock` default path directly — a dev
 * machine may have a live agent already listening there.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { statSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSocketServer } from "./server";
import type { SocketServer } from "./types";

function socketMode(path: string): number {
  return statSync(path).mode & 0o777;
}

describe("startSocketServer: socket file mode hardening", () => {
  let server: SocketServer | undefined;
  const originalNexusSocket = process.env.NEXUS_SOCKET;

  afterEach(() => {
    server?.stop();
    server = undefined;
    if (originalNexusSocket === undefined) {
      delete process.env.NEXUS_SOCKET;
    } else {
      process.env.NEXUS_SOCKET = originalNexusSocket;
    }
  });

  test("an explicit options.socketPath (the default-path shape) is bound with mode 0600", async () => {
    const socketPath = join(tmpdir(), `nexus-agent-test-default-${process.pid}.sock`);
    if (existsSync(socketPath)) unlinkSync(socketPath);

    server = await startSocketServer({
      socketPath,
      onEvent: () => {},
      onCommand: () => ({}),
    });

    expect(server.path).toBe(socketPath);
    expect(socketMode(socketPath)).toBe(0o600);
  });

  test("a NEXUS_SOCKET-resolved path (no explicit options.socketPath) is bound with mode 0600", async () => {
    const socketPath = join(tmpdir(), `nexus-agent-test-override-${process.pid}.sock`);
    if (existsSync(socketPath)) unlinkSync(socketPath);
    process.env.NEXUS_SOCKET = socketPath;

    server = await startSocketServer({
      onEvent: () => {},
      onCommand: () => ({}),
    });

    expect(server.path).toBe(socketPath);
    expect(socketMode(socketPath)).toBe(0o600);
  });
});
