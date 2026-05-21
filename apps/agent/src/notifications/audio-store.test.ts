/**
 * audio-store tests — file persistence + prune semantics.
 *
 * Spec: openspec/changes/notifications-overhaul (task 2.3)
 *
 * Uses NEXUS_CONFIG_DIR to redirect the audio dir into a per-test tmp.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, utimesSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import {
  audioDir,
  audioExists,
  audioPathFor,
  pruneAudioOlderThan,
  readAudioPath,
  writeAudio,
} from "./audio-store";

let tmp: string;
let prevConfigDir: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nexus-audio-store-"));
  prevConfigDir = process.env.NEXUS_CONFIG_DIR;
  process.env.NEXUS_CONFIG_DIR = tmp;
});

afterEach(() => {
  if (prevConfigDir === undefined) {
    delete process.env.NEXUS_CONFIG_DIR;
  } else {
    process.env.NEXUS_CONFIG_DIR = prevConfigDir;
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe("audio-store", () => {
  it("writeAudio creates the audio dir + file on first write", async () => {
    const bytes = new Uint8Array([0x49, 0x44, 0x33, 0x04]); // ID3v2 prefix
    const path = await writeAudio("notif-1", bytes);
    expect(path).toBe(join(audioDir(), "notif-1.mp3"));
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path)).toEqual(Buffer.from(bytes));
  });

  it("readAudioPath returns null for missing rows, path for present", async () => {
    expect(readAudioPath("not-yet")).toBeNull();
    await writeAudio("there", Buffer.from([1, 2, 3]));
    expect(readAudioPath("there")).toBe(audioPathFor("there"));
  });

  it("audioExists is stat-based — false for pruned files", async () => {
    await writeAudio("ghost", Buffer.from([4, 5, 6]));
    expect(audioExists("ghost")).toBe(true);
    rmSync(audioPathFor("ghost"), { force: true });
    expect(audioExists("ghost")).toBe(false);
  });

  it("pruneAudioOlderThan deletes files older than the threshold by mtime", async () => {
    // Seed two files: one with mtime 31 days ago, one fresh.
    await writeAudio("old", Buffer.from([0xff, 0xfb]));
    await writeAudio("new", Buffer.from([0xff, 0xfb]));
    const oldPath = audioPathFor("old");
    const aged = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    utimesSync(oldPath, aged, aged);

    const result = pruneAudioOlderThan(30);
    expect(result.count).toBe(1);
    expect(result.bytes).toBe(2);
    expect(audioExists("old")).toBe(false);
    expect(audioExists("new")).toBe(true);
  });

  it("pruneAudioOlderThan tolerates a missing dir", () => {
    rmSync(tmp, { recursive: true, force: true });
    const r = pruneAudioOlderThan(30);
    expect(r).toEqual({ count: 0, bytes: 0 });
  });

  it("writeAudio sanitises path separators in the id", async () => {
    const path = await writeAudio("a/b\\c", Buffer.from([0]));
    expect(path).toBe(join(audioDir(), "a_b_c.mp3"));
    // The file lives in the audio dir, not in a nested directory.
    expect(dirname(path)).toBe(audioDir());
  });
});
