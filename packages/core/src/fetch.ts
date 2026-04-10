/**
 * Timeout-aware fetch wrapper.
 *
 * Wraps the global `fetch()` with an `AbortController` that fires after
 * `timeout` milliseconds (default 10 000). If the caller already supplies
 * a `signal` in the init options, the two signals are linked — either the
 * caller's abort or the timeout will cancel the request.
 *
 * Works in both Bun and Node.js (>=18) runtimes.
 */

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * A `fetch()` drop-in that aborts after a configurable timeout.
 *
 * @param input  - URL string, URL object, or Request
 * @param init   - Standard RequestInit plus an optional `timeout` (ms)
 * @returns The fetch Response
 *
 * @throws {Error} "Request timed out after <N>ms" when the timeout fires
 * @throws {Error} Re-throws the caller's AbortError if their signal fires first
 *
 * @example
 *   const res = await fetchWithTimeout("https://example.com/api", {
 *     timeout: 5000,
 *     headers: { Authorization: "Bearer ..." },
 *   });
 */
export async function fetchWithTimeout(
  input: string | URL | Request,
  init?: RequestInit & { timeout?: number },
): Promise<Response> {
  const { timeout = DEFAULT_TIMEOUT_MS, signal: callerSignal, ...rest } = init ?? {};

  const controller = new AbortController();

  // If the caller already provided a signal, forward its abort to our controller.
  // This ensures cancellation works from either source.
  let onCallerAbort: (() => void) | undefined;
  if (callerSignal) {
    // Already aborted before we even start — bail immediately.
    if (callerSignal.aborted) {
      controller.abort(callerSignal.reason);
    } else {
      onCallerAbort = () => controller.abort(callerSignal.reason);
      callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }
  }

  const timer = setTimeout(() => {
    controller.abort(new Error(`Request timed out after ${timeout}ms`));
  }, timeout);

  try {
    // audit-scan: E7 false positive — this IS fetchWithTimeout's implementation
    const response = await fetch(input, { ...rest, signal: controller.signal });
    return response;
  } catch (err: unknown) {
    // Surface a human-readable message when the timeout fired.
    // AbortController wraps the reason in a DOMException / AbortError in some
    // runtimes, so we unwrap to find our original Error.
    if (controller.signal.aborted) {
      const reason = controller.signal.reason;
      // Our timeout error — throw it directly for a clear stack trace.
      if (reason instanceof Error && reason.message.startsWith("Request timed out")) {
        throw reason;
      }
      // Caller's signal fired — re-throw the original error unchanged.
      if (reason instanceof Error) {
        throw reason;
      }
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (callerSignal && onCallerAbort) {
      callerSignal.removeEventListener("abort", onCallerAbort);
    }
  }
}
