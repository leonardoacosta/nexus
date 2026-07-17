/**
 * systemd watchdog keep-alive (nexus-self-healing-infra, systemd-service spec).
 *
 * `Restart=always` on `nexus-agent.service` only covers a process that
 * actually exits. A process that is ALIVE but hung (blocked event loop,
 * deadlocked connection pool) never crashes, so crash-restart never
 * triggers — the gap this closes. `deploy/nexus-agent.service` declares
 * `WatchdogSec=30`; systemd force-kills (SIGABRT) and restarts the unit if
 * `WATCHDOG=1` keep-alive datagrams stop arriving within that window.
 *
 * Protocol: a single UDP-style datagram containing the literal bytes
 * `WATCHDOG=1\n` written to the Unix domain socket named by `$NOTIFY_SOCKET`
 * (systemd sets this env var on the service's exec environment whenever
 * `WatchdogSec=`/`Type=notify` is configured — see `sd_notify(3)`).
 *
 * Why raw FFI instead of `node:dgram`/`node:net`: Bun's `node:dgram` shim
 * only supports `udp4`/`udp6` (verified — `unix_dgram` throws "Bad socket
 * type specified"), and `node:net`/`Bun.connect({ unix })` only speak
 * `SOCK_STREAM`, which the kernel refuses to connect to a `SOCK_DGRAM`
 * listener (systemd's notify socket is always `SOCK_DGRAM`). `bun:ffi`
 * ships with Bun itself — this is not a new package.json dependency, just a
 * direct `socket()`/`connect()`/`write()`/`close()` call against libc,
 * mirroring the raw-syscall necessity (not a new *library*, per the task's
 * instruction to avoid one).
 *
 * Fails silently everywhere: no `$NOTIFY_SOCKET` (local `bun run dev`,
 * macOS — no agent daemon there), no libc.so.6 (non-glibc host), or any
 * syscall failure all log a warning (or nothing, for the common "not under
 * systemd" case) and return `false` — this helper never throws.
 */

import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi";
import { createLogger } from "@nexus/core/node";

const log = createLogger("agent:sd-notify");

const AF_UNIX = 1;
const SOCK_DGRAM = 2;
/** sizeof(struct sockaddr_un) on Linux: sa_family_t (2 bytes) + sun_path[108]. */
const SOCKADDR_UN_SIZE = 110;
const SUN_PATH_MAX = 108;

/** Configured systemd watchdog interval this deploy expects (see nexus-agent.service). */
export const WATCHDOG_SEC = 30;
/** Notify at less than half of WatchdogSec — systemd's own recommended margin. */
const DEFAULT_INTERVAL_MS = Math.floor((WATCHDOG_SEC * 1000) / 2);

interface LibcSocketSymbols {
  socket: (domain: number, type: number, protocol: number) => number;
  connect: (fd: number, addr: Pointer | null, len: number) => number;
  write: (fd: number, buf: Pointer | null, len: number) => bigint;
  close: (fd: number) => number;
}

// Lazily dlopen'd + cached for the process lifetime. `undefined` = not yet
// attempted, `null` = attempted and failed (permanent no-op).
let libc: LibcSocketSymbols | null | undefined;

function loadLibc(): LibcSocketSymbols | null {
  if (libc !== undefined) return libc;
  try {
    const { symbols } = dlopen("libc.so.6", {
      socket: {
        args: [FFIType.i32, FFIType.i32, FFIType.i32],
        returns: FFIType.i32,
      },
      connect: {
        args: [FFIType.i32, FFIType.ptr, FFIType.u32],
        returns: FFIType.i32,
      },
      write: {
        args: [FFIType.i32, FFIType.ptr, FFIType.u64],
        returns: FFIType.i64,
      },
      close: { args: [FFIType.i32], returns: FFIType.i32 },
    });
    libc = symbols as unknown as LibcSocketSymbols;
  } catch (err) {
    log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "sd-notify: libc.so.6 unavailable — watchdog notify permanently disabled for this process",
    );
    libc = null;
  }
  return libc;
}

/**
 * Pack a `struct sockaddr_un` for `path`. Supports both filesystem paths
 * (NUL-terminated) and Linux's abstract-namespace form (`@name` — the `@` is
 * replaced with a leading NUL byte per the abstract-socket convention).
 */
function buildSockaddrUn(path: string): { addr: Uint8Array; len: number } {
  const abstract = path.startsWith("@");
  const nameBytes = new TextEncoder().encode(
    abstract ? path.slice(1) : path,
  );
  const headerLen = abstract ? 3 : 2; // family(2) [+ leading NUL(1) for abstract]
  // Both forms reserve exactly 1 byte of sun_path[108] beyond the name itself
  // (a trailing NUL for filesystem paths, the leading NUL marker already
  // counted in headerLen for abstract paths) — so the same 107-byte ceiling
  // applies to the name/path portion in either case.
  if (nameBytes.length > SUN_PATH_MAX - 1) {
    throw new Error(`NOTIFY_SOCKET path too long (${path.length} bytes)`);
  }
  const addr = new Uint8Array(SOCKADDR_UN_SIZE); // zero-filled
  new DataView(addr.buffer).setUint16(0, AF_UNIX, true);
  addr.set(nameBytes, headerLen);
  const len = abstract
    ? headerLen + nameBytes.length
    : headerLen + nameBytes.length + 1; // + NUL terminator
  return { addr, len };
}

/**
 * Write one `WATCHDOG=1` datagram to `$NOTIFY_SOCKET`. Returns `true` on a
 * successful write, `false` on any no-op or failure (see module doc) — never
 * throws.
 */
export function sendWatchdogNotify(message = "WATCHDOG=1\n"): boolean {
  const socketPath = process.env.NOTIFY_SOCKET;
  if (!socketPath) return false; // not under systemd supervision — silent no-op

  const symbols = loadLibc();
  if (!symbols) return false;

  let fd = -1;
  try {
    const { addr, len } = buildSockaddrUn(socketPath);
    fd = symbols.socket(AF_UNIX, SOCK_DGRAM, 0);
    if (fd < 0) throw new Error("socket() failed");
    if (symbols.connect(fd, ptr(addr), len) !== 0) {
      throw new Error("connect() failed");
    }
    const payload = new TextEncoder().encode(message);
    const written = symbols.write(fd, ptr(payload), payload.length);
    if (written < 0n) throw new Error("write() failed");
    return true;
  } catch (err) {
    log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "sd-notify: WATCHDOG datagram send failed",
    );
    return false;
  } finally {
    if (fd >= 0) {
      try {
        symbols.close(fd);
      } catch {
        // best-effort cleanup — the fd leaks only on an already-broken libc
      }
    }
  }
}

/**
 * Start the periodic watchdog keep-alive. Fires once immediately, then every
 * `intervalMs` (default: half of `WATCHDOG_SEC`, i.e. ~15s for the
 * configured 30s `WatchdogSec`). Returns a stop function.
 *
 * `notify` is injectable for tests. On a host with no `$NOTIFY_SOCKET`
 * (dev, macOS) every tick is a cheap, silent no-op.
 */
export function startSdNotifyWatchdog(opts?: {
  intervalMs?: number;
  notify?: () => boolean;
}): () => void {
  const intervalMs = opts?.intervalMs ?? DEFAULT_INTERVAL_MS;
  const notify = opts?.notify ?? sendWatchdogNotify;

  notify();
  const timer = setInterval(() => {
    notify();
  }, intervalMs);
  if (typeof timer === "object" && timer && "unref" in timer) {
    (timer as { unref: () => void }).unref();
  }

  return () => clearInterval(timer);
}
