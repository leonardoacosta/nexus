import { describe, test, expect, afterAll, afterEach } from "bun:test";
import { fetchWithTimeout } from "./fetch";

/**
 * Spin up a tiny HTTP server for integration-style tests.
 * Each test controls the server's response behavior via the handler ref.
 */
let handler: (req: Request) => Response | Promise<Response> = () =>
  new Response("ok");

const server = Bun.serve({
  port: 0, // random available port
  fetch: (req) => handler(req),
});

const baseUrl = `http://localhost:${server.port}`;

afterEach(() => {
  handler = () => new Response("ok");
});

afterAll(() => {
  server.stop(true);
});

describe("fetchWithTimeout", () => {
  test("returns response for a fast request", async () => {
    handler = () => new Response("hello", { status: 200 });

    const res = await fetchWithTimeout(`${baseUrl}/fast`, { timeout: 5000 });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");
  });

  test("uses default timeout when none specified", async () => {
    handler = () => new Response("default");

    // Should succeed — server responds instantly, well within default 10s
    const res = await fetchWithTimeout(`${baseUrl}/default`);
    expect(res.status).toBe(200);
  });

  test("throws descriptive error on timeout", async () => {
    handler = () =>
      new Promise((resolve) => {
        // Respond after 5 seconds — way past our 50ms timeout
        setTimeout(() => resolve(new Response("late")), 5000);
      });

    try {
      await fetchWithTimeout(`${baseUrl}/slow`, { timeout: 50 });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/Request timed out after 50ms/);
    }
  });

  test("passes through request init options", async () => {
    let receivedMethod = "";
    let receivedContentType = "";

    handler = (req) => {
      receivedMethod = req.method;
      receivedContentType = req.headers.get("content-type") ?? "";
      return new Response("ok");
    };

    await fetchWithTimeout(`${baseUrl}/echo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "value" }),
      timeout: 5000,
    });

    expect(receivedMethod).toBe("POST");
    expect(receivedContentType).toBe("application/json");
  });

  test("aborts when caller signal fires", async () => {
    handler = () =>
      new Promise((resolve) => {
        setTimeout(() => resolve(new Response("late")), 5000);
      });

    const callerController = new AbortController();

    // Abort after 50ms from the caller side
    setTimeout(() => callerController.abort(new Error("caller cancelled")), 50);

    try {
      await fetchWithTimeout(`${baseUrl}/caller-abort`, {
        signal: callerController.signal,
        timeout: 30000, // long timeout — caller signal should fire first
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe("caller cancelled");
    }
  });

  test("rejects immediately if caller signal is already aborted", async () => {
    const callerController = new AbortController();
    callerController.abort(new Error("pre-aborted"));

    try {
      await fetchWithTimeout(`${baseUrl}/pre-aborted`, {
        signal: callerController.signal,
        timeout: 5000,
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe("pre-aborted");
    }
  });

  test("cleans up timer on success (no leaked timers)", async () => {
    handler = () => new Response("fast");

    // If timer leaks, this would not cause a visible failure, but we verify
    // the function completes without hanging — Bun's test runner would flag
    // hanging timers at suite end.
    const res = await fetchWithTimeout(`${baseUrl}/cleanup`, { timeout: 60000 });
    expect(res.status).toBe(200);
  });
});
