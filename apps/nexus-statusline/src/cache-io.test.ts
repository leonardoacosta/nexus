import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "bun:test";
import { readJsonCache, writeJsonAtomic } from "./cache-io";

describe("cache-io — readJsonCache / writeJsonAtomic", () => {
  let dir: string;

  afterEach(() => {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  });

  it("round-trips a write then read with no validator", () => {
    dir = mkdtempSync(join(tmpdir(), "nx-cacheio-roundtrip-"));
    const path = join(dir, "cache.json");
    writeJsonAtomic(path, { a: 1, b: "two" });
    const read = readJsonCache<{ a: number; b: string }>(path);
    expect(read).toEqual({ a: 1, b: "two" });
  });

  it("returns null when the path does not exist", () => {
    dir = mkdtempSync(join(tmpdir(), "nx-cacheio-missing-"));
    const path = join(dir, "does-not-exist.json");
    expect(readJsonCache(path)).toBeNull();
  });

  it("returns null on corrupt JSON", () => {
    dir = mkdtempSync(join(tmpdir(), "nx-cacheio-corrupt-"));
    const path = join(dir, "cache.json");
    // writeJsonAtomic always emits valid JSON, so write the corrupt payload
    // directly for this case.
    writeFileSync(path, "{not json");
    expect(readJsonCache(path)).toBeNull();
  });

  it("validator rejects an invalid shape (null) and accepts a valid one (value)", () => {
    dir = mkdtempSync(join(tmpdir(), "nx-cacheio-validate-"));
    const path = join(dir, "cache.json");
    const isValid = (raw: unknown): raw is { ok: true } =>
      typeof raw === "object" && raw !== null && (raw as Record<string, unknown>).ok === true;

    writeJsonAtomic(path, { ok: false });
    expect(readJsonCache(path, isValid)).toBeNull();

    writeJsonAtomic(path, { ok: true });
    expect(readJsonCache(path, isValid)).toEqual({ ok: true });
  });

  it("writing to an unwritable path (missing parent dir) does not throw", () => {
    dir = mkdtempSync(join(tmpdir(), "nx-cacheio-unwritable-"));
    const path = join(dir, "no-such-subdir", "cache.json");
    expect(() => writeJsonAtomic(path, { a: 1 })).not.toThrow();
    expect(existsSync(path)).toBe(false);
  });

  it("leaves no .tmp sibling behind after a successful write", () => {
    dir = mkdtempSync(join(tmpdir(), "nx-cacheio-notmp-"));
    const path = join(dir, "cache.json");
    writeJsonAtomic(path, { a: 1 });
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });
});
