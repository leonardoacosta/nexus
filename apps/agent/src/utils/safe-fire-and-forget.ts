import { logger } from "@nexus/core/node";

/**
 * Wrap a fire-and-forget promise so that rejections are logged instead of
 * becoming unhandled rejections.
 *
 * Prefer `await` when the caller can handle the result. Use this utility
 * only for genuinely fire-and-forget scenarios (timers, background cleanup,
 * process-exit watchers, etc.).
 */
export function safeFireAndForget(
  promise: Promise<unknown>,
  context: string,
): void {
  promise.catch((err: unknown) => {
    logger.warn({ err, context }, "fire-and-forget promise rejected");
  });
}
