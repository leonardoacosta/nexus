// apns-register.ts — POST /apns/register. The Nexus iOS app's ApnsRegistrar POSTs
// its APNs device token here ({platform, token, bundleId}) after
// registerForRemoteNotifications succeeds. The token is persisted so the
// health-push scheduler can target the device with silent flush pushes.

import { createLogger } from "@nexus/core/node";
import { jsonResponse } from "./credentials/shared";
import { getDeviceTokenStore } from "../health-push/device-token-store";

const log = createLogger("agent:routes:apns-register");

interface RegisterBody {
  platform?: string;
  token?: string;
  bundleId?: string;
}

const HEX_TOKEN = /^[0-9a-fA-F]{64,200}$/;

/** POST /apns/register — store (upsert) an APNs device token. */
export async function handleApnsRegister(request: Request): Promise<Response> {
  let body: RegisterBody;
  try {
    body = (await request.json()) as RegisterBody;
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }

  const token = body.token?.trim();
  if (!token || !HEX_TOKEN.test(token)) {
    return jsonResponse({ error: "missing or malformed device token" }, 400);
  }

  await getDeviceTokenStore().register({
    token,
    platform: body.platform ?? "ios",
    bundleId: body.bundleId ?? "dev.leonardoacosta.nexus.ios",
  });
  log.info(`apns token registered (platform=${body.platform ?? "ios"})`);
  return jsonResponse({ ok: true });
}
