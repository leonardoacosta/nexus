// apns-sender.ts — sends a silent (background) APNs push to wake the Nexus iOS
// app and trigger a HealthKit flush. This is the homelab side of the "guaranteed
// cadence" health-push path (Wave 2): the on-device schedulers are best-effort,
// so the server pokes the app on its own timer.
//
// APNs speaks HTTP/2 ONLY (HTTP/1.1 gets Malformed_HTTP_Response) and authenticates
// with an ES256 JWT signed by an APNs Auth Key (.p8). The token-based scheme is
// reusable for up to 1h, so we cache the JWT. Verified against api.sandbox.push.apple.com:
// a dummy device token returns 400 BadDeviceToken, proving the key authenticates.

import { readFileSync } from "node:fs";
import { createSign } from "node:crypto";
import { connect } from "node:http2";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@nexus/core/node";

const log = createLogger("agent:health-push:apns");

/** APNs config, resolved from env with homelab-sane defaults. */
export interface ApnsConfig {
  keyPath: string;
  keyId: string;
  teamId: string;
  bundleId: string;
  /** sandbox for development-signed builds, prod for App Store / TestFlight. */
  host: string;
}

export function resolveApnsConfig(): ApnsConfig {
  const keyId = process.env.APNS_KEY_ID ?? "Z3BX2Y72Q7";
  return {
    keyId,
    teamId: process.env.APNS_TEAM_ID ?? "DX3Y367L2A",
    bundleId: process.env.APNS_BUNDLE_ID ?? "dev.leonardoacosta.nexus.ios",
    // dev-signed app => sandbox APNs. Override with APNS_HOST for a prod build.
    host: process.env.APNS_HOST ?? "https://api.sandbox.push.apple.com",
    keyPath:
      process.env.APNS_KEY_PATH ??
      join(homedir(), ".appstoreconnect", "private_keys", `AuthKey_${keyId}.p8`),
  };
}

const b64url = (o: unknown) =>
  Buffer.from(JSON.stringify(o)).toString("base64url");

/** A provider JWT, cached: APNs accepts the same token for up to 1h. */
interface CachedJwt {
  token: string;
  mintedAtSec: number;
}

export class ApnsSender {
  private readonly cfg: ApnsConfig;
  private readonly privateKey: string;
  private jwt: CachedJwt | null = null;

  constructor(cfg: ApnsConfig = resolveApnsConfig()) {
    this.cfg = cfg;
    // Fail fast + loud if the key is missing — the whole path is inert without it.
    this.privateKey = readFileSync(cfg.keyPath, "utf8");
  }

  /** Mint (or reuse, < 50 min old) the ES256 provider token. */
  private providerToken(nowSec: number): string {
    if (this.jwt && nowSec - this.jwt.mintedAtSec < 50 * 60) {
      return this.jwt.token;
    }
    const header = b64url({ alg: "ES256", kid: this.cfg.keyId });
    const claims = b64url({ iss: this.cfg.teamId, iat: nowSec });
    const signer = createSign("SHA256");
    signer.update(`${header}.${claims}`);
    const sig = signer
      .sign({ key: this.privateKey, dsaEncoding: "ieee-p1363" })
      .toString("base64url");
    const token = `${header}.${claims}.${sig}`;
    this.jwt = { token, mintedAtSec: nowSec };
    return token;
  }

  /**
   * Send a background "health-flush" push to one device token. Resolves with the
   * APNs HTTP status + optional reason. A 200 means accepted; 410 means the token
   * is dead (caller should prune it); 400 BadDeviceToken means a malformed token.
   */
  async sendHealthFlush(
    deviceToken: string,
    nowSec: number = Math.floor(Date.now() / 1000),
  ): Promise<{ status: number; reason?: string }> {
    const token = this.providerToken(nowSec);
    const client = connect(this.cfg.host);

    return await new Promise((resolve) => {
      let settled = false;
      const done = (r: { status: number; reason?: string }) => {
        if (settled) return;
        settled = true;
        client.close();
        resolve(r);
      };

      client.on("error", (e) => done({ status: 0, reason: e.message }));

      const req = client.request({
        ":method": "POST",
        ":path": `/3/device/${deviceToken}`,
        authorization: `bearer ${token}`,
        "apns-topic": this.cfg.bundleId,
        "apns-push-type": "background",
        "apns-priority": "5", // background pushes MUST be priority 5
      });

      let status = 0;
      let body = "";
      req.on("response", (h) => {
        status = Number(h[":status"]) || 0;
      });
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        let reason: string | undefined;
        if (body) {
          try {
            reason = (JSON.parse(body) as { reason?: string }).reason;
          } catch {
            reason = body;
          }
        }
        done({ status, reason });
      });

      req.end(
        JSON.stringify({
          aps: { "content-available": 1 },
          nexusKind: "health-flush",
        }),
      );
    });
  }

  /**
   * Send a VISIBLE alert push (lock-screen banner / Notification Center) to one
   * device token. Unlike `sendHealthFlush` (silent/background), this carries an
   * `aps.alert` dictionary so iOS renders it without any app-side handling —
   * the iOS `didReceiveRemoteNotification` no longer needs to recognise it.
   *
   * Critical header differences from the silent path:
   *   - apns-push-type: alert   (not background)
   *   - apns-priority: 10       (deliver immediately; background uses 5)
   *
   * `userInfo` keys are merged into the top-level JSON alongside `aps` so the
   * iOS `NexusAppDelegate` tap router can read `sessionId` / `notificationId`.
   *
   * Resolves with the APNs HTTP status + optional reason — same contract as
   * `sendHealthFlush`. 410 / Unregistered / BadDeviceToken means the caller
   * should prune the token.
   */
  async sendAlert(
    deviceToken: string,
    payload: {
      title: string;
      body: string;
      userInfo?: Record<string, unknown>;
    },
    nowSec: number = Math.floor(Date.now() / 1000),
  ): Promise<{ status: number; reason?: string }> {
    const token = this.providerToken(nowSec);
    const client = connect(this.cfg.host);

    return await new Promise((resolve) => {
      let settled = false;
      const done = (r: { status: number; reason?: string }) => {
        if (settled) return;
        settled = true;
        client.close();
        resolve(r);
      };

      client.on("error", (e) => done({ status: 0, reason: e.message }));

      const req = client.request({
        ":method": "POST",
        ":path": `/3/device/${deviceToken}`,
        authorization: `bearer ${token}`,
        "apns-topic": this.cfg.bundleId,
        "apns-push-type": "alert",
        "apns-priority": "10", // user-visible alerts deliver immediately
      });

      let status = 0;
      let body = "";
      req.on("response", (h) => {
        status = Number(h[":status"]) || 0;
      });
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        let reason: string | undefined;
        if (body) {
          try {
            reason = (JSON.parse(body) as { reason?: string }).reason;
          } catch {
            reason = body;
          }
        }
        done({ status, reason });
      });

      req.end(
        JSON.stringify({
          aps: {
            alert: { title: payload.title, body: payload.body },
            sound: "default",
          },
          ...(payload.userInfo ?? {}),
        }),
      );
    });
  }
}

/** Lazily-built singleton; null when the key file is absent (path inert). */
let _sender: ApnsSender | null = null;
let _tried = false;

export function getApnsSender(): ApnsSender | null {
  if (_tried) return _sender;
  _tried = true;
  try {
    _sender = new ApnsSender();
  } catch (e) {
    log.warn(
      `APNs sender unavailable (key missing?): ${(e as Error).message} — health-push disabled`,
    );
    _sender = null;
  }
  return _sender;
}
