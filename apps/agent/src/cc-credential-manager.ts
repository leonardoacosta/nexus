/**
 * cc-credential-manager — active management of Claude Code's credentials.json.
 *
 * Spec: openspec/changes/add-cc-credential-manager
 *
 * Responsibilities:
 *  1. Read/write `~/.claude/credentials.json` with backup-before-write.
 *  2. Mirror each observed profile into `cc_profiles` with encrypted refresh
 *     tokens.
 *  3. Proactive OAuth refresh 5 minutes before `expiresAt`.
 *  4. Rate-limit-aware swap on 429.
 *  5. Schema-drift detection — emit `CCAuthSchemaDrift` when the on-disk
 *     fingerprint diverges from the supported shape.
 *
 * Active management means the agent owns writes to credentials.json. The
 * Claude CLI re-reads the file on each request, so swap takes effect on the
 * next API call without restarting the session.
 */

import { promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

import type { Db } from "@nexus/db";
import { ccProfiles, ccProfileEvents } from "@nexus/db";
import { eq, lt } from "drizzle-orm";
import { createLogger } from "@nexus/core/node";

import { encrypt, decrypt, loadEncryptionKey } from "./credentials/encryption";

const log = createLogger("agent:cc-credential-manager");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default credentials.json location. Override via CC_CREDENTIALS_PATH. */
const DEFAULT_CREDENTIALS_PATH = join(homedir(), ".claude", "credentials.json");

/** Refresh tokens whose access expires within this window are refreshed eagerly. */
export const REFRESH_LOOKAHEAD_MS = 5 * 60 * 1000;

/** Anthropic OAuth refresh endpoint. */
const OAUTH_REFRESH_URL = "https://console.anthropic.com/v1/oauth/token";

/** Backup retention — keep the last N backups. */
const BACKUP_RETENTION = 10;

/**
 * Fingerprint of the supported credentials.json schema. Computed as the
 * sorted JSON keypath set hashed with SHA-256. When the actual file's
 * fingerprint diverges we emit `CCAuthSchemaDrift` and fall back to
 * passive observation.
 */
const SUPPORTED_SCHEMA_KEYS = [
  "claudeAiOauth.accessToken",
  "claudeAiOauth.refreshToken",
  "claudeAiOauth.expiresAt",
  "claudeAiOauth.subscriptionType",
] as const;

export const SUPPORTED_SCHEMA_FINGERPRINT = createHash("sha256")
  .update([...SUPPORTED_SCHEMA_KEYS].sort().join("\n"))
  .digest("hex");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CredentialsFile {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number; // epoch ms
    subscriptionType?: string;
    email?: string;
  };
  [key: string]: unknown;
}

export interface CcProfileSnapshot {
  id: string;
  type: "pro" | "max" | "api_key";
  expiresAt: Date | null;
  rateLimitStatus: "healthy" | "warning" | "rate_limited";
  accountEmail: string | null;
}

interface ManagerOptions {
  credentialsPath?: string;
  /** Override the OAuth refresh URL for tests. */
  refreshUrl?: string;
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Override the encryption key (32 bytes). Defaults to env. */
  encryptionKey?: Buffer;
  /** Disable disk-backed backups (tests only). */
  disableBackups?: boolean;
}

// ---------------------------------------------------------------------------
// CC Credential Manager
// ---------------------------------------------------------------------------

export class CcCredentialManager {
  private readonly db: Db;
  private readonly credentialsPath: string;
  private readonly refreshUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly encryptionKey: Buffer;
  private readonly disableBackups: boolean;

  constructor(db: Db, options: ManagerOptions = {}) {
    this.db = db;
    this.credentialsPath =
      options.credentialsPath ??
      process.env.CC_CREDENTIALS_PATH ??
      DEFAULT_CREDENTIALS_PATH;
    this.refreshUrl = options.refreshUrl ?? OAUTH_REFRESH_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.encryptionKey = options.encryptionKey ?? loadEncryptionKey();
    this.disableBackups = options.disableBackups ?? false;
  }

  // -------------------------------------------------------------------------
  // File I/O
  // -------------------------------------------------------------------------

