import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { locateTranscript } from "./transcript-locator";

let home: string;
let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "nexus-locator-"));
  process.env.HOME = home;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

describe("locateTranscript — fast path (file exists)", () => {
  it("resolves the encoded projects/<enc>/<id>.jsonl path", async () => {
    const cwd = "/home/user/dev/nx";
    const id = "11111111-2222-3333-4444-555555555555";
    const enc = "-home-user-dev-nx"; // cwd.replaceAll("/", "-")
    const dir = join(homedir(), ".claude", "projects", enc);
    mkdirSync(dir, { recursive: true });
    const expected = join(dir, id + ".jsonl");
    writeFileSync(expected, "{}\n");

    const got = await locateTranscript(cwd, id);
    expect(got).toBe(expected);
    // Pin the encoding convention (leading "/" -> leading "-").
    expect(got).toContain(enc);
  });
});

describe("locateTranscript — missing file", () => {
  it("resolves null after the watch timeout when the transcript never appears", async () => {
    const got = await locateTranscript("/home/user/dev/nowhere", "does-not-exist-uuid");
    expect(got).toBeNull();
  }, 8000); // WATCH_TIMEOUT_MS is 5000ms — allow headroom over Bun's 5s default.
});
