import { describe, test, expect } from "bun:test";
import { isPidAlive } from "./pid";

describe("isPidAlive", () => {
  test("the current process's own pid is alive", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  test("a pid far beyond the kernel's pid_max is never alive", () => {
    // Linux default pid_max is 4194304 — this is comfortably out of range on
    // every platform this runs on.
    expect(isPidAlive(999_999_999)).toBe(false);
  });
});
