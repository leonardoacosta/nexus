/**
 * Tail Watcher
 *
 * Incrementally tails a Claude Code transcript JSONL file from a given byte
 * offset, parsing each complete line for token usage data. After the initial
 * read, subscribes to fs.watch for subsequent append events and re-enters the
 * read loop from the current byte position on each change signal.
 */

import { createReadStream, watch, type FSWatcher } from "node:fs";
import { createLogger } from "@nexus/core/node";

const log = createLogger("agent:token-stream:tail");

// ---------------------------------------------------------------------------
// Parsed turn shape
// ---------------------------------------------------------------------------

export interface ParsedTurn {
  ts: Date;
  model: string;
  serviceTier: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

// ---------------------------------------------------------------------------
// TailWatcher
// ---------------------------------------------------------------------------

export class TailWatcher {
  private currentOffset: number;
  private watcher: FSWatcher | null = null;
  private reading = false;
  private stopped = false;

  constructor(
    private path: string,
    private byteOffset: number,
    private onTurns: (turns: ParsedTurn[], newByteOffset: number) => Promise<void>,
  ) {
    this.currentOffset = byteOffset;
  }

  /**
   * Perform the initial read from the stored offset, then subscribe to
   * fs.watch for subsequent appends.
   */
  async start(): Promise<void> {
    await this.readFromOffset();

    // Subscribe to fs.watch for subsequent changes (task 3.3)
    this.watcher = watch(this.path, async (eventType) => {
      if (this.stopped) return;
      if (eventType === "change") {
        await this.readFromOffset();
      }
    });

    this.watcher.on("error", (err) => {
      if (this.stopped) return;
      log.warn({ path: this.path, err }, "fs.watch error on transcript");
    });
  }

  /** Stop tailing, close the file watcher. */
  stop(): void {
    this.stopped = true;
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  /** Current byte position in the file. */
  get offset(): number {
    return this.currentOffset;
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  /**
   * Read new bytes from `this.currentOffset`, parse complete JSONL lines,
   * and emit parsed turns to the callback.
   */
  private async readFromOffset(): Promise<void> {
    // Guard against re-entrant reads (fs.watch can fire rapidly)
    if (this.reading || this.stopped) return;
    this.reading = true;

    try {
      const turns: ParsedTurn[] = [];
      let buffer = "";
      let bytesRead = 0;

      await new Promise<void>((resolve, reject) => {
        const stream = createReadStream(this.path, {
          start: this.currentOffset,
          encoding: "utf-8",
        });

        stream.on("data", (chunk: string | Buffer) => {
          const str = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
          bytesRead += Buffer.byteLength(str, "utf-8");
          buffer += str;

          // Split on newlines, holding the last incomplete chunk
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.trim()) continue;
            const turn = this.parseLine(line);
            if (turn) turns.push(turn);
          }
        });

        stream.on("end", () => {
          // Any remaining incomplete line stays in buffer — we'll pick it
          // up on the next read. Adjust bytesRead to exclude the incomplete
          // chunk so we re-read it next time.
          if (buffer.length > 0) {
            bytesRead -= Buffer.byteLength(buffer, "utf-8");
          }
          resolve();
        });

        stream.on("error", (err) => {
          reject(err);
        });
      });

      if (bytesRead > 0) {
        const newOffset = this.currentOffset + bytesRead;

        if (turns.length > 0) {
          await this.onTurns(turns, newOffset);
        }

        this.currentOffset = newOffset;
      }
    } catch (err) {
      log.error({ path: this.path, err }, "error reading transcript");
    } finally {
      this.reading = false;
    }
  }

  /**
   * Parse a single JSONL line and extract turn data.
   *
   * The JSONL line structure varies — usage may appear under
   * `message.usage` or `usage` at the top level. We look for either
   * and skip lines without usage data.
   *
   * (Task 3.2: extraction logic)
   */
  private parseLine(line: string): ParsedTurn | null {
    try {
      const obj = JSON.parse(line);

      // Extract usage — try `message.usage` first, then top-level `usage`
      const usage = obj?.message?.usage ?? obj?.usage;
      if (!usage) return null;

      // Require at least input or output tokens to consider this a valid turn
      const inputTokens = usage.input_tokens ?? 0;
      const outputTokens = usage.output_tokens ?? 0;
      if (inputTokens === 0 && outputTokens === 0) return null;

      // Extract timestamp — try `timestamp`, `message.timestamp`, `ts`
      const rawTs = obj?.timestamp ?? obj?.message?.timestamp ?? obj?.ts;
      const ts = rawTs ? new Date(rawTs) : new Date();

      // Extract model — try `message.model`, `model`
      const model: string = obj?.message?.model ?? obj?.model ?? "unknown";

      // Extract service tier
      const serviceTier: string | null =
        usage.service_tier ?? obj?.message?.service_tier ?? null;

      return {
        ts,
        model,
        serviceTier,
        inputTokens,
        outputTokens,
        cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
        cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
      };
    } catch {
      // Malformed JSON line — skip silently
      return null;
    }
  }
}
