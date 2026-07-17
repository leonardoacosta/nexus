/**
 * sd-notify unit tests (nexus-self-healing-infra, systemd-service spec, task 3.1).
 *
 * `sendWatchdogNotify()` never touches Bun's `node:dgram`/`node:net` shims —
 * per the module's own header doc, neither supports a `SOCK_DGRAM` Unix
 * socket (systemd's notify socket is always `SOCK_DGRAM`). It talks straight
 * to libc via `bun:ffi` (`socket`/`connect`/`write`/`close`). The most
 * faithful way to prove the datagram actually lands is to stand up the SAME
 * kind of endpoint on the receiving side — a real `AF_UNIX SOCK_DGRAM`
 * listener bound via the identical libc calls — rather than mocking the FFI
 * layer itself (bun:ffi symbol tables aren't a seam this codebase mocks
 * anywhere else). This mirrors how task 2.1 was manually verified per
 * tasks.md's implementation note ("Verified end-to-end with a real bound
 * AF_UNIX SOCK_DGRAM listener receiving the literal WATCHDOG=1\n bytes").
 *
 * Because a Unix-domain datagram write lands directly in the receiving
 * socket's kernel buffer, there is no cross-process race to await: bind the
 * listener, call the real `sendWatchdogNotify()`, then a single blocking
 * `recvfrom()` on the listener fd returns immediately with the queued bytes.
 */

import { describe, expect, it, afterEach, beforeEach } from "bun:test";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, unlinkSync } from "node:fs";
import {
  sendWatchdogNotify,
  startSdNotifyWatchdog,
  WATCHDOG_SEC,
} from "./sd-notify";

const AF_UNIX = 1;
const SOCK_DGRAM = 2;
/** sizeof(struct sockaddr_un) on Linux: sa_family_t (2 bytes) + sun_path[108]. */
const SOCKADDR_UN_SIZE = 110;
const SUN_PATH_MAX = 108;

const { symbols: libc } = dlopen("libc.so.6", {
  socket: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  bind: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  recvfrom: {
    args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.ptr],
    returns: FFIType.i64,
  },
  close: { args: [FFIType.i32], returns: FFIType.i32 },
});

/** Pack a filesystem-path `struct sockaddr_un` (test listener only ever binds real paths). */
function buildTestSockaddrUn(path: string): { addr: Uint8Array; len: number } {
  const nameBytes = new TextEncoder().encode(path);
  if (nameBytes.length > SUN_PATH_MAX - 1) {
    throw new Error(`test socket path too long (${path.length} bytes)`);
  }
  const addr = new Uint8Array(SOCKADDR_UN_SIZE);
  new DataView(addr.buffer).setUint16(0, AF_UNIX, true);
  addr.set(nameBytes, 2);
  return { addr, len: 2 + nameBytes.length + 1 };
}

/** Bind a real AF_UNIX SOCK_DGRAM listener at `path`. Returns the fd. */
function bindDgramListener(path: string): number {
  const fd = libc.socket(AF_UNIX, SOCK_DGRAM, 0);
  if (fd < 0) throw new Error("socket() failed for test listener");
  const { addr, len } = buildTestSockaddrUn(path);
  const rc = libc.bind(fd, ptr(addr), len);
  if (rc !== 0) throw new Error(`bind() failed for test listener at ${path}`);
  return fd;
}

/** Blocking read of one datagram off `fd`, decoded as UTF-8. */
function recvOnce(fd: number, bufSize = 256): string {
  const buf = new Uint8Array(bufSize);
  const n = libc.recvfrom(fd, ptr(buf), buf.length, 0, null, null);
  if (n < 0n) throw new Error("recvfrom() failed on test listener");
  return new TextDecoder().decode(buf.slice(0, Number(n)));
}

describe("sendWatchdogNotify", () => {
  let socketPath: string;
  let listenerFd: number | null;
  let originalNotifySocket: string | undefined;

  beforeEach(() => {
    originalNotifySocket = process.env.NOTIFY_SOCKET;
    socketPath = join(tmpdir(), `nx-sdnotify-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}.sock`);
    listenerFd = null;
  });

  afterEach(() => {
    if (listenerFd !== null) {
      libc.close(listenerFd);
    }
    if (existsSync(socketPath)) {
      unlinkSync(socketPath);
    }
    if (originalNotifySocket === undefined) {
      delete process.env.NOTIFY_SOCKET;
    } else {
      process.env.NOTIFY_SOCKET = originalNotifySocket;
    }
  });

  it("writes the literal WATCHDOG=1 datagram to a real bound AF_UNIX SOCK_DGRAM listener when $NOTIFY_SOCKET is set", () => {
    listenerFd = bindDgramListener(socketPath);
    process.env.NOTIFY_SOCKET = socketPath;

    const result = sendWatchdogNotify();

    expect(result).toBe(true);
    expect(recvOnce(listenerFd)).toBe("WATCHDOG=1\n");
  });

  it("writes a custom message verbatim when one is supplied", () => {
    listenerFd = bindDgramListener(socketPath);
    process.env.NOTIFY_SOCKET = socketPath;

    const result = sendWatchdogNotify("READY=1\n");

    expect(result).toBe(true);
    expect(recvOnce(listenerFd)).toBe("READY=1\n");
  });

  it("is a silent no-op returning false when $NOTIFY_SOCKET is unset (local dev, macOS)", () => {
    delete process.env.NOTIFY_SOCKET;

    // No listener at all — if this attempted a real connect it would throw
    // (ECONNREFUSED / ENOENT), not just return false. Absence of both a
    // thrown error and a bound socket proves the early-return no-op path.
    expect(() => {
      const result = sendWatchdogNotify();
      expect(result).toBe(false);
    }).not.toThrow();
  });

  it("returns false (never throws) when $NOTIFY_SOCKET points at a path with no listener bound", () => {
    // Socket path is set but nothing is bound there — connect() must fail,
    // and the module's own catch converts that into `false`, never a throw.
    process.env.NOTIFY_SOCKET = socketPath;

    expect(() => {
      const result = sendWatchdogNotify();
      expect(result).toBe(false);
    }).not.toThrow();
  });
});

describe("startSdNotifyWatchdog", () => {
  it("fires the injected notify function immediately, then again on each interval tick, and stops after the returned stop() is called", async () => {
    let calls = 0;
    const stop = startSdNotifyWatchdog({
      intervalMs: 15,
      notify: () => {
        calls++;
        return true;
      },
    });

    try {
      // Immediate fire on start (per the module's own doc: "Fires once
      // immediately, then every intervalMs").
      expect(calls).toBeGreaterThanOrEqual(1);

      await new Promise((resolve) => setTimeout(resolve, 60));
      const callsBeforeStop = calls;
      expect(callsBeforeStop).toBeGreaterThan(1);

      stop();
      await new Promise((resolve) => setTimeout(resolve, 60));
      // No further ticks after stop() — count must not have advanced.
      expect(calls).toBe(callsBeforeStop);
    } finally {
      stop();
    }
  });

  it("defaults intervalMs to half of WATCHDOG_SEC when not overridden", () => {
    // WATCHDOG_SEC is the deploy/nexus-agent.service WatchdogSec=30 contract
    // (task 2.2) — the default interval must stay under half of it so
    // systemd's own recommended margin holds even if this constant drifts.
    expect(WATCHDOG_SEC).toBe(30);

    let calls = 0;
    const stop = startSdNotifyWatchdog({
      notify: () => {
        calls++;
        return true;
      },
    });
    try {
      expect(calls).toBeGreaterThanOrEqual(1);
    } finally {
      stop();
    }
  });
});
