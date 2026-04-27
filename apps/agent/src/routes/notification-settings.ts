/**
 * Notification settings route handlers.
 *
 * Backs the `/notifications/settings` GET / PATCH endpoints introduced by the
 * `add-notification-control-dashboard` proposal. The settings table is
 * single-row by design (id = 1, bootstrapped by the migration) — both
 * handlers operate on that one row.
 *
 * Auth note: both routes are registered with the default `requiresAuth:
 * true` in `notifications-builder.ts`, so the global router gate
 * (`requireSecret` in `server-auth.ts`) runs before the handler. Handlers
 * therefore do not call `requireSecret` directly — same convention as the
 * sibling `settings.ts` / `notifications.ts` modules.
 *
 * On a successful PATCH the post-update row is broadcast via
 * `lifecycleBus.emit("SettingsChanged", …)` so SSE subscribers (the Mac
 * listener) can update their cached toggles without polling.
 */

import type { Db } from "@nexus/db";
import { notificationSettings, eq } from "@nexus/db";
import { lifecycleBus } from "../services/lifecycle-bus";

// ── Constants ────────────────────────────────────────────────────────────────

const SETTINGS_ROW_ID = 1;
const ALLOWED_KEYS = new Set(["tts_enabled", "banner_enabled", "ducking_mode"]);
const DUCKING_MODES = new Set(["full", "half", "mute"]);

type DuckingMode = "full" | "half" | "mute";

interface SettingsResponse {
  id: number;
  tts_enabled: boolean;
  banner_enabled: boolean;
  ducking_mode: DuckingMode;
  updated_at: string;
}

interface SettingsRow {
  id: number;
  ttsEnabled: boolean;
  bannerEnabled: boolean;
  duckingMode: DuckingMode;
  updatedAt: Date;
}

/**
 * Map an internal Drizzle row (camelCase) to the wire format (snake_case).
 *
 * The wire format mirrors the DB column names exactly so the Mac listener
 * (bash) and the Next.js dashboard (TS) both consume a single canonical
 * shape — no per-client renaming.
 */
function toResponse(row: SettingsRow): SettingsResponse {
  return {
    id: row.id,
    tts_enabled: row.ttsEnabled,
    banner_enabled: row.bannerEnabled,
    ducking_mode: row.duckingMode,
    updated_at: row.updatedAt.toISOString(),
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ── GET /notifications/settings ──────────────────────────────────────────────

/**
 * Return the single-row settings record (id = 1).
 *
 * If the bootstrap row is missing for any reason (manual DB tampering,
 * test schema without the seed), respond 404 — the Mac listener already
 * has a hardcoded fallback (`tts=true, banner=true, ducking=full`) per the
 * proposal's rollback note, so this is safe.
 */
export async function handleGetNotificationSettings(
  db: Db,
  _request: Request,
): Promise<Response> {
  const row = await db.query.notificationSettings.findFirst({
    where: eq(notificationSettings.id, SETTINGS_ROW_ID),
  });

  if (!row) {
    return jsonResponse(
      { error: "settings row not found", detail: "id=1 sentinel missing" },
      404,
    );
  }

  return jsonResponse(toResponse(row));
}

// ── PATCH /notifications/settings ────────────────────────────────────────────

/**
 * Patch the single-row settings record and emit `SettingsChanged`.
 *
 * Validation rules:
 * - Body MUST be a JSON object (not array, not null, not primitive).
 * - Every top-level key MUST be in the allow-list
 *   (`tts_enabled`, `banner_enabled`, `ducking_mode`).
 * - `tts_enabled` / `banner_enabled` MUST be boolean when present.
 * - `ducking_mode` MUST be one of `"full" | "half" | "mute"` when present.
 * - Empty body `{}` is allowed (no-op update; still bumps `updated_at`).
 *
 * On success the handler:
 * 1. UPDATEs row id=1 with the partial patch + `updatedAt = now()`.
 * 2. Reads back the full row (via `.returning()`).
 * 3. Emits `lifecycleBus.emit("SettingsChanged", { ttsEnabled, bannerEnabled, duckingMode })`.
 * 4. Returns the refreshed row in wire format.
 */
export async function handlePatchNotificationSettings(
  db: Db,
  request: Request,
): Promise<Response> {
  // ── Parse JSON ──────────────────────────────────────────────────────────
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }

  if (
    body === null ||
    typeof body !== "object" ||
    Array.isArray(body)
  ) {
    return jsonResponse(
      { error: "body must be a JSON object" },
      400,
    );
  }

  const patch = body as Record<string, unknown>;

  // ── Allow-list validation ──────────────────────────────────────────────
  for (const key of Object.keys(patch)) {
    if (!ALLOWED_KEYS.has(key)) {
      return jsonResponse(
        {
          error: "unknown field",
          detail: `"${key}" is not one of: ${[...ALLOWED_KEYS].join(", ")}`,
        },
        400,
      );
    }
  }

  // ── Per-field type validation ──────────────────────────────────────────
  const update: Partial<{
    ttsEnabled: boolean;
    bannerEnabled: boolean;
    duckingMode: DuckingMode;
  }> = {};

  if ("tts_enabled" in patch) {
    if (typeof patch.tts_enabled !== "boolean") {
      return jsonResponse(
        { error: "tts_enabled must be a boolean" },
        400,
      );
    }
    update.ttsEnabled = patch.tts_enabled;
  }

  if ("banner_enabled" in patch) {
    if (typeof patch.banner_enabled !== "boolean") {
      return jsonResponse(
        { error: "banner_enabled must be a boolean" },
        400,
      );
    }
    update.bannerEnabled = patch.banner_enabled;
  }

  if ("ducking_mode" in patch) {
    const dm = patch.ducking_mode;
    if (typeof dm !== "string" || !DUCKING_MODES.has(dm)) {
      return jsonResponse(
        {
          error: "ducking_mode must be one of: full, half, mute",
        },
        400,
      );
    }
    update.duckingMode = dm as DuckingMode;
  }

  // ── Persist ────────────────────────────────────────────────────────────
  // Always bump `updatedAt` so PATCH {} still moves the timestamp (treated
  // as a "touch"). Drizzle's `.returning()` gives us the post-update row
  // in one round-trip — no second SELECT needed.
  const updated = await db
    .update(notificationSettings)
    .set({ ...update, updatedAt: new Date() })
    .where(eq(notificationSettings.id, SETTINGS_ROW_ID))
    .returning();

  const row = updated[0];
  if (!row) {
    return jsonResponse(
      { error: "settings row not found", detail: "id=1 sentinel missing" },
      404,
    );
  }

  // ── Broadcast ──────────────────────────────────────────────────────────
  lifecycleBus.emit("SettingsChanged", {
    ttsEnabled: row.ttsEnabled,
    bannerEnabled: row.bannerEnabled,
    duckingMode: row.duckingMode,
  });

  return jsonResponse(toResponse(row));
}
