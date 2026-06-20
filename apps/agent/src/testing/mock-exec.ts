/**
 * Shared, RESTORABLE `../utils/exec` mock for route/service suites (nx-509z5 class).
 *
 * Root cause
 * ──────────
 * Several route suites (split-routes, sessions, health-process-watcher) each
 * installed their own `mock.module("../utils/exec", () => ({ … }))` to stub the
 * two subprocess helpers (`execText`/`execJson`). Because `mock.module` is
 * process-global, last-writer-wins, AND irreversible:
 *   - the stub `execText`/`execJson` leaked into `utils/exec.test.ts`, which
 *     calls the REAL functions and asserts on real subprocess behavior — so its
 *     "captures stdout", timeout, and cwd tests saw `Promise.resolve("")` and
 *     failed;
 *   - the factories also substituted FAKE `ExecError`/`ExecTimeoutError` classes,
 *     so `expect(err).toBeInstanceOf(ExecError)` in exec.test.ts failed against
 *     the real class.
 *
 * Fix
 * ───
 * Use `spyOn(execNs, …)` instead of `mock.module`. `spyOn` is RESTORABLE: the
 * returned handle's `.restore()` (call in the suite's `afterAll`) reverts both
 * functions to the real implementation, so sibling suites that load LATER
 * (exec.test.ts) get the real `../utils/exec`. The real `ExecError` /
 * `ExecTimeoutError` classes are never touched, so instanceof checks hold.
 *
 * The restore handle is per-call (NOT module-level state) so multiple suites
 * mocking exec in the same process don't stomp each other's restore set.
 *
 * This file lives in ../testing but imports the sibling `../utils/exec` module
 * via a relative path supplied by `installExecMock`'s import below.
 */

import { spyOn } from "bun:test";
import * as execNs from "../utils/exec";

/** Implementations the caller supplies for the two spied functions. */
export interface ExecMockImpls {
  execText: (
    cmd: string,
    args: string[],
    opts?: unknown,
  ) => Promise<string>;
  execJson: (
    cmd: string,
    args: string[],
    opts?: unknown,
  ) => Promise<unknown>;
}

/** Restore handle returned by {@link installExecMock}. */
export interface ExecMockHandle {
  /** Revert `execText`/`execJson` to the real `../utils/exec` functions. */
  restore(): void;
}

/**
 * Spy `execText`/`execJson` with caller-supplied stubs. Every other export
 * (`ExecError`, `ExecTimeoutError`, `ExecOptions`) stays REAL. Call `.restore()`
 * on the returned handle in `afterAll` so later suites get the real module back.
 */
export function installExecMock(impls: ExecMockImpls): ExecMockHandle {
  const spies = [
    spyOn(execNs, "execText").mockImplementation(
      impls.execText as typeof execNs.execText,
    ),
    spyOn(execNs, "execJson").mockImplementation(
      impls.execJson as typeof execNs.execJson,
    ),
  ];
  return {
    restore() {
      for (const spy of spies) spy.mockRestore();
    },
  };
}
