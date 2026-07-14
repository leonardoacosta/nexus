/**
 * Behavioral in-memory state snapshot / restore (nx-veo5g.4, Layer D).
 *
 * Every crash-restart of the agent zeroes all module-level Maps. Most of that
 * state is ephemeral by design (session-context cache, hook-event coalescing
 * buffers), but a handful of structures change *behavior* on loss:
 *
 *   - notification dedup window   (routes/notifications.ts `dedupMap`)
 *   - credential-swap ladder      (services/proactive-swap.ts `ladderState`)
 *   - rate-limit 429 tracker      (services/credential-pool/rate-limit-tracker.ts)
 *   - swap tracker                (services/credential-pool/swap-tracker.ts)
 *   - schema-drift emit dedup     (services/schema-drift.ts `lastEmitByEventType`)
 *
 * This module is the shared, minimal persistence mechanism for those. Each
 * service registers a `{ serialize, deserialize }` pair keyed by a stable
 * name — the snapshot module never needs to know a source's internal shape.
 *
 * Design decisions (from the nx-veo5g.4 contract):
 *   - Disk, not Postgres. The prior design review rejected a durable Postgres
 *     row for the session-context case as "pure write amplification"; the same
 *     reasoning applies to these high-frequency writers. A single JSON file
 *     under the existing `~/.config/nexus` state dir avoids a new DB concern.
 *   - Debounced, never write-through. A periodic flush (default 30s) serializes
 *     every registered source and writes only when the content actually changed
 *     since the last write (content-diff). This bounds writes to at most one
 *     per interval AND skips no-op churn — effectively flush-on-change without
 *     threading a `markDirty()` call into five hot-path writers.
 *   - Restore is non-fatal. A missing / corrupt / partial snapshot restores
 *     whatever it can and logs a warning, matching the `sessionManager.init()`
 *     "non-fatal on failure" convention. A source that isn't registered at
 *     restore time is simply skipped.
 *
 * NOT persisted (deliberate, same rationale as the excluded session-context
 * cache): the hook-event throttle's `buffers` map (hook-event-throttle.ts).
 * Those entries hold live `setTimeout` handles for an in-flight coalesced
 * burst of `tool_use_start`/`tool_use_end` events firing many times/second.
 * On restart the burst is gone and the live CC session immediately re-creates
 * the buffer; restoring a stale count would double-count. Its loss is benign,
 * so it belongs with session-context in the "ephemeral by design" bucket.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "@nexus/core/node";

const log = createLogger("agent:services:state-snapshot");

/** On-disk snapshot format version. Bump on an incompatible envelope change. */
const SNAPSHOT_VERSION = 1;

/** Default periodic-flush cadence. */
export const DEFAULT_SNAPSHOT_INTERVAL_MS = 30_000;

/**
 * A registered state source. `serialize` returns a JSON-serializable value;
 * `deserialize` restores from a previously-serialized value. Both run inside a
 * try/catch at the call site so a single misbehaving source can never abort a
 * whole snapshot or restore cycle.
 */
export interface SnapshotSource {
  serialize(): unknown;
  deserialize(data: unknown): void;
}

/** On-disk envelope. */
interface SnapshotEnvelope {
  version: number;
  savedAt: string;
  sources: Record<string, unknown>;
}

/** name → source. Module-level registry (singleton). */
const registry = new Map<string, SnapshotSource>();

/** Last-written serialized-sources JSON, for content-diff skip on flush. */
let lastWrittenJson: string | null = null;

/**
 * Register a state source under a stable `name`. Idempotent by name — a second
 * registration for the same name replaces the first and logs a warning (this
 * should only ever happen in test re-imports, since ES module bodies run once).
 */
export function registerSnapshotSource(name: string, source: SnapshotSource): void {
  if (registry.has(name)) {
    log.warn({ name }, "state-snapshot: source re-registered (replacing)");
  }
  registry.set(name, source);
}

/**
 * Resolve the snapshot file path. Honors `NEXUS_CONFIG_DIR` (tests + sandboxed
 * environments), falling back to `~/.config/nexus/state/behavioral-state.json`
 * — matching the audio-store convention.
 */
export function snapshotFilePath(): string {
  const configDir =
    process.env.NEXUS_CONFIG_DIR ??
    join(process.env.HOME ?? homedir(), ".config", "nexus");
  return join(configDir, "state", "behavioral-state.json");
}

