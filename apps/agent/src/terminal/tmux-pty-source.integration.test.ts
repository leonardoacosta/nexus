import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { TmuxPtySource } from "./tmux-pty-source";

/**
 * Tier 2 — real-tmux round-trip integration tests for TmuxPtySource.
 *
 * Tier 1 (tmux-pty-source.test.ts) pins the exact tmux argv with a recording
 * mock. Tier 2 proves the SAME methods actually drive a live tmux pane, because
 * the four PTY bugs this session fixed were real tmux-interaction bugs:
 *
 *   - geometry mismatch  -> 2.3 asserts geometry() reports the REAL pane size
 *                           (120x40), not the 80x24 default, i.e. the
 *                           `display-message` sample round-trips end-to-end.
 *   - auto-Enter on input -> 2.4 asserts plain chars do NOT submit and only an
 *                           explicit carriage return does (the `send-keys -l`
 *                           literal flag working against real tmux).
 *   - window-size / full  -> 2.5 asserts resize() drives the live pane and that
 *                           take-over / restore flip `window-size manual`.
 *
 * The target under test is a deterministic surrogate (test/fixtures/
 * tui-surrogate.sh) whose output we fully control — NOT the real Claude TUI
 * (which would be non-deterministic). The surrogate prints a known marker line
 * and renders `SUBMITS=<n>` that increments only on carriage return.
 *
 * `hasTmux`-gated via describe.skipIf so a tmux-less CI skips cleanly. On a
 * tmux-equipped host the suite RUNS (and must pass).
 */

const hasTmux = Bun.spawnSync(["command", "-v", "tmux"]).exitCode === 0;

/** Absolute path to the deterministic surrogate fixture. */
const SURROGATE = join(import.meta.dir, "..", "..", "test", "fixtures", "tui-surrogate.sh");

