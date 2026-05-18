/**
 * withErrorCapture — wrap a script's `main()` so any uncaught error lands
 * in `script_errors` before the process exits non-zero.
 *
 * Spec: openspec/changes/enforce-pino-script-errors
 *
 * Usage:
 *   import { withErrorCapture } from "@nexus/core/node";
 *   withErrorCapture("backfill-git-origin", async () => {
 *     await runActualBackfill();
 *   });
 *
 * Guarantees:
 *   - process.exit(1) on caught error
 *   - buffered log records flushed before exit (best-effort 2s timeout)
 *   - the captured error is also written to stderr so operators see it
 *     immediately without grepping the DB
 */

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

import { flushNow, pushScriptError } from "./pino-db-transport";

export async function withErrorCapture(
  scriptName: string,
  body: () => Promise<void>,
): Promise<void> {
  const machine = hostname();
  try {
    await body();
    await flushNow();
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    process.stderr.write(`[${scriptName}] FAILED: ${error.message}\n`);
    if (error.stack) process.stderr.write(error.stack + "\n");

    pushScriptError({
      id: randomUUID(),
      scriptName,
      level: "fatal",
      message: error.message,
      stack: error.stack ?? null,
      context: null,
      machine,
      exitCode: 1,
      createdAt: new Date(),
    });

    // Bound the flush so a hung DB doesn't keep the process alive forever.
    await Promise.race([
      flushNow(),
      new Promise<void>((r) => setTimeout(r, 2_000)),
    ]);
    process.exit(1);
  }
}
