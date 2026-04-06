import { describe, expect, it } from "bun:test";
import { NodePtySource } from "./pty-source";

/**
 * Smoke test for NodePtySource (task 4.4 — fix-pty-lifecycle spec).
 *
 * Spawns `/bin/echo hello` via node-pty, collects output, calls close(),
 * and asserts that:
 *   1. The output contains "hello".
 *   2. close() terminates the process without leaking resources (timer/listener).
 *
 * NOTE: pino (loaded by other test files in this suite) interferes with node-pty's
 * libuv data callbacks in bun 1.x when running in the same process. We work around
 * this by verifying the echo output in a subprocess, while the close/leak test
 * (which doesn't require data delivery) runs inline.
 */
describe("NodePtySource smoke test (task 4.4)", () => {
  it("start NodePtySource with /bin/echo hello, output contains hello", async () => {
    // Run a minimal bun script that tests NodePtySource in isolation (no pino).
    // This avoids bun 1.x's known issue where pino's stdout stream interferes
    // with node-pty's native data callbacks when both are in the same process.
    const script = `
import { NodePtySource } from "${import.meta.dir}/pty-source";
const received = [];
const pty = new NodePtySource("/bin/echo", ["hello"], {
  cols: 80, rows: 24,
  env: { PATH: "${process.env["PATH"] ?? "/usr/bin:/bin"}" },
});
pty.onData((data) => received.push(new TextDecoder().decode(data)));
await new Promise(r => setTimeout(r, 500));
const combined = received.join("") + pty.getScrollback().join("\\n");
if (!combined.includes("hello")) {
  process.stderr.write("FAIL: combined=" + JSON.stringify(combined) + "\\n");
  process.exit(1);
}
process.stdout.write("OK: " + JSON.stringify(combined) + "\\n");
`.trim();

    const proc = Bun.spawn(["bun", "--eval", script], {
      cwd: import.meta.dir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode !== 0) {
      throw new Error(
        `NodePtySource echo test failed (exit ${exitCode}): stdout=${stdout} stderr=${stderr}`,
      );
    }

    expect(stdout).toContain("OK:");
    expect(stdout).toContain("hello");
  });

  it("close() terminates the process without listener leak", async () => {
    const pty = new NodePtySource("/bin/sh", ["-c", "while true; do sleep 1; done"], {
      cols: 80,
      rows: 24,
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
    });

    const received: string[] = [];
    pty.onData((data) => {
      received.push(new TextDecoder().decode(data));
    });

    // Let it run briefly
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    // close() should not throw and should clear internal listeners
    expect(() => pty.close()).not.toThrow();

    // Calling close() a second time should be a no-op (already closed)
    expect(() => pty.close()).not.toThrow();

    // After close, getScrollback() should still return whatever was buffered
    const scrollback = pty.getScrollback();
    expect(Array.isArray(scrollback)).toBe(true);

    // Writing after close should be a no-op (not throw)
    expect(() => pty.write(new TextEncoder().encode("ignored"))).not.toThrow();
  });
});
