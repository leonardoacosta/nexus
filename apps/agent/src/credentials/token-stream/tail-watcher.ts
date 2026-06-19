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

  /**
   * @param onApiError Optional callback invoked once per detected api-error
   *   transcript line (add-api-error-notification, nx-ldcbt). Separate from
   *   `onTurns` because an api-error line carries no `usage` block — `parseLine`
   *   correctly returns null for it, so usage-turn extraction is untouched. The
   *   lifecycle wires this to post a `notification` socket event with
   *   `reason: "api_error"` (nx-9cz4h). Omitted in token-only contexts (tests,
   *   analytics-only watchers) — detection then no-ops.
   */
  constructor(
    private path: string,
    private byteOffset: number,
    private onTurns: (turns: ParsedTurn[], newByteOffset: number) => Promise<void>,
    private onApiError?: (text: string) => Promise<void>,
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
      const apiErrors: string[] = [];
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
            if (turn) {
              turns.push(turn);
              continue;
            }
            // Separate detection branch (nx-ldcbt): an api-error line has no
            // `usage` block, so `parseLine` returned null above. Only probe the
            // lines `parseLine` rejected — usage-turn extraction stays intact.
            if (this.onApiError) {
              const text = this.parseApiError(line);
              if (text !== null) apiErrors.push(text);
            }
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

        // Fire the api-error callback alongside `onTurns` (nx-ldcbt). One
        // invocation per detected line; the trigger orchestrator's per-session
        // suppression (nx-avasg) collapses a 529 burst to a single delivery.
        if (this.onApiError && apiErrors.length > 0) {
          for (const text of apiErrors) {
            try {
              await this.onApiError(text);
            } catch (err) {
              log.warn(
                { path: this.path, err },
                "onApiError callback threw — continuing",
              );
            }
          }
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

  /**
   * Detect an api-error transcript line and extract its error text
   * (add-api-error-notification, nx-ldcbt). Returns the error string when the
   * line is an api-error, or `null` otherwise.
   *
   * Recognised shapes (verified against real `~/.claude/projects/` transcripts):
   *   - `isApiErrorMessage: true` flag at the top level or under `message`.
   *   - Text content matching `^API Error:` at the top level (`content`/`text`)
   *     or inside `message.content` (string, or an array of `{type:"text",text}`
   *     blocks).
   *
   * Only called for lines `parseLine` already rejected (no `usage` block), so
   * it never competes with usage-turn extraction.
   */
  private parseApiError(line: string): string | null {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      const message = (obj.message ?? {}) as Record<string, unknown>;

      const flagged =
        obj.isApiErrorMessage === true || message.isApiErrorMessage === true;

      const text = extractTextContent(obj, message);

      if (flagged) {
        // Honour the explicit flag even if the text doesn't match the prefix.
        return text ?? "";
      }
      if (text !== null && /^API Error:/i.test(text)) {
        return text;
      }
      return null;
    } catch {
      // Malformed JSON line — skip silently (already counted as non-turn).
      return null;
    }
  }
}

/**
 * Pull a flat text string out of a transcript line for api-error matching.
 * Tries top-level `content`/`text`, then `message.content` as either a string
 * or an array of `{type:"text", text}` blocks (the CC assistant-message shape).
 * Returns the first non-empty string found, or `null`.
 */
function extractTextContent(
  obj: Record<string, unknown>,
  message: Record<string, unknown>,
): string | null {
  const direct = obj.content ?? obj.text;
  if (typeof direct === "string" && direct.length > 0) return direct;

  const msgContent = message.content;
  if (typeof msgContent === "string" && msgContent.length > 0) return msgContent;

  if (Array.isArray(msgContent)) {
    for (const block of msgContent) {
      if (
        block &&
        typeof block === "object" &&
        typeof (block as Record<string, unknown>).text === "string"
      ) {
        const t = (block as Record<string, unknown>).text as string;
        if (t.length > 0) return t;
      }
    }
  }
  return null;
}
