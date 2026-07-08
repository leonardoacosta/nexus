/**
 * POST /paste route tests (add-paste-to-project task 1.6).
 *
 * Same DELIBERATE write posture as /capture: NOT fail-soft. A dropped paste is
 * silent data loss, so every failure surfaces as a distinct status (400 bad
 * input, 404 unknown project, 500 filesystem failure) and a success is never
 * fabricated. Unlike /capture (mx-gateway proxy), /paste writes decoded bytes to
 * the local filesystem — these tests exercise the real write path against
 * per-test temp directories, no mocked fs.
 *
 * Project resolution is stubbed with a RESTORABLE `spyOn` on the config-loader's
 * `getProjects` (nx-509z5 class — restored in afterEach so the real resolver is
 * handed back and no process-global mock leaks to sibling suites). The shared
 * `@nexus/core/node` logger spy is already installed worker-wide by the bun test
 * preload (src/testing/preload.ts), so no per-file logger mock is needed.
 */

import { describe, expect, it, spyOn, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as configLoader from "../services/config-loader";
import { handlePostPaste } from "./paste";

// ── Temp-dir lifecycle ──────────────────────────────────────────────────────
const tmpRoots: string[] = [];
function makeTmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "paste-test-"));
  tmpRoots.push(dir);
  return dir;
}

