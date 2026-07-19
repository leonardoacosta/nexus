/**
 * Telegram channel transport (add-mx-credential-autorefresh).
 *
 * Extracted from `router.ts` by `extract-notification-channels` (GOD-04). A
 * general-purpose, low-priority message lane delivered to a configured Telegram
 * chat via the Bot API. Behavior is unchanged — same credential precedence,
 * same fail-open degradation, same re-query-per-dispatch (no cache). The
 * inline DB-row -> load-key -> decrypt -> warn-fallback block is now the shared
 * `decryptStoredCredential` resolver from `./tts`.
 */

import { createLogger, getAgentId } from "@nexus/core/node";
import { fetchWithTimeout } from "@nexus/core";
// integration_credentials is not re-exported from the top-level @nexus/db
// barrel yet (elevenlabs is, right beside it) — pull it from the first-class
// `@nexus/db/schema` public subpath, the same module createDb loads, so the
// table object matches the one backing db.query.integrationCredentials.
import { integrationCredentials } from "@nexus/db/schema";
import { and, eq } from "drizzle-orm";
import type { NotificationRow } from "../buffer";
import {
  getChannelDbHandle,
  decryptStoredCredential,
  type ChannelResult,
} from "./tts";

const log = createLogger("agent:notifications:channels:telegram");

/**
 * Telegram channel handler — a general-purpose, low-priority message lane
 * delivered to a configured Telegram chat via the Bot API.
 *
 * Credential precedence (add-integration-registry) — resolved fresh on EVERY
 * dispatch (NO in-memory cache) so a dashboard save rotates the secret without
 * an agent restart:
 *   1. Encrypted `integration_credentials` row for `provider="telegram"` on
 *      this agent — bot token = `decrypt(value_encrypted)`, chat id =
 *      `metadata.chatId`. Used only when the row yields BOTH.
 *   2. `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` env vars (legacy / unmigrated
 *      agents). A DB miss, decrypt failure, absent encryption key, or missing
 *      `chatId` metadata falls through here.
 *
 * FAIL-OPEN (mirrors `sendTtsNotification`'s discipline): this handler NEVER
 * returns `success: false` and NEVER logs at error level. Every path returns
 * `{ success: true }` so an unprovisioned or erroring Telegram lane never
 * marks the notification failed and never spams the error log during a
 * Bot-API outage:
 *
 *   - neither DB row nor env provisioned → `{ success: true }` (signal-only
 *     no-op). Info log.
 *   - Bot API non-2xx → `{ success: true }` (degrade to no-op). Warn log.
 *   - network timeout / throw → `{ success: true }` (no-op). Warn log.
 */
export async function sendTelegramNotification(
  notification: NotificationRow,
): Promise<ChannelResult> {
  let token: string | undefined;
  let chatId: string | undefined;

  // DB-first: prefer the encrypted integration_credentials row for this agent.
  // Reuses the shared router DB handle (installed at boot via setTtsDbHandle);
  // when it's null the block is skipped and we fall through to env — identical
  // to the pre-registry behavior. Re-queried + re-decrypted per dispatch (no
  // cache) so a rotated secret takes effect on the very next notification.
  const db = getChannelDbHandle();
  if (db) {
    try {
      const row = await db.query.integrationCredentials.findFirst({
        where: and(
          eq(integrationCredentials.agentId, getAgentId()),
          eq(integrationCredentials.provider, "telegram"),
        ),
      });
      if (row?.valueEncrypted) {
        const decrypted = decryptStoredCredential(
          row.valueEncrypted,
          log,
          "telegram: decrypt of stored bot token failed — falling back to env",
        );
        if (decrypted !== null) {
          const meta = row.metadata;
          const metaChatId =
            typeof meta === "object" && meta !== null && "chatId" in meta
              ? (meta as { chatId?: unknown }).chatId
              : undefined;
          if (typeof metaChatId === "string" && metaChatId.length > 0) {
            token = decrypted;
            chatId = metaChatId;
          }
        }
      }
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "telegram: credential lookup failed (non-fatal) — falling back to env",
      );
    }
  }

  // Env fallback (unchanged legacy path) when the DB row did not yield a full
  // token+chatId pair. We only reach here when the DB source is unusable.
  if (!token || !chatId) {
    token = process.env.TELEGRAM_BOT_TOKEN;
    chatId = process.env.TELEGRAM_CHAT_ID;
  }

  if (!token || token.length === 0 || !chatId || chatId.length === 0) {
    log.info(
      { notificationId: notification.id },
      "telegram: TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID unset — accepting request, no-op delivery (fail-open)",
    );
    return { success: true };
  }

  try {
    const res = await fetchWithTimeout(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        timeout: 8_000,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: notification.body }),
      },
    );
    if (!res.ok) {
      log.warn(
        { notificationId: notification.id, status: res.status },
        "telegram: sendMessage returned non-2xx — degrading to no-op (fail-open)",
      );
      return { success: true };
    }
    return { success: true };
  } catch (err) {
    log.warn(
      {
        notificationId: notification.id,
        err: err instanceof Error ? err.message : String(err),
      },
      "telegram: delivery threw (timeout/network) — degrading to no-op (fail-open)",
    );
    return { success: true };
  }
}
