// health-push-scheduler.ts — periodically sends a silent "health-flush" APNs push
// to every registered device, guaranteeing a wake cadence the on-device iOS
// schedulers (best-effort, throttled) cannot. Clones the HealthScheduler
// setInterval lifecycle. Inert (no-op) when no APNs key or no registered tokens.

import { createLogger } from "@nexus/core/node";
import { getApnsSender } from "./apns-sender";
import { getDeviceTokenStore } from "./device-token-store";

const log = createLogger("agent:health-push:scheduler");

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000; // 30 min

export class HealthPushScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly intervalMs: number;
  private running = false;

  constructor(intervalMs?: number) {
    const env = Number(process.env.HEALTH_PUSH_INTERVAL_MS);
    this.intervalMs = intervalMs ?? (Number.isFinite(env) && env > 0 ? env : DEFAULT_INTERVAL_MS);
  }

  start(): void {
    if (this.timer) return;
    const sender = getApnsSender();
    if (!sender) {
      log.warn("no APNs sender (key missing) — health-push scheduler not started");
      return;
    }
    log.info(`health-push scheduler started (every ${Math.round(this.intervalMs / 60000)}m)`);
    // First tick after one interval — the app already flushes on launch, so an
    // immediate push would be redundant.
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One round: push to every registered token, prune dead ones. */
  async tick(): Promise<void> {
    if (this.running) return; // skip if a slow round is still in flight
    this.running = true;
    try {
      const sender = getApnsSender();
      if (!sender) return;
      const store = getDeviceTokenStore();
      const tokens = await store.all();
      if (tokens.length === 0) return;

      let ok = 0;
      for (const t of tokens) {
        const { status, reason } = await sender.sendHealthFlush(t.token);
        if (status === 200) {
          ok++;
        } else if (status === 410 || reason === "BadDeviceToken" || reason === "Unregistered") {
          await store.remove(t.token);
          log.info(`pruned dead token (status=${status} reason=${reason})`);
        } else {
          log.warn(`push failed (status=${status} reason=${reason ?? "?"})`);
        }
      }
      if (ok > 0) log.info(`health-flush push sent to ${ok}/${tokens.length} device(s)`);
    } catch (e) {
      log.warn(`health-push tick error: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}

let _scheduler: HealthPushScheduler | null = null;
export function getHealthPushScheduler(): HealthPushScheduler {
  if (!_scheduler) _scheduler = new HealthPushScheduler();
  return _scheduler;
}
