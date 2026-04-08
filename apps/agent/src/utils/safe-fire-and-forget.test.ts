import { describe, expect, it, mock, beforeEach } from "bun:test";

// ── Mock @nexus/core logger before importing the utility ──────────────────────

const loggerMock = {
  warn: mock(() => {}),
  info: mock(() => {}),
  error: mock(() => {}),
  debug: mock(() => {}),
  child: mock(() => loggerMock),
};

mock.module("@nexus/core", () => ({
  logger: loggerMock,
  createLogger: () => loggerMock,
}));

const { safeFireAndForget } = await import("./safe-fire-and-forget");

describe("safeFireAndForget", () => {
  beforeEach(() => {
    loggerMock.warn.mockReset();
  });

  it("does not log when the promise resolves", async () => {
    safeFireAndForget(Promise.resolve("ok"), "test-resolve");

    // Give microtask queue time to settle
    await new Promise((r) => setTimeout(r, 10));

    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it("logs a warning with context when the promise rejects", async () => {
    const error = new Error("boom");
    safeFireAndForget(Promise.reject(error), "test-reject");

    // Give microtask queue time to settle
    await new Promise((r) => setTimeout(r, 10));

    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
    const [logObj, logMsg] = loggerMock.warn.mock.calls[0] as [
      { err: unknown; context: string },
      string,
    ];
    expect(logObj.err).toBe(error);
    expect(logObj.context).toBe("test-reject");
    expect(logMsg).toBe("fire-and-forget promise rejected");
  });

  it("does not emit an unhandled rejection", async () => {
    let unhandled = false;
    const handler = () => {
      unhandled = true;
    };
    process.on("unhandledRejection", handler);

    safeFireAndForget(Promise.reject(new Error("silent")), "test-no-unhandled");

    // Wait long enough for unhandledRejection to fire if it were going to
    await new Promise((r) => setTimeout(r, 50));

    process.removeListener("unhandledRejection", handler);
    expect(unhandled).toBe(false);
  });
});