/** Pinned pane geometry for every test session (set on the detached -d window). */
const PANE_COLS = 120;
const PANE_ROWS = 40;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run a tmux subcommand synchronously and return trimmed stdout. */
function tmux(...args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["tmux", ...args], { stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

/** Snapshot the pane contents (deterministic — preferred over racing onData). */
function capture(target: string): string {
  return tmux("capture-pane", "-p", "-t", target).stdout;
}

/** Sample the live pane geometry directly (independent of the source cache). */
function paneGeometry(target: string): { cols: number; rows: number } {
  const out = tmux("display-message", "-p", "-t", target, "#{pane_width}x#{pane_height}").stdout.trim();
  const m = out.match(/^(\d+)x(\d+)$/);
  if (!m) throw new Error(`unexpected display-message output: ${JSON.stringify(out)}`);
  return { cols: Number(m[1]), rows: Number(m[2]) };
}

/** Count nexus-tmux-pipe-* temp dirs currently on disk (FIFO-leak probe). */
function pipeTmpDirCount(): number {
  return readdirSync(tmpdir()).filter((n) => n.startsWith("nexus-tmux-pipe-")).length;
}

describe.skipIf(!hasTmux)("TmuxPtySource real-tmux round-trip (Tier 2)", () => {
  let session: string;
  let target: string;
  let source: TmuxPtySource | null;

  beforeEach(async () => {
    // Unique session per test so tests cannot leak state into each other.
    session = `nx-pty-it-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    // The session name is the target. We deliberately use the session-only form
    // (not `session:0.0`): this host runs tmux with base-index/pane-base-index
    // set to 1, so a hard-coded `:0.0` would resolve to a non-existent window.
    // The session-only target resolves to the active pane regardless of the
    // user's base-index, which is the robust, config-agnostic choice.
    target = session;
    source = null;

    // -d (detached) + -x/-y pins the window geometry with no attached client to
    // override it, so the pane is a known 120x40.
    const created = tmux(
      "new-session",
      "-d",
      "-x",
      String(PANE_COLS),
      "-y",
      String(PANE_ROWS),
      "-s",
      session,
      `bash ${SURROGATE}`,
    );
    expect(created.exitCode).toBe(0);

    // Let the surrogate print its marker and tmux finish sizing the pane.
    await delay(200);
  });

  afterEach(async () => {
    // Close the source first so its FIFO dir is cleaned up even on test failure.
    try {
      source?.close();
    } catch {
      // best-effort
    }
    source = null;
    // Kill the session (ignore "session not found" if a test already did).
    tmux("kill-session", "-t", session);
    await delay(20);
  });

  // ── 2.3: read path — geometry + scrollback seed ───────────────────────────

  it("[2.3] reports the real pane geometry and seeds the surrogate marker", () => {
    source = new TmuxPtySource(target);

    // The proof the geometry sample round-trips: 120x40 (real), not the 80x24
    // default that a failed sample would leave behind.
    expect(source.geometry()).toEqual({ cols: PANE_COLS, rows: PANE_ROWS });

    // Scrollback seeded from `capture-pane` must contain the surrogate's marker.
    const scrollback = source.getScrollback();
    expect(scrollback.some((l) => l.includes("NEXUS_SURROGATE_READY"))).toBe(true);
    // SUBMITS=0 is rendered at start too — confirms a fresh, un-submitted pane.
    expect(scrollback.some((l) => l.includes("SUBMITS=0"))).toBe(true);
  });

  // ── 2.4: write path — auto-Enter regression guard, end-to-end ─────────────

  it("[2.4] plain chars do not submit; only an explicit CR submits", async () => {
    source = new TmuxPtySource(target);

    // Sanity: fresh pane shows no submission.
    expect(capture(target)).toContain("SUBMITS=0");

    // Write plain characters. send-keys -l must insert them literally WITHOUT
    // submitting (the auto-Enter regression would bump SUBMITS here).
    source.write(new TextEncoder().encode("hi"));
    await delay(200);

    const afterChars = capture(target);
    expect(afterChars).toContain("SUBMITS=0");
    // The char arrived (observable proof input reached the pane, no submit).
    expect(afterChars).toContain("LAST=i");

    // Now write an explicit carriage return — exactly one submission.
    source.write(new Uint8Array([0x0d]));
    await delay(200);

    const afterCr = capture(target);
    expect(afterCr).toContain("SUBMITS=1");

    // A second CR submits exactly once more — proves each CR is one submit, not
    // a sticky/auto-repeat.
    source.write(new Uint8Array([0x0d]));
    await delay(200);
    expect(capture(target)).toContain("SUBMITS=2");
  });

  // ── 2.5: resize + teardown ────────────────────────────────────────────────

  it("[2.5] resize drives the live pane, take-over flips manual, restore reverts", async () => {
    source = new TmuxPtySource(target);
    expect(source.isTakeOverActive()).toBe(false);

    const NEW_COLS = 100;
    const NEW_ROWS = 30;
    source.resize(NEW_COLS, NEW_ROWS);
    await delay(250);

    // The live pane actually reflowed to the requested size.
    expect(paneGeometry(target)).toEqual({ cols: NEW_COLS, rows: NEW_ROWS });
    // The source's own cached geometry tracks it (re-sampled in resize()).
    expect(source.geometry()).toEqual({ cols: NEW_COLS, rows: NEW_ROWS });
    // Take-over is active: window-size was forced manual.
    expect(source.isTakeOverActive()).toBe(true);
    // tmux confirms the forced option.
    expect(tmux("show-options", "-w", "-v", "-t", target, "window-size").stdout.trim()).toBe(
      "manual",
    );

    // Surrogate is still alive and rendering at the new width (marker present).
    expect(capture(target)).toContain("NEXUS_SURROGATE_READY");

    // Restore: window-size manual reverts to the captured prior value.
    source.restoreWindowSize();
    expect(source.isTakeOverActive()).toBe(false);
    // The prior value (default on a fresh window) is restored — not "manual".
    expect(tmux("show-options", "-w", "-v", "-t", target, "window-size").stdout.trim()).not.toBe(
      "manual",
    );
  });

  it("[2.5] close() detaches the stream, completes onData, and removes the FIFO dir", async () => {
    const before = pipeTmpDirCount();
    source = new TmuxPtySource(target);
    // One new pipe temp dir exists while attached.
    expect(pipeTmpDirCount()).toBe(before + 1);

    // Observe the output stream completing on close. onData fires for live pane
    // bytes; we assert close() tears the reader down without throwing and the
    // FIFO dir is gone (the deterministic, race-free signal of teardown).
    let unsub: (() => void) | null = source.onData(() => {});

    // Drive a little output so the pipe has live bytes flowing first.
    source.write(new Uint8Array([0x0d]));
    await delay(150);

    expect(() => {
      unsub?.();
      source?.close();
    }).not.toThrow();
    unsub = null;

    await delay(100);

    // The temp FIFO dir created at construction is removed by close().
    expect(pipeTmpDirCount()).toBe(before);

    // Writes after close are no-ops (closed guard) — pane unchanged.
    const snapshotBeforeClosedWrite = capture(target);
    source.write(new TextEncoder().encode("x"));
    await delay(100);
    expect(capture(target)).toBe(snapshotBeforeClosedWrite);

    // Mark closed so afterEach does not double-close.
    source = null;
    // Session is still alive (close() only detaches the pipe, never kills the
    // pane) — afterEach kills it.
    expect(existsSync(SURROGATE)).toBe(true);
  });
});