afterEach(() => {
  // Restore the real getProjects resolver so no stub leaks to sibling suites.
  spyOn(configLoader, "getProjects").mockRestore();
  // Clean up every temp dir this test created.
  while (tmpRoots.length) {
    const dir = tmpRoots.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

// ── Helpers ─────────────────────────────────────────────────────────────────
function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

function pasteRequest(body: unknown): Request {
  return new Request("http://agent.local/paste", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Point `getProjects()` at a single project whose cwd is `path`. */
function stubProject(code: string, path: string): void {
  spyOn(configLoader, "getProjects").mockReturnValue([{ code, name: code, path }]);
}

// ── Project-mode ─────────────────────────────────────────────────────────────
describe("handlePostPaste — project-mode drop", () => {
  it("lands the decoded bytes under <cwd>/docs/screenshots/", async () => {
    const cwd = makeTmpRoot();
    stubProject("demo", cwd);

    const res = await handlePostPaste(
      pasteRequest({ project: "demo", filename: "shot.png", data_base64: b64("PNGBYTES") }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string };
    const expected = join(cwd, "docs", "screenshots", "shot.png");
    expect(body.path).toBe(expected);
    expect(existsSync(expected)).toBe(true);
    expect(readFileSync(expected, "utf8")).toBe("PNGBYTES");
  });
});

// ── Absolute-path mode ───────────────────────────────────────────────────────
describe("handlePostPaste — absolute-path drop", () => {
  it("writes filename under the given absolute directory", async () => {
    const dir = makeTmpRoot();

    const res = await handlePostPaste(
      pasteRequest({ path: dir, filename: "a.png", data_base64: b64("ABC") }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string };
    expect(body.path).toBe(join(dir, "a.png"));
    expect(readFileSync(join(dir, "a.png"), "utf8")).toBe("ABC");
  });

  it("rejects a non-absolute path with 400", async () => {
    const res = await handlePostPaste(
      pasteRequest({ path: "relative/dir", filename: "a.png", data_base64: b64("ABC") }),
    );
    expect(res.status).toBe(400);
  });
});

// ── No-clobber / collision suffixing ─────────────────────────────────────────
describe("handlePostPaste — collision suffixing", () => {
  it("suffixes a colliding basename and leaves the existing file byte-identical", async () => {
    const dir = makeTmpRoot();

    const first = await handlePostPaste(
      pasteRequest({ path: dir, filename: "c.png", data_base64: b64("ORIGINAL") }),
    );
    expect(first.status).toBe(200);
    expect(((await first.json()) as { path: string }).path).toBe(join(dir, "c.png"));

    const second = await handlePostPaste(
      pasteRequest({ path: dir, filename: "c.png", data_base64: b64("SECOND") }),
    );
    expect(second.status).toBe(200);
    const secondPath = ((await second.json()) as { path: string }).path;

    // New file is suffixed, never the original name.
    expect(secondPath).toBe(join(dir, "c-1.png"));
    // Original left intact.
    expect(readFileSync(join(dir, "c.png"), "utf8")).toBe("ORIGINAL");
    // Suffixed file has the new bytes.
    expect(readFileSync(secondPath, "utf8")).toBe("SECOND");
  });
});

// ── Loud failures ────────────────────────────────────────────────────────────
describe("handlePostPaste — loud failures", () => {
  it("unknown project -> 404 and writes nothing", async () => {
    const cwd = makeTmpRoot();
    // getProjects returns [] (real resolver, empty cache) and no db is passed,
    // so an id lookup is impossible either.
    spyOn(configLoader, "getProjects").mockReturnValue([]);

    const res = await handlePostPaste(
      pasteRequest({ project: "ghost", filename: "x.png", data_base64: b64("X") }),
    );

    expect(res.status).toBe(404);
    // No docs/screenshots tree was created under any resolved cwd.
    expect(existsSync(join(cwd, "docs", "screenshots"))).toBe(false);
  });

  it("missing filename -> 400", async () => {
    const dir = makeTmpRoot();
    const res = await handlePostPaste(
      pasteRequest({ path: dir, data_base64: b64("X") }),
    );
    expect(res.status).toBe(400);
  });

  it("missing data_base64 -> 400", async () => {
    const dir = makeTmpRoot();
    const res = await handlePostPaste(pasteRequest({ path: dir, filename: "x.png" }));
    expect(res.status).toBe(400);
  });

  it("both project and path present -> 400", async () => {
    const dir = makeTmpRoot();
    const res = await handlePostPaste(
      pasteRequest({ project: "demo", path: dir, filename: "x.png", data_base64: b64("X") }),
    );
    expect(res.status).toBe(400);
  });

  it("non-base64 data_base64 -> 400", async () => {
    const dir = makeTmpRoot();
    const res = await handlePostPaste(
      pasteRequest({ path: dir, filename: "x.png", data_base64: "not!!!valid!!!base64" }),
    );
    expect(res.status).toBe(400);
    expect(existsSync(join(dir, "x.png"))).toBe(false);
  });

  it("oversized payload -> 400", async () => {
    const dir = makeTmpRoot();
    // 25MB + 1 decoded bytes, base64-encoded — just over the cap.
    const oversized = Buffer.alloc(25 * 1024 * 1024 + 1).toString("base64");
    const res = await handlePostPaste(
      pasteRequest({ path: dir, filename: "big.png", data_base64: oversized }),
    );
    expect(res.status).toBe(400);
    expect(existsSync(join(dir, "big.png"))).toBe(false);
  });

  it("filesystem failure -> 500 and no partial file remains", async () => {
    const dir = makeTmpRoot();
    // Make an ancestor of the destination a regular FILE, so mkdir -p fails
    // with ENOTDIR — a deterministic filesystem failure with no mocking.
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "i am a file, not a dir");
    const dest = join(blocker, "nested");

    const res = await handlePostPaste(
      pasteRequest({ path: dest, filename: "x.png", data_base64: b64("X") }),
    );

    expect(res.status).toBe(500);
    // The blocker file is untouched; no partial artifact was created.
    expect(readFileSync(blocker, "utf8")).toBe("i am a file, not a dir");
  });

  it("invalid JSON body -> 400", async () => {
    const req = new Request("http://agent.local/paste", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ not json",
    });
    const res = await handlePostPaste(req);
    expect(res.status).toBe(400);
  });
});

// ── Atomicity (tmp + rename) ─────────────────────────────────────────────────
describe("handlePostPaste — atomic write", () => {
  it("leaves no temp artifact behind after a successful write (tmp+rename)", async () => {
    const dir = makeTmpRoot();

    const res = await handlePostPaste(
      pasteRequest({ path: dir, filename: "atomic.png", data_base64: b64("DATA") }),
    );
    expect(res.status).toBe(200);

    const entries = readdirSync(dir);
    // Only the final file exists — the temp file was renamed away, never left
    // visible mid-write.
    expect(entries).toEqual(["atomic.png"]);
    expect(entries.some((e) => e.includes(".tmp-"))).toBe(false);
  });
});
