/**
 * Read-only VictoriaMetrics client.
 *
 * Spec: openspec/changes/read-cc-telemetry-from-influxdb (cc-telemetry-read)
 *
 * Queries the PromQL-compatible HTTP API (`/api/v1/query`) exposed by the
 * homelab VictoriaMetrics container. Nexus is a READER of the shared homelab
 * observability store — this client exposes ONLY query operations; there is no
 * write / remote-write path.
 *
 * Configuration:
 *   - `VM_URL` (env) — base URL of the VM instance. The deploy default is
 *     `http://172.20.0.200:8428` (see deploy/secrets.env.example); the compose
 *     file pins that as a static ipv4_address so the IP is stable.
 *   - When `VM_URL` is unset/empty the client is DISABLED: every query returns
 *     an empty result and the agent runs normally without it. No fallback IP is
 *     hardcoded — a genuinely unconfigured environment (CI, local dev) must
 *     degrade, not silently reach for the homelab IP.
 *
 * Any transport failure (VM unreachable, timeout, non-2xx, unparseable body)
 * degrades to an empty result and is logged, never thrown.
 */

import { createLogger } from "@nexus/core/node";
import { fetchWithTimeout } from "@nexus/core/fetch";

const log = createLogger("agent:telemetry:vm-read");

const DEFAULT_QUERY_TIMEOUT_MS = 5_000;

/** A single instant-vector sample: its label set plus scalar value. */
export interface VmSample {
  metric: Record<string, string>;
  value: number;
}

export interface VmReadClient {
  /** True when `VM_URL` is configured. When false, `query` always returns []. */
  readonly enabled: boolean;
  /** Run an instant PromQL query. Returns [] on disabled/error (never throws). */
  query(promql: string): Promise<VmSample[]>;
}

export interface VmReadClientOpts {
  /** Base URL override (tests). Falls back to `process.env.VM_URL`. */
  url?: string;
  /** Per-query timeout. */
  timeoutMs?: number;
  /** fetch override (tests). */
  fetchImpl?: typeof fetchWithTimeout;
}

/** Shape of the VictoriaMetrics `/api/v1/query` success response. */
interface VmQueryResponse {
  status: string;
  data?: {
    resultType?: string;
    result?: Array<{ metric?: Record<string, string>; value?: [number, string] }>;
  };
}

function parseSamples(body: unknown): VmSample[] {
  const resp = body as VmQueryResponse | null;
  if (!resp || resp.status !== "success" || !resp.data?.result) return [];
  const out: VmSample[] = [];
  for (const series of resp.data.result) {
    const raw = series.value?.[1];
    const value = raw != null ? Number.parseFloat(raw) : NaN;
    if (!Number.isFinite(value)) continue;
    out.push({ metric: series.metric ?? {}, value });
  }
  return out;
}

export function createVmReadClient(opts: VmReadClientOpts = {}): VmReadClient {
  const base = (opts.url ?? process.env.VM_URL ?? "").trim().replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
  const doFetch = opts.fetchImpl ?? fetchWithTimeout;
  const enabled = base.length > 0;

  if (!enabled) {
    log.debug("VM_URL unset — VictoriaMetrics read client disabled (empty results)");
  }

  return {
    enabled,
    async query(promql: string): Promise<VmSample[]> {
      if (!enabled) return [];
      const url = `${base}/api/v1/query?query=${encodeURIComponent(promql)}`;
      try {
        const res = await doFetch(url, { timeout: timeoutMs });
        if (!res.ok) {
          log.debug({ status: res.status, promql }, "VM query returned non-2xx");
          return [];
        }
        const body = (await res.json()) as unknown;
        return parseSamples(body);
      } catch (err) {
        log.debug(
          { err: err instanceof Error ? err.message : String(err), promql },
          "VM query failed — degrading to empty result",
        );
        return [];
      }
    },
  };
}
