import { afterAll, describe, expect, it } from "bun:test";

import { AgentRestClient, pollSessions } from "./agent-rest-client";

// ── Black-hole helper — accepts TCP, never responds ────────────────────────

const blackHole = Bun.listen({
  hostname: "127.0.0.1",
  port: 0,
  socket: {
    open() {},
    data() {},
  },
});
const blackHoleUrl = `http://127.0.0.1:${blackHole.port}`;

afterAll(() => {
  blackHole.stop(true);
});

describe("AgentRestClient.request() default timeout", () => {
  it(
    "listSessions rejects with TimeoutError instead of pending forever",
    async () => {
      const client = new AgentRestClient(blackHoleUrl, 250);
      const start = Date.now();
      let err: unknown;
      try {
        await client.listSessions();
      } catch (e) {
        err = e;
      }
      const elapsed = Date.now() - start;
      expect(err).toBeInstanceOf(DOMException);
      expect((err as DOMException).name).toBe("TimeoutError");
      expect(elapsed).toBeLessThan(5_000);
    },
    10_000,
  );

  it(
    "caller AbortSignal still cancels before the default timeout",
    async () => {
      const client = new AgentRestClient(blackHoleUrl, 10_000);
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 50);
      let err: unknown;
      try {
        await client.listSessions({ signal: controller.signal });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(DOMException);
      expect((err as DOMException).name).toBe("AbortError");
    },
    10_000,
  );

  it(
    "getSession times out on a silent socket",
    async () => {
      const client = new AgentRestClient(blackHoleUrl, 250);
      let err: unknown;
      try {
        await client.getSession("x");
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(DOMException);
      expect((err as DOMException).name).toBe("TimeoutError");
    },
    10_000,
  );

  it(
    "pollSessions surfaces TimeoutError via onError and keeps ticking",
    async () => {
      const client = new AgentRestClient(blackHoleUrl, 100);
      const errors: unknown[] = [];
      const poll = pollSessions(client, () => {}, {
        intervalMs: 50,
        onError: (e) => errors.push(e),
      });

      const deadline = Date.now() + 5_000;
      while (errors.length < 2 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      poll.stop();

      expect(errors.length).toBeGreaterThanOrEqual(2);
      expect((errors[0] as DOMException).name).toBe("TimeoutError");
    },
    10_000,
  );
});

describe("AgentRestClient.request() happy path", () => {
  it(
    "listSessions and startSession still work through request()",
    async () => {
      const srv = Bun.serve({
        port: 0,
        fetch: async (req) => {
          const url = new URL(req.url);
          if (req.method === "GET" && url.pathname.startsWith("/sessions")) {
            return Response.json([]);
          }
          if (req.method === "POST" && url.pathname === "/session/start") {
            const payload = (await req.json()) as { project?: string; path?: string };
            expect(payload.project).toBeDefined();
            expect(payload.path).toBeDefined();
            return Response.json({ session_name: "s", started: true });
          }
          return new Response("not found", { status: 404 });
        },
      });

      try {
        const client = new AgentRestClient(`http://127.0.0.1:${srv.port}`);
        const sessions = await client.listSessions();
        expect(sessions).toEqual([]);

        const result = await client.startSession({ project: "p", path: "/tmp" });
        expect(result.sessionName).toBe("s");
        expect(result.started).toBe(true);
      } finally {
        srv.stop(true);
      }
    },
    10_000,
  );
});
