import { describe, test, expect } from "bun:test";
import { execJson, execText, ExecError, ExecTimeoutError } from "./exec";

describe("execText", () => {
  test("captures stdout from a successful command", async () => {
    const result = await execText("echo", ["hello world"]);
    expect(result.trim()).toBe("hello world");
  });

  test("throws ExecError on non-zero exit code", async () => {
    try {
      await execText("sh", ["-c", "exit 42"]);
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect(err).toBeInstanceOf(ExecError);
      const execErr = err as ExecError;
      expect(execErr.exitCode).toBe(42);
      expect(execErr.cmd).toBe("sh");
    }
  });

  test("throws ExecTimeoutError when command exceeds timeout", async () => {
    try {
      await execText("sleep", ["10"], { timeout: 100 });
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect(err).toBeInstanceOf(ExecTimeoutError);
      const timeoutErr = err as ExecTimeoutError;
      expect(timeoutErr.timeoutMs).toBe(100);
    }
  });

  test("respects cwd option", async () => {
    const result = await execText("pwd", [], { cwd: "/tmp" });
    // /tmp may be a symlink (e.g., /private/tmp on macOS)
    expect(result.trim()).toContain("tmp");
  });
});

describe("execJson", () => {
  test("parses valid JSON output", async () => {
    const result = await execJson<{ ok: boolean }>("echo", ['{"ok":true}']);
    expect(result).toEqual({ ok: true });
  });

  test("throws on non-zero exit code before parsing", async () => {
    try {
      await execJson("sh", ["-c", "echo '{\"ok\":true}'; exit 1"]);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ExecError);
    }
  });

  test("throws on invalid JSON output", async () => {
    try {
      await execJson("echo", ["not json"]);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("Failed to parse JSON");
    }
  });

  test("throws ExecTimeoutError when command exceeds timeout", async () => {
    try {
      await execJson("sleep", ["10"], { timeout: 100 });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ExecTimeoutError);
    }
  });

  test("parses array JSON", async () => {
    const result = await execJson<number[]>("echo", ["[1,2,3]"]);
    expect(result).toEqual([1, 2, 3]);
  });
});
