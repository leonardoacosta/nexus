/**
 * Regression guard for nx-cblfj — dolt-backed bead rollups under the systemd
 * sandbox.
 *
 * Root cause: the agent runs with `ReadOnlyPaths=/home`. A DOLT-backed beads
 * store (`<project>/.beads/embeddeddolt/`) takes an on-disk `.lock` file even
 * for read-only `bd list`/`bd ready` queries, so under a read-only /home the
 * open() fails with EROFS, `bd` exits 1, `computeBeadRollup` returns null, and
 * every dolt-backed project (nx, oo, ap, ...) shows `beadRollup: null`.
 * SQLite-backed projects (`.beads/beads.db`) read fine read-only.
 *
 * The fix is a `ReadWritePaths=%h/dev` grant in the unit. This test fails if a
 * future edit drops that grant while keeping `ReadOnlyPaths=/home` — which
 * would silently re-break dolt rollups with no runtime error surfaced to the
 * user (the failure degrades to null, not a 500).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const UNIT_PATH = join(import.meta.dir, "../../../../deploy/nexus-agent.service");

describe("deploy/nexus-agent.service dolt sandbox (nx-cblfj)", () => {
  const unit = readFileSync(UNIT_PATH, "utf8");

  test("grants %h/dev write access so dolt can take its lock file", () => {
    // %h/dev must be writable — dolt's embedded lock lives under
    // <project>/.beads/embeddeddolt/.lock inside ~/dev.
    expect(unit).toMatch(/^ReadWritePaths=%h\/dev\s*$/m);
  });

  test("still hardens /home read-only (the grant is a carve-out, not a removal)", () => {
    // If ReadOnlyPaths=/home is ever removed the grant is moot, but we keep the
    // invariant paired so the sandbox intent stays legible.
    expect(unit).toMatch(/^ReadOnlyPaths=\/home\s*$/m);
  });
});
