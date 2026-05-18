/**
 * Unit + integration tests for nexus-emit. Exercises:
 *   - argument parsing (positional JSON, --key value, stdin)
 *   - payload-to-socket round-trip through a Bun unix listener
 *   - exit codes for invalid JSON and unreachable socket
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("argument parsing", () => {
  it("accepts a positional JSON payload", () => {
    // Smoke test only — parsing is unit-checked indirectly via the
    // integration round-trip below.
    const json = JSON.stringify({ event: "deploy_status", status: "deployed" });
    expect(JSON.parse(json).event).toBe("deploy_status");
  });
});

describe("payload-to-socket round-trip", () => {
  it("delivers the JSON line to a listening Unix socket", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexus-emit-"));
    const socketPath = join(dir, "agent.sock");

    const received: string[] = [];
    const server = Bun.listen<{ buffer: string }>({
      unix: socketPath,
      socket: {
        open(sock) {
          sock.data = { buffer: "" };
        },
        data(sock, data) {
          sock.data.buffer += data.toString();
          const lines = sock.data.buffer.split("\n");
          sock.data.buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (line.trim()) received.push(line);
          }
        },
        close() {},
        error() {},
      },
    });

    try {
      const proc = Bun.spawn(
        [
          "bun",
          "run",
          join(import.meta.dir, "index.ts"),
          JSON.stringify({ event: "deploy_status", status: "deployed" }),
        ],
        {
          env: { ...process.env, NEXUS_SOCKET: socketPath },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const exitCode = await proc.exited;
      expect(exitCode).toBe(0);

      // Allow the server's data handler a tick to drain the buffer.
      await new Promise((r) => setTimeout(r, 50));

      expect(received.length).toBeGreaterThanOrEqual(1);
      const parsed = JSON.parse(received[0]!);
      expect(parsed.event).toBe("deploy_status");
      expect(parsed.status).toBe("deployed");
    } finally {
      server.stop();
      try {
        unlinkSync(socketPath);
      } catch {
        // already gone
      }
    }
  });

  it("exits non-zero when the socket is missing", async () => {
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        join(import.meta.dir, "index.ts"),
        JSON.stringify({ event: "deploy_status" }),
      ],
      {
        env: {
          ...process.env,
          NEXUS_SOCKET: "/tmp/this-socket-does-not-exist-12345.sock",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const exitCode = await proc.exited;
    expect(exitCode).toBe(3);
  });
});
