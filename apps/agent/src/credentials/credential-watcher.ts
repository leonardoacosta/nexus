import { watch, readFile, readdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { logger } from "@nexus/core";
import type { CredentialPool } from "./pool";
import {
  computeCredentialFingerprint,
  CredentialParseError,
} from "./credentials.helpers";
import { randomUUID } from "node:crypto";

const DEBOUNCE_MS = 200;
const CRED_DIR = join(process.env.HOME ?? "", ".config/nexus/credentials");

/**
 * Watch the credential directory for file changes.
 * - New acct-*.json -> pool.add()
 * - Changed acct-*.json -> pool.refreshMetadata() for that file
 * - Deleted -> log warning, do not remove DB rows
 *
 * Returns an AbortController to stop watching.
 */
export function startCredentialWatcher(pool: CredentialPool): AbortController {
  const ac = new AbortController();

  // Debounce map: filename -> timeout handle
  const pending = new Map<string, ReturnType<typeof setTimeout>>();

  async function handleFileEvent(filename: string) {
    if (!filename.startsWith("acct-") || !filename.endsWith(".json")) return;

    const filePath = join(CRED_DIR, filename);

    try {
      const plaintext = await readFile(filePath, "utf-8");
      // Validate JSON structure
      JSON.parse(plaintext);

      // Validate credential shape via fingerprint computation.
      // If parsing fails the file is not a valid credential -- skip it.
      let fingerprint: string;
      try {
        fingerprint = computeCredentialFingerprint(plaintext);
      } catch (err) {
        if (err instanceof CredentialParseError) {
          logger.warn(
            { file: filename, error: err.message },
            "credential watcher: invalid credential file",
          );
          return;
        }
        throw err;
      }

      // Attempt to add as a new credential. If the fingerprint already
      // exists (duplicate / unique constraint), fall back to a metadata
      // refresh so updated token expiry etc. are picked up.
      try {
        await pool.add({
          id: randomUUID(),
          name: basename(filename, ".json"),
          type: "oauth",
          value_plaintext: plaintext,
        });
        logger.info(
          { file: filename, fingerprint: fingerprint.slice(0, 8) },
          "credential watcher: new credential imported",
        );
      } catch (err) {
        // Duplicate fingerprint -> just refresh metadata
        if (
          err instanceof Error &&
          (err.message.includes("duplicate") || err.message.includes("unique"))
        ) {
          await pool.refreshMetadata();
          logger.info(
            { file: filename },
            "credential watcher: metadata refreshed for existing credential",
          );
        } else {
          throw err;
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // File was deleted
        logger.warn(
          { file: filename },
          "credential watcher: file deleted -- DB row retained",
        );
        return;
      }
      logger.warn(
        {
          file: filename,
          error: err instanceof Error ? err.message : String(err),
        },
        "credential watcher: failed to process file event",
      );
    }
  }

  (async () => {
    try {
      // Verify directory exists before starting the watcher
      await readdir(CRED_DIR);

      logger.info({ dir: CRED_DIR }, "credential watcher started");

      const watcher = watch(CRED_DIR, { signal: ac.signal });
      for await (const event of watcher) {
        const filename = event.filename;
        if (!filename) continue;

        // Debounce: clear any existing timeout for this file, set a new one
        const existing = pending.get(filename);
        if (existing) clearTimeout(existing);

        pending.set(
          filename,
          setTimeout(() => {
            pending.delete(filename);
            handleFileEvent(filename).catch((err) => {
              logger.warn(
                {
                  file: filename,
                  error: err instanceof Error ? err.message : String(err),
                },
                "credential watcher: unhandled error in file handler",
              );
            });
          }, DEBOUNCE_MS),
        );
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        logger.info("credential watcher stopped");
        return;
      }
      logger.warn(
        { error: err instanceof Error ? err.message : String(err) },
        "credential watcher: failed to start -- directory may not exist",
      );
    }
  })();

  return ac;
}