  /**
   * Read credentials.json from disk. Returns null when the file is absent.
   * Throws on JSON parse failure — the caller decides whether to emit
   * `CCAuthSchemaDrift`.
   */
  async read(): Promise<CredentialsFile | null> {
    try {
      const raw = await fs.readFile(this.credentialsPath, "utf8");
      return JSON.parse(raw) as CredentialsFile;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  /**
   * Atomically write credentials.json with a backup-before-write step.
   *
   * Sequence:
   *   1. Snapshot current file to `credentials.<iso>.json.bak` (if present).
   *   2. Write new contents to `credentials.json.tmp`.
   *   3. fs.rename tmp -> credentials.json.
   *   4. Garbage-collect backups beyond BACKUP_RETENTION.
   *
   * Rename is atomic on the same filesystem; in the worst case the operation
   * leaves either the prior file or the new file intact — never a torn write.
   */
  async write(contents: CredentialsFile): Promise<void> {
    const dir = dirname(this.credentialsPath);
    await fs.mkdir(dir, { recursive: true });

    if (!this.disableBackups) await this.backupExisting();

    const tmp = `${this.credentialsPath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(contents, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.rename(tmp, this.credentialsPath);

    if (!this.disableBackups) await this.gcBackups();
  }

  private async backupExisting(): Promise<void> {
    let current: string;
    try {
      current = await fs.readFile(this.credentialsPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = `${this.credentialsPath}.${stamp}.bak`;
    await fs.writeFile(backupPath, current, { encoding: "utf8", mode: 0o600 });
    log.debug({ backupPath }, "credentials.json backup written");
  }

  private async gcBackups(): Promise<void> {
    const dir = dirname(this.credentialsPath);
    const base = `${this.credentialsPath.split("/").pop()}.`;
    const entries = await fs.readdir(dir).catch(() => [] as string[]);
    const backups = entries
      .filter((n) => n.startsWith(base) && n.endsWith(".bak"))
      .sort(); // ISO timestamps sort lexicographically
    if (backups.length <= BACKUP_RETENTION) return;
    const stale = backups.slice(0, backups.length - BACKUP_RETENTION);
    for (const name of stale) {
      await fs.unlink(join(dir, name)).catch(() => undefined);
    }
  }

  // -------------------------------------------------------------------------
  // Schema-drift detection
  // -------------------------------------------------------------------------

  /**
   * Compute a fingerprint of the credentials.json schema by collecting every
   * dotted keypath and SHA-256-ing the sorted list. Two files with the same
   * shape produce the same fingerprint regardless of values.
   */
  fingerprintSchema(contents: CredentialsFile): string {
    const paths: string[] = [];
    const walk = (node: unknown, prefix: string): void => {
      if (node === null || typeof node !== "object" || Array.isArray(node)) {
        if (prefix) paths.push(prefix);
        return;
      }
      for (const [k, v] of Object.entries(node)) {
        walk(v, prefix ? `${prefix}.${k}` : k);
      }
    };
    walk(contents, "");
    return createHash("sha256").update(paths.sort().join("\n")).digest("hex");
  }

  /**
   * Returns true when the on-disk file matches the supported schema.
   * Drift triggers passive-observe fallback per the spec.
   */
  async isSchemaSupported(): Promise<boolean> {
    const file = await this.read();
    if (!file) return false;
    // We accept any superset of SUPPORTED_SCHEMA_KEYS — drift is "missing
    // required key" or "type mismatch", not "file added extra field".
    const oauth = file.claudeAiOauth;
    if (!oauth) return false;
    if (typeof oauth.accessToken !== "string") return false;
    if (typeof oauth.refreshToken !== "string") return false;
    if (typeof oauth.expiresAt !== "number") return false;
    return true;
  }

  // -------------------------------------------------------------------------
  // Profile mirror (cc_profiles)
  // -------------------------------------------------------------------------

  /**
   * Observe the current credentials.json file and upsert one row into
   * `cc_profiles`. The id is the fingerprint of the refresh token, so
   * re-observations of the same profile do not produce duplicates.
   */
  async observeCurrent(): Promise<CcProfileSnapshot | null> {
    if (!(await this.isSchemaSupported())) {
      await this.emitEvent("schema_drift", null, {
        path: this.credentialsPath,
        expectedFingerprint: SUPPORTED_SCHEMA_FINGERPRINT,
      });
      return null;
    }
    const file = await this.read();
    const oauth = file!.claudeAiOauth!;
    const id = createHash("sha256")
      .update(oauth.refreshToken!)
      .digest("hex");
    const expiry = new Date(oauth.expiresAt!);

    const subscription = (oauth.subscriptionType ?? "").toLowerCase();
    const type: "pro" | "max" | "api_key" =
      subscription.includes("max")
        ? "max"
        : subscription.includes("pro")
          ? "pro"
          : "api_key";

    const refreshEncrypted = encrypt(oauth.refreshToken!, this.encryptionKey);

    // Upsert. We can't rely on Drizzle's onConflictDoUpdate without a
    // canonical column list, so do read-then-write.
    const [existing] = await this.db
      .select()
      .from(ccProfiles)
      .where(eq(ccProfiles.id, id))
      .limit(1);

    if (existing) {
      await this.db
        .update(ccProfiles)
        .set({
          type,
          oauthRefreshTokenEncrypted: refreshEncrypted,
          expiryTs: expiry,
          accountEmail: oauth.email ?? existing.accountEmail,
          updatedAt: new Date(),
        })
        .where(eq(ccProfiles.id, id));
    } else {
      await this.db.insert(ccProfiles).values({
        id,
        type,
        oauthRefreshTokenEncrypted: refreshEncrypted,
        expiryTs: expiry,
        rateLimitStatus: "healthy",
        accountEmail: oauth.email ?? null,
      });
      await this.emitEvent("observed", id, { type });
    }

    return {
      id,
      type,
      expiresAt: expiry,
      rateLimitStatus: "healthy",
      accountEmail: oauth.email ?? null,
    };
  }

  // -------------------------------------------------------------------------
  // Proactive refresh
  // -------------------------------------------------------------------------

  /**
   * Find profiles whose `expiry_ts` falls within REFRESH_LOOKAHEAD_MS and
   * refresh each one via the Anthropic OAuth refresh endpoint. Updates
   * credentials.json if the refreshed profile is the current one.
   */
  async refreshExpiringProfiles(now: Date = new Date()): Promise<number> {
    const threshold = new Date(now.getTime() + REFRESH_LOOKAHEAD_MS);
    const rows = await this.db
      .select()
      .from(ccProfiles)
      .where(lt(ccProfiles.expiryTs, threshold));

    let refreshed = 0;
    for (const row of rows) {
      if (!row.oauthRefreshTokenEncrypted) continue;
      try {
        const refreshToken = decrypt(
          row.oauthRefreshTokenEncrypted,
          this.encryptionKey,
        );
        const tokenResp = await this.callRefresh(refreshToken);
        if (!tokenResp) continue;
        const newExpiry = new Date(now.getTime() + tokenResp.expiresInSec * 1000);
        const newRefreshEnc = encrypt(tokenResp.refreshToken, this.encryptionKey);
        await this.db
          .update(ccProfiles)
          .set({
            oauthRefreshTokenEncrypted: newRefreshEnc,
            expiryTs: newExpiry,
            updatedAt: now,
          })
          .where(eq(ccProfiles.id, row.id));

        // If this is the active profile in credentials.json, rewrite the file.
        await this.maybeRewriteCredentials(row.id, tokenResp.accessToken, tokenResp.refreshToken, newExpiry);
        await this.emitEvent("refreshed", row.id, { expiresAt: newExpiry.toISOString() });
        refreshed++;
      } catch (err) {
        log.warn({ err, profileId: row.id }, "refresh failed");
      }
    }
    return refreshed;
  }

  private async callRefresh(refreshToken: string): Promise<
    | {
        accessToken: string;
        refreshToken: string;
        expiresInSec: number;
      }
    | null
  > {
    const resp = await this.fetchImpl(this.refreshUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });
    if (!resp.ok) {
      log.warn({ status: resp.status }, "oauth refresh non-200");
      return null;
    }
    const data = (await resp.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresInSec: data.expires_in,
    };
  }

  private async maybeRewriteCredentials(
    profileId: string,
    accessToken: string,
    refreshToken: string,
    expiresAt: Date,
  ): Promise<void> {
    const file = await this.read();
    if (!file?.claudeAiOauth?.refreshToken) return;
    const currentId = createHash("sha256")
      .update(file.claudeAiOauth.refreshToken)
      .digest("hex");
    if (currentId !== profileId) return;
    file.claudeAiOauth.accessToken = accessToken;
    file.claudeAiOauth.refreshToken = refreshToken;
    file.claudeAiOauth.expiresAt = expiresAt.getTime();
    await this.write(file);
  }

  // -------------------------------------------------------------------------
  // Rate-limit swap
  // -------------------------------------------------------------------------

  /**
   * Mark a profile as rate-limited and swap credentials.json to the next
   * eligible profile. Eligibility = `rate_limit_status='healthy'`, ordered
   * by `last_used_ts ASC NULLS FIRST` so swap is round-robin-fair.
   *
   * Returns the new active profile id, or null when no swap target is
   * available (caller stays on the rate-limited profile and must wait).
   */
  async handleRateLimit(profileId: string): Promise<string | null> {
    await this.db
      .update(ccProfiles)
      .set({ rateLimitStatus: "rate_limited", updatedAt: new Date() })
      .where(eq(ccProfiles.id, profileId));

    const candidates = await this.db.select().from(ccProfiles);
    const next = candidates
      .filter(
        (c) =>
          c.id !== profileId &&
          c.rateLimitStatus === "healthy" &&
          c.oauthRefreshTokenEncrypted !== null,
      )
      .sort((a, b) => {
        const ta = a.lastUsedTs?.getTime() ?? 0;
        const tb = b.lastUsedTs?.getTime() ?? 0;
        return ta - tb;
      })[0];

    if (!next) {
      log.warn({ profileId }, "no swap target available — staying on rate-limited profile");
      return null;
    }

    // Rewrite credentials.json with the new profile's tokens.
    // Note: the refresh token is the persistent identity; access token is
    // resolved by calling refresh exactly once on swap.
    const refreshToken = decrypt(
      next.oauthRefreshTokenEncrypted!,
      this.encryptionKey,
    );
    const tokenResp = await this.callRefresh(refreshToken);
    if (!tokenResp) {
      log.warn({ profileId: next.id }, "swap target refresh failed");
      return null;
    }
    const expiry = new Date(Date.now() + tokenResp.expiresInSec * 1000);
    await this.write({
      claudeAiOauth: {
        accessToken: tokenResp.accessToken,
        refreshToken: tokenResp.refreshToken,
        expiresAt: expiry.getTime(),
        subscriptionType: next.type,
        email: next.accountEmail ?? undefined,
      },
    });
    await this.db
      .update(ccProfiles)
      .set({
        oauthRefreshTokenEncrypted: encrypt(tokenResp.refreshToken, this.encryptionKey),
        expiryTs: expiry,
        lastUsedTs: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(ccProfiles.id, next.id));
    await this.emitEvent("swapped", next.id, { from: profileId });
    return next.id;
  }

  // -------------------------------------------------------------------------
  // Event log
  // -------------------------------------------------------------------------

  private async emitEvent(
    eventType: string,
    profileId: string | null,
    metadata: Record<string, unknown> | null,
  ): Promise<void> {
    try {
      await this.db.insert(ccProfileEvents).values({
        id: randomUUID(),
        profileId: profileId ?? "__system__",
        eventType: `CCProfile${eventType[0]!.toUpperCase()}${eventType.slice(1)}`,
        metadata: metadata ?? null,
      });
    } catch (err) {
      log.warn({ err, eventType, profileId }, "failed to persist cc-profile event");
    }
  }
}

// ---------------------------------------------------------------------------
// Back-compat exports — the placeholder module used to re-export the active-
// credential watcher snapshot from credentials/. Keep those available so the
// placeholder consumers (Mac settings, statusline) keep working.
// ---------------------------------------------------------------------------

export {
  getActiveCredentialSnapshot,
  type ActiveCredentialSnapshot,
} from "./credentials/active-credential-watcher";