/** Serialize every registered source into an envelope's `sources` map. */
function serializeSources(): Record<string, unknown> {
  const sources: Record<string, unknown> = {};
  for (const [name, source] of registry) {
    try {
      sources[name] = source.serialize();
    } catch (err) {
      log.warn(
        { name, err: err instanceof Error ? err.message : String(err) },
        "state-snapshot: source serialize failed (skipping source)",
      );
    }
  }
  return sources;
}

/**
 * Restore registered sources from the on-disk snapshot, if any. Non-fatal on a
 * missing / corrupt / partially-invalid file. Returns the number of sources
 * whose `deserialize` ran without throwing.
 *
 * Call this ONCE at boot, after all source modules have registered and BEFORE
 * the services begin actively mutating their state.
 */
export function restoreSnapshot(path: string = snapshotFilePath()): number {
  let raw: string;
  try {
    if (!existsSync(path)) {
      log.debug({ path }, "state-snapshot: no snapshot to restore");
      return 0;
    }
    raw = readFileSync(path, "utf8");
  } catch (err) {
    log.warn(
      { path, err: err instanceof Error ? err.message : String(err) },
      "state-snapshot: read failed (starting with empty state)",
    );
    return 0;
  }

  let envelope: SnapshotEnvelope;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      typeof (parsed as SnapshotEnvelope).sources !== "object" ||
      (parsed as SnapshotEnvelope).sources === null
    ) {
      throw new Error("malformed envelope");
    }
    envelope = parsed as SnapshotEnvelope;
  } catch (err) {
    log.warn(
      { path, err: err instanceof Error ? err.message : String(err) },
      "state-snapshot: corrupt snapshot (starting with empty state)",
    );
    return 0;
  }

  if (envelope.version !== SNAPSHOT_VERSION) {
    log.warn(
      { path, found: envelope.version, expected: SNAPSHOT_VERSION },
      "state-snapshot: version mismatch (ignoring snapshot)",
    );
    return 0;
  }

  let restored = 0;
  for (const [name, source] of registry) {
    if (!(name in envelope.sources)) continue;
    try {
      source.deserialize(envelope.sources[name]);
      restored++;
    } catch (err) {
      log.warn(
        { name, err: err instanceof Error ? err.message : String(err) },
        "state-snapshot: source deserialize failed (skipping source)",
      );
    }
  }
  // Prime the content-diff baseline so an unchanged first flush is a no-op.
  lastWrittenJson = JSON.stringify(serializeSources());
  log.info({ path, restored, registered: registry.size }, "state-snapshot: restored");
  return restored;
}

/**
 * Serialize all sources, and if the content changed since the last write,
 * atomically persist it (write to `.tmp` then rename). Returns true if a write
 * actually happened, false when skipped as a no-op. `force` bypasses the
 * content-diff (used by the shutdown flush).
 */
export function flushSnapshot(path: string = snapshotFilePath(), force = false): boolean {
  const sources = serializeSources();
  const sourcesJson = JSON.stringify(sources);
  if (!force && sourcesJson === lastWrittenJson) return false;

  const envelope: SnapshotEnvelope = {
    version: SNAPSHOT_VERSION,
    savedAt: new Date().toISOString(),
    sources,
  };

  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(envelope), "utf8");
    renameSync(tmp, path);
    lastWrittenJson = sourcesJson;
    return true;
  } catch (err) {
    log.warn(
      { path, err: err instanceof Error ? err.message : String(err) },
      "state-snapshot: flush failed (state kept in memory)",
    );
    return false;
  }
}

/**
 * Start the periodic snapshot flusher. Returns a stop function that also does a
 * final forced flush, so a graceful shutdown (SIGTERM) persists the freshest
 * state. The interval is `unref`'d so it never keeps the event loop alive on
 * its own.
 */
export function startStateSnapshot(opts?: {
  intervalMs?: number;
  path?: string;
}): () => void {
  const intervalMs = opts?.intervalMs ?? DEFAULT_SNAPSHOT_INTERVAL_MS;
  const path = opts?.path ?? snapshotFilePath();

  const timer = setInterval(() => {
    flushSnapshot(path);
  }, intervalMs);
  if (typeof timer === "object" && timer && "unref" in timer) {
    (timer as { unref: () => void }).unref();
  }

  log.info({ intervalMs, path }, "state-snapshot: periodic flusher started");

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    // Final flush on shutdown — force it so the last mutations always land.
    flushSnapshot(path, true);
  };
}

/**
 * Test-only: clear the registry and content-diff baseline so cases don't leak
 * registered sources across files in the same process.
 */
export function __resetSnapshotForTests(): void {
  registry.clear();
  lastWrittenJson = null;
}
