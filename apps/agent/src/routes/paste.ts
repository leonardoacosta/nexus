/**
 * POST /paste — write decoded file bytes into a project dir or absolute path.
 *
 * The "Raycast paste -> pick project -> land in docs/screenshots" flow, made
 * agent-native (see docs/paste-shortcut.md). An Apple Shortcut base64-encodes a
 * clipboard image and POSTs `{project|path, filename, data_base64}`; this
 * handler decodes the bytes and writes them to a resolved destination on disk,
 * returning the written absolute path.
 *
 * DISTINCT from POST /capture: capture proxies a thought to the mx gateway;
 * paste writes bytes to the local filesystem. This route does NOT forward to
 * the gateway.
 *
 * NOT FAIL-SOFT (same loud-failure posture as routes/capture.ts): a paste that
 * silently vanishes is worse than one that visibly fails — the Shortcut shows
 * the error and the image stays in hand. Failures surface as distinct statuses:
 *   - invalid JSON / bad selector / missing-or-undecodable-or-oversized payload
 *     -> 400 (writes nothing)
 *   - `project` resolves to no registered project -> 404 (writes nothing)
 *   - destination dir cannot be created or the file cannot be written -> 500
 *     (no partial file remains — tmp is cleaned up, the final path is untouched)
 * A fabricated success is NEVER returned.
 *
 * Write is ATOMIC (temp file + rename, mirroring PUT /commands/:name in
 * routes/commands.ts) and NO-CLOBBER: a colliding basename is suffixed
 * (`name-1.ext`, `name-2.ext`, ...) so a drop never overwrites an existing file.
 *
 * Auth: no per-request gate of its own — dispatched from `createRequestHandler`
 * AFTER the origin defense-in-depth block, so a disallowed browser origin is
 * rejected with 403 before it ever reaches here, and bind-layer reach (loopback
 * + Tailscale) is the transport-level gate. No new auth mechanism is introduced.
 */

import type { Db } from "@nexus/db";
import { logger } from "@nexus/core/node";
import { mkdir, rename, writeFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, extname, isAbsolute, join } from "node:path";
import { getProjects } from "../services/config-loader";
import { listAllRegisteredProjects } from "../db/project-registry";

/**
 * Decoded-size cap. Screenshots/images only — not video. 25MB comfortably
 * covers a full-resolution phone screenshot while bounding the write.
 */
const MAX_DECODED_BYTES = 25 * 1024 * 1024;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Resolve a `project` (a project CODE or a project ID) to a filesystem cwd,
 * reusing the two existing resolution paths — never a new lookup:
 *   - CODE: `getProjects()` from the config-loader (the exact path
 *     routes/project-detail.ts resolves `/project/:code/*` through).
 *   - ID (UUID): `listAllRegisteredProjects(db)` from the projects registry
 *     (the exact query routes/projects.ts aggregates `GET /projects` from);
 *     the cwd lives in `project_locations.path`.
 * Returns null when neither path resolves.
 */
async function resolveProjectCwd(
  project: string,
  db?: Db,
): Promise<string | null> {
  const byCode = getProjects().find((p) => p.code === project);
  if (byCode) return byCode.path;

  if (db) {
    const registered = await listAllRegisteredProjects(db);
    const byId = registered.find((r) => r.projectId === project);
    if (byId) return byId.path;
  }

  return null;
}

/**
 * First non-colliding path for `name` in `dir`. If `dir/name` is free it is
 * returned as-is; otherwise the basename is suffixed `-1`, `-2`, ... before the
 * extension until a free path is found. Best-effort (existsSync pre-check +
 * rename), consistent with PUT /commands/:name's tmp+rename write.
 */
function nextAvailablePath(dir: string, name: string): string {
  const initial = join(dir, name);
  if (!existsSync(initial)) return initial;

  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 1; ; i++) {
    const candidate = join(dir, `${stem}-${i}${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
}

export async function handlePostPaste(
  request: Request,
  db?: Db,
): Promise<Response> {
  // 1. Parse the JSON body.
  let body: {
    project?: unknown;
    path?: unknown;
    filename?: unknown;
    data_base64?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const { project, path: targetPath, filename, data_base64 } = body;

  // 2. Selector: exactly one of `project` | `path`.
  const hasProject = typeof project === "string" && project.trim() !== "";
  const hasPath = typeof targetPath === "string" && targetPath.trim() !== "";
  if (hasProject === hasPath) {
    return json(
      { error: "exactly one of `project` or `path` is required" },
      400,
    );
  }

  // 3. filename + data_base64 present.
  if (typeof filename !== "string" || filename.trim() === "") {
    return json({ error: "`filename` is required" }, 400);
  }
  if (typeof data_base64 !== "string" || data_base64.trim() === "") {
    return json({ error: "`data_base64` is required" }, 400);
  }

  // 3b. filename must be a bare basename — no path traversal into arbitrary
  //     locations via `../` or nested segments.
  const safeName = basename(filename);
  if (safeName !== filename || safeName === "." || safeName === "..") {
    return json({ error: "`filename` must be a bare filename" }, 400);
  }

  // 4. Validate + decode base64. Strip whitespace (Shortcuts wrap the encoded
  //    string) then check the alphabet + padding, size-cap on the encoded
  //    length BEFORE allocating, then confirm the exact decoded size.
  const stripped = data_base64.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(stripped) || stripped.length % 4 !== 0) {
    return json({ error: "`data_base64` is not valid base64" }, 400);
  }
  const approxBytes = Math.floor(stripped.length / 4) * 3;
  if (approxBytes > MAX_DECODED_BYTES) {
    return json({ error: "payload exceeds size cap" }, 400);
  }
  const bytes = Buffer.from(stripped, "base64");
  if (bytes.length > MAX_DECODED_BYTES) {
    return json({ error: "payload exceeds size cap" }, 400);
  }

  // 5. Resolve the destination directory.
  let destDir: string;
  if (hasProject) {
    const cwd = await resolveProjectCwd(project as string, db);
    if (!cwd) {
      return json({ error: `unknown project: ${String(project)}` }, 404);
    }
    destDir = join(cwd, "docs", "screenshots");
  } else {
    const p = targetPath as string;
    if (!isAbsolute(p)) {
      return json({ error: "`path` must be absolute" }, 400);
    }
    destDir = p;
  }

  // 6. Atomic, no-clobber write: mkdir -p, write to a unique temp file in the
  //    destination dir, then rename onto the (collision-suffixed) final path.
  try {
    await mkdir(destDir, { recursive: true });
  } catch (err) {
    logger.warn({ route: "/paste", destDir, err }, "paste mkdir failed");
    return json({ error: `mkdir failed: ${errMsg(err)}` }, 500);
  }

  const finalPath = nextAvailablePath(destDir, safeName);
  const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`;
  try {
    // `wx`: fail if the (unique) temp path somehow already exists — never
    // silently overwrite an in-flight temp file.
    await writeFile(tmpPath, bytes, { flag: "wx" });
    await rename(tmpPath, finalPath);
  } catch (err) {
    // Clean up the temp file so no partial artifact remains on failure.
    try {
      await unlink(tmpPath);
    } catch {
      // best-effort
    }
    logger.warn({ route: "/paste", finalPath, err }, "paste write failed");
    return json({ error: `write failed: ${errMsg(err)}` }, 500);
  }

  logger.info(
    { route: "/paste", path: finalPath, bytes: bytes.length },
    "paste written",
  );
  return json({ path: finalPath }, 200);
}
