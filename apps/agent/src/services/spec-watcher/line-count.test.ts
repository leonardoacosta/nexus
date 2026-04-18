import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dir);
const MAX_LINES = 250;

describe("spec-watcher module line-count ceiling", () => {
  const files = readdirSync(DIR).filter(
    (f) => f.endsWith(".ts") && !f.includes(".test."),
  );

  for (const file of files) {
    test(`${file} must be ≤${MAX_LINES} lines`, () => {
      const content = readFileSync(join(DIR, file), "utf-8");
      const lineCount = content.split("\n").length;
      expect(lineCount).toBeLessThanOrEqual(MAX_LINES);
    });
  }
});
