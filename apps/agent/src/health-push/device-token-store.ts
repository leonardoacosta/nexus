// device-token-store.ts — durable, file-backed store of registered APNs device
// tokens. Mirrors cc-credential-manager's atomic-JSON-write precedent rather than
// adding a Drizzle table (a single-user homelab has a handful of devices; a
// migration would be over-engineering). Tokens persist across agent restarts so
// the health-push scheduler keeps a target after a reboot.

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createLogger } from "@nexus/core/node";

const log = createLogger("agent:health-push:tokens");

export interface DeviceToken {
  token: string;
  platform: string; // "ios"
  bundleId: string;
  updatedAt: string; // ISO
}

function storePath(): string {
  return (
    process.env.HEALTH_PUSH_TOKEN_PATH ??
    join(homedir(), ".nexus", "apns-device-tokens.json")
  );
}

export class DeviceTokenStore {
  private readonly path: string;
  private tokens = new Map<string, DeviceToken>();
  private loaded = false;

  constructor(path: string = storePath()) {
    this.path = path;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await fs.readFile(this.path, "utf8");
      const arr = JSON.parse(raw) as DeviceToken[];
      for (const t of arr) this.tokens.set(t.token, t);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        log.warn(`could not read token store: ${(e as Error).message}`);
      }
    }
    this.loaded = true;
  }

  /** Atomic write (tmp + rename), same safety as cc-credential-manager. */
  private async persist(): Promise<void> {
    const dir = dirname(this.path);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${this.path}.tmp`;
    await fs.writeFile(tmp, JSON.stringify([...this.tokens.values()], null, 2), {
      mode: 0o600,
    });
    await fs.rename(tmp, this.path);
  }

  /** Upsert a device token (idempotent on the token string). */
  async register(t: Omit<DeviceToken, "updatedAt">): Promise<void> {
    await this.ensureLoaded();
    this.tokens.set(t.token, { ...t, updatedAt: new Date().toISOString() });
    await this.persist();
    log.info(`registered device token (${this.tokens.size} total)`);
  }

  /** Drop a dead token (APNs 410 Unregistered / BadDeviceToken). */
  async remove(token: string): Promise<void> {
    await this.ensureLoaded();
    if (this.tokens.delete(token)) await this.persist();
  }

  async all(): Promise<DeviceToken[]> {
    await this.ensureLoaded();
    return [...this.tokens.values()];
  }
}

let _store: DeviceTokenStore | null = null;
export function getDeviceTokenStore(): DeviceTokenStore {
  if (!_store) _store = new DeviceTokenStore();
  return _store;
}
