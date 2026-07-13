/**
 * Unit tests for statusline-usage-file.ts.
 *
 * Spec: plans/027-usage-pipeline-test-gap.md (task 3.2) — writer half of the
 * cross-app usage-cache contract. `writeStatuslineUsageFile` is now the ONLY
 * writer of `~/.claude/scripts/state/usage-cache.json`; a silent regression
 * here freezes usage bars fleet-wide with only a debug-level log trail.
 *
 * Structural pattern: credential-refresh-job.test.ts (fake-Db chain stub +
 * active-credential-watcher `__testing` seam). ALL fs calls are spied via
 * restorable `spyOn` and restored in `afterEach` — an unspied run would
 * clobber the live usage cache on the operator's machine. NEVER
 * `bun:test`'s `mock.module` (process-global, leaks forward into later
 * test files in a full-suite run — documented contamination incident).
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "@nexus/db";
import { writeStatuslineUsageFile } from "./statusline-usage-file";
import { __testing as activeTesting } from "../credentials/active-credential-watcher";

interface UsageRow {
  usage5hUsed: number | null;
  usage5hLimit: number | null;
  usage5hResetAt: Date | null;
  usage7dUsed: number | null;
  usage7dLimit: number | null;
  usage7dResetAt: Date | null;
  usagePolledAt: Date | null;
}

function fakeDb(rows: UsageRow[], calls?: { selects: number }): Db {
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => Promise.resolve(rows),
  };
  return {
    select: () => {
      if (calls) calls.selects += 1;
      return chain;
    },
  } as unknown as Db;
}

function rejectingDb(): Db {
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => Promise.reject(new Error("pg exploded")),
  };
  return { select: () => chain } as unknown as Db;
}

const EXPECTED_PATH = join(homedir(), ".claude", "scripts", "state", "usage-cache.json");
const EXPECTED_TMP = `${EXPECTED_PATH}.tmp.${process.pid}`;

describe("writeStatuslineUsageFile", () => {
  let writeSpy: ReturnType<typeof spyOn>;
  let renameSpy: ReturnType<typeof spyOn>;
  let mkdirSpy: ReturnType<typeof spyOn>;
  let written: Array<{ path: string; data: string; mode: number | undefined }>;
  let renamed: Array<{ from: string; to: string }>;

  beforeEach(() => {
    activeTesting.resetSnapshot();
    written = [];
    renamed = [];
    writeSpy = spyOn(fs, "writeFileSync").mockImplementation(((
      p: fs.PathOrFileDescriptor,
      d: string,
      o?: fs.WriteFileOptions,
    ) => {
      written.push({
        path: String(p),
        data: String(d),
        mode: typeof o === "object" && o !== null ? (o.mode as number) : undefined,
      });
    }) as never);
    renameSpy = spyOn(fs, "renameSync").mockImplementation(((f: fs.PathLike, t: fs.PathLike) => {
      renamed.push({ from: String(f), to: String(t) });
    }) as never);
    mkdirSpy = spyOn(fs, "mkdirSync").mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    writeSpy.mockRestore();
    renameSpy.mockRestore();
    mkdirSpy.mockRestore();
    activeTesting.resetSnapshot();
  });

  async function activateFingerprint(): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "nx-usage-file-"));
    const credPath = join(dir, ".credentials.json");
    await writeFile(
      credPath,
      JSON.stringify({ claudeAiOauth: { accessToken: "at-test", refreshToken: "rt-test" } }),
    );
    const fakeWatcherPool = {
      list: async () => [],
      add: async () => "updated" as const,
      updateSecret: async () => {},
    };
    await activeTesting.runRefresh(fakeWatcherPool, credPath);
    await rm(dir, { recursive: true, force: true });
    expect(activeTesting.getSnapshot().fingerprint).not.toBeNull();
  }

  const FULL_ROW: UsageRow = {
    usage5hUsed: 41,
    usage5hLimit: 50,
    usage5hResetAt: new Date("2030-01-01T00:00:00.000Z"),
    usage7dUsed: 220,
    usage7dLimit: 1000,
    usage7dResetAt: new Date("2030-01-08T00:00:00.000Z"),
    usagePolledAt: new Date(),
  };

  it("skips (no db read, no write) when there is no active fingerprint", async () => {
    const calls = { selects: 0 };
    await writeStatuslineUsageFile(fakeDb([FULL_ROW], calls));
    expect(calls.selects).toBe(0);
    expect(written).toHaveLength(0);
    expect(renamed).toHaveLength(0);
  });

  it("skips when no credential row matches the fingerprint", async () => {
    await activateFingerprint();
    await writeStatuslineUsageFile(fakeDb([]));
    expect(written).toHaveLength(0);
  });

  it("skips when the row has never been polled (usagePolledAt null)", async () => {
    await activateFingerprint();
    await writeStatuslineUsageFile(fakeDb([{ ...FULL_ROW, usagePolledAt: null }]));
    expect(written).toHaveLength(0);
  });

  it("skips when both windows are empty (toPeriod → undefined twice)", async () => {
    await activateFingerprint();
    await writeStatuslineUsageFile(
      fakeDb([
        {
          usage5hUsed: null,
          usage5hLimit: null,
          usage5hResetAt: null,
          usage7dUsed: null,
          usage7dLimit: null,
          usage7dResetAt: null,
          usagePolledAt: new Date(),
        },
      ]),
    );
    expect(written).toHaveLength(0);
  });

  it("writes the CachedUsage shape the statusline reader parses", async () => {
    await activateFingerprint();
    const before = Math.floor(Date.now() / 1000);
    await writeStatuslineUsageFile(fakeDb([FULL_ROW]));
    expect(written).toHaveLength(1);
    const payload = JSON.parse(written[0]!.data) as {
      fetched_at: number;
      data: {
        five_hour?: { utilization: number; resets_at?: string };
        seven_day?: { utilization: number; resets_at?: string };
      };
    };
    expect(Object.keys(payload).sort()).toEqual(["data", "fetched_at"]);
    expect(payload.fetched_at).toBeGreaterThanOrEqual(before);
    expect(payload.fetched_at).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    expect(payload.data.five_hour?.utilization).toBe(82); // 41/50*100
    expect(payload.data.five_hour?.resets_at).toBe("2030-01-01T00:00:00.000Z");
    expect(payload.data.seven_day?.utilization).toBe(22); // 220/1000*100
    expect(payload.data.seven_day?.resets_at).toBe("2030-01-08T00:00:00.000Z");
  });

  it("zero or null limit yields utilization 0, never NaN/Infinity", async () => {
    await activateFingerprint();
    await writeStatuslineUsageFile(fakeDb([{ ...FULL_ROW, usage5hLimit: 0, usage7dLimit: null }]));
    const payload = JSON.parse(written[0]!.data) as {
      data: { five_hour: { utilization: number }; seven_day: { utilization: number } };
    };
    expect(payload.data.five_hour.utilization).toBe(0);
    expect(payload.data.seven_day.utilization).toBe(0);
  });

  it("omits a window with no data instead of writing an empty object", async () => {
    await activateFingerprint();
    await writeStatuslineUsageFile(
      fakeDb([{ ...FULL_ROW, usage7dUsed: null, usage7dLimit: null, usage7dResetAt: null }]),
    );
    const payload = JSON.parse(written[0]!.data) as {
      data: { five_hour: { utilization: number } };
    };
    expect("seven_day" in payload.data).toBe(false);
    expect(payload.data.five_hour.utilization).toBe(82);
  });

  it("omits resets_at when the reset timestamp is null", async () => {
    await activateFingerprint();
    await writeStatuslineUsageFile(fakeDb([{ ...FULL_ROW, usage5hResetAt: null }]));
    const payload = JSON.parse(written[0]!.data) as { data: { five_hour: object } };
    expect("resets_at" in payload.data.five_hour).toBe(false);
  });

  it("writes atomically: pid-suffixed tmp file, mode 0o600, rename to final path", async () => {
    await activateFingerprint();
    await writeStatuslineUsageFile(fakeDb([FULL_ROW]));
    expect(written[0]!.path).toBe(EXPECTED_TMP);
    expect(written[0]!.mode).toBe(0o600);
    expect(renamed).toEqual([{ from: EXPECTED_TMP, to: EXPECTED_PATH }]);
    expect(mkdirSpy).toHaveBeenCalled();
  });

  it("never throws when the db read rejects (fail-soft)", async () => {
    await activateFingerprint();
    await expect(writeStatuslineUsageFile(rejectingDb())).resolves.toBeUndefined();
    expect(written).toHaveLength(0);
  });

  it("never throws when the file write throws (fail-soft)", async () => {
    await activateFingerprint();
    writeSpy.mockImplementation((() => {
      throw new Error("disk full");
    }) as never);
    await expect(writeStatuslineUsageFile(fakeDb([FULL_ROW]))).resolves.toBeUndefined();
    expect(renamed).toHaveLength(0);
  });
});
