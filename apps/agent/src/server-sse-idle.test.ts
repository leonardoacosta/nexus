/**
 * Regression test for nx-4p8n.
 *
 * Bun.serve()'s default `idleTimeout` is 10 seconds — connections without
 * I/O for that window are silently closed. Our SSE handlers use 20–30s
 * keepalive intervals, so without an explicit `idleTimeout` override they
 * are killed by Bun roughly 10s after the initial frames.
 *
 * This test opens /events/stream, reads the initial `connected` frame,
 * waits 12s (just past the old default), and asserts the body is still
 * readable. If `idleTimeout` regresses to the default (or a value below
 * the slowest keepalive), the read will throw / return done=true.
 */

import { describe, expect, it } from "bun:test";
import { ATTACH_SECRET, baseUrl } from "./server.helpers";

describe("SSE idle timeout (nx-4p8n)", () => {
  it(
    "/events/stream stays open past Bun's default 10s idleTimeout",
    async () => {
      const res = await fetch(`${baseUrl}/events/stream`, {
        headers: {
          "x-nexus-secret": ATTACH_SECRET,
          Accept: "text/event-stream",
        },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/event-stream");

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();

      // Read the initial `: keepalive` + `data: {connected}` frames.
      const first = await reader.read();
      expect(first.done).toBe(false);
      const firstText = decoder.decode(first.value);
      expect(firstText).toContain("connected");

      // Wait 12s — past Bun's default 10s idleTimeout. If the override is
      // missing, the connection closes and the next read returns done=true
      // (or throws). With idleTimeout: 255 the stream stays open.
      await new Promise((resolve) => setTimeout(resolve, 12_000));

      // Race a follow-up read against a 1s probe so we can detect either
      // a stalled-but-alive socket (timeout wins) OR a closed socket
      // (read resolves with done=true).
      const probe = await Promise.race([
        reader.read(),
        new Promise<{ done: true; alive: true }>((resolve) =>
          setTimeout(() => resolve({ done: true, alive: true }), 1_000),
        ),
      ]);

      // If the connection was idle-killed, `probe.done` is true AND
      // `alive` is undefined. If alive, either the read raced past the
      // probe (alive flag absent but we got a frame) or the probe
      // timeout fired (alive flag present).
      const wasKilled =
        probe.done === true && (probe as { alive?: boolean }).alive !== true;
      expect(wasKilled).toBe(false);

      await reader.cancel().catch(() => {});
    },
    20_000,
  );
});
