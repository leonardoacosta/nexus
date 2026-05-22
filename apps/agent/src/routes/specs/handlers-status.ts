/**
 * PATCH /specs/:project/:name/status — flip spec frontmatter status atomically.
 *
 * Spec: openspec/changes/specs-tab-start-on-spec § Endpoint Wiring.
 *
 * Body: `{ status: "draft" | "approved" }`.
 *
 * Behaviour:
 *   - On `approved`: writes/updates `status`, `approved-by`, `approved-at`
 *     in the YAML frontmatter of `proposal.md`. `approved-at` is an
 *     ISO-8601 timestamp with timezone offset. `approved-by` is resolved
 *     from `git config user.email` (subprocess) with a fallback chain to
 *     `$USER` then literal `"unknown"`.
 *   - On `draft`: writes `status: draft` and REMOVES both `approved-by`
 *     and `approved-at` keys (the proposal's "mark-draft" semantic).
 *   - On archived spec dirs: 409 (read-only).
 *   - On invalid status: 400.
 *
 * The write is atomic via `.tmp + fs.renameSync` (POSIX rename is atomic on
 * the same filesystem). Last-writer-wins is acceptable for the
 * single-user interactive flow described in the proposal's Risk section.
 *
 * After a successful write the handler emits a `SpecTransition` event on
 * `lifecycleBus` with `transition: "status_change"` so the `/specs/events`
 * SSE bus fans the change out to subscribers (Swift dashboard SpecsView).
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createLogger } from "@nexus/core/node";
import { resolveSpecDir } from "../../services/session-spec-link";
import { lifecycleBus } from "../../services/lifecycle-bus";

const log = createLogger("agent:routes:specs:handlers-status");

type SpecStatus = "draft" | "approved";

const ALLOWED_STATUSES: ReadonlySet<SpecStatus> = new Set(["draft", "approved"]);

export interface PatchStatusBody {
  status: SpecStatus;
}

/**
 * Resolve the actor email for `approved-by`. Subprocess `git config
 * user.email` first; fall back to `$USER`, then the literal string
 * `"unknown"` so the key is always present when status flips to approved.
 */
function resolveApprover(): string {
  try {
    const r = spawnSync("git", ["config", "user.email"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (r.status === 0 && r.stdout) {
      const email = r.stdout.trim();
      if (email) return email;
    }
  } catch {
    /* fall through to $USER */
  }
  return process.env.USER || "unknown";
}

/**
 * Splice the YAML frontmatter block of a markdown file.
 *
 * `updates` MUST contain string values for keys to upsert. Keys in
 * `removes` are stripped from the block (no-op if absent).
 *
 * If the file has no frontmatter yet, a fresh `---\n...\n---\n` header
 * is prepended above the existing body. Indentation, list values, and
 * nested keys are NOT supported — this is a flat key:value editor by
 * design (the spec's frontmatter contract is flat-only).
 */
export function spliceFrontmatter(
  source: string,
  updates: Record<string, string>,
  removes: ReadonlySet<string>,
): string {
  const FENCE = "---";
  const lines = source.split("\n");

  // Detect existing frontmatter: first non-empty line must be a bare `---`.
  let firstIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim().length === 0) continue;
    if (line.trim() === FENCE) firstIdx = i;
    break;
  }

  if (firstIdx === -1) {
    // No existing block. Build one.
    const header = [FENCE];
    for (const [k, v] of Object.entries(updates)) {
      header.push(`${k}: ${v}`);
    }
    header.push(FENCE);
    return header.join("\n") + "\n" + source;
  }

  // Find the closing fence.
  let endIdx = -1;
  for (let i = firstIdx + 1; i < lines.length; i++) {
    if ((lines[i] ?? "").trim() === FENCE) {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    // Malformed — opening fence with no close. Treat as no frontmatter and
    // prepend a fresh block; the malformed opener becomes plain content.
    const header = [FENCE];
    for (const [k, v] of Object.entries(updates)) {
      header.push(`${k}: ${v}`);
    }
    header.push(FENCE);
    return header.join("\n") + "\n" + source;
  }

  const bodyLines = lines.slice(endIdx + 1);
  const fmBody = lines.slice(firstIdx + 1, endIdx);

  // Track which update keys we've already emitted so we know what to
  // append at the end.
  const seenUpdates = new Set<string>();
  const rewritten: string[] = [];

  for (const line of fmBody) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) {
      rewritten.push(line);
      continue;
    }
    const key = line.slice(0, colonIdx).trim();
    if (removes.has(key)) continue; // strip
    if (key in updates) {
      const v = updates[key];
      if (v !== undefined) {
        rewritten.push(`${key}: ${v}`);
        seenUpdates.add(key);
        continue;
      }
    }
    rewritten.push(line);
  }

  // Append any updates that didn't replace an existing key.
  for (const [k, v] of Object.entries(updates)) {
    if (!seenUpdates.has(k)) {
      rewritten.push(`${k}: ${v}`);
    }
  }

  const out = [
    ...lines.slice(0, firstIdx),
    FENCE,
    ...rewritten,
    FENCE,
    ...bodyLines,
  ];
  return out.join("\n");
}

export async function handlePatchSpecStatus(
  project: string,
  specName: string,
  request: Request,
): Promise<Response> {
  // Parse + validate body.
  let body: PatchStatusBody;
  try {
    body = (await request.json()) as PatchStatusBody;
  } catch {
    return new Response(
      JSON.stringify({ error: "invalid JSON body" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  if (!body || typeof body.status !== "string" || !ALLOWED_STATUSES.has(body.status)) {
    return new Response(
      JSON.stringify({ error: "status must be 'draft' or 'approved'" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // Resolve the spec directory. Archived specs are read-only — 409.
  const specDir = resolveSpecDir(project, specName);
  if (!specDir) {
    return new Response(
      JSON.stringify({ error: "spec not found" }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }
  if (specDir.includes(`${"/"}archive${"/"}`)) {
    return new Response(
      JSON.stringify({ error: "spec is archived (read-only)" }),
      { status: 409, headers: { "Content-Type": "application/json" } },
    );
  }

  const proposalPath = join(specDir, "proposal.md");
  if (!existsSync(proposalPath)) {
    return new Response(
      JSON.stringify({ error: "proposal.md missing" }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }

  let original: string;
  try {
    original = readFileSync(proposalPath, "utf8");
  } catch (err) {
    log.error(
      { project, spec: specName, err: err instanceof Error ? err.message : String(err) },
      "proposal.md read failed",
    );
    return new Response(
      JSON.stringify({ error: "read failed" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  // Build the splice update + remove set per status.
  let updates: Record<string, string>;
  let removes: Set<string>;
  if (body.status === "approved") {
    const actor = resolveApprover();
    // ISO-8601 with TZ offset (not Z). The Node Date.toISOString() emits a
    // UTC `Z` string; we want the local offset to match the existing
    // `triage` convention. Reuse the small helper at the bottom.
    const approvedAt = formatIsoWithOffset(new Date());
    updates = {
      status: "approved",
      "approved-by": actor,
      "approved-at": approvedAt,
    };
    removes = new Set();
  } else {
    updates = { status: "draft" };
    removes = new Set(["approved-by", "approved-at"]);
  }

  const next = spliceFrontmatter(original, updates, removes);

  // Atomic write via .tmp + rename. Same-fs guarantee: POSIX rename is
  // atomic. The .tmp suffix is intentionally human-readable so a crash
  // mid-write leaves a discoverable artifact for ops triage.
  const tmpPath = `${proposalPath}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(tmpPath, next, "utf8");
    renameSync(tmpPath, proposalPath);
  } catch (err) {
    log.error(
      {
        project,
        spec: specName,
        err: err instanceof Error ? err.message : String(err),
      },
      "proposal.md atomic write failed",
    );
    return new Response(
      JSON.stringify({ error: "write failed" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  // Emit on the lifecycle bus so /specs/events SSE subscribers learn about
  // the change without polling. Failure to publish is logged but never
  // fails the request — the disk write IS the source of truth.
  try {
    lifecycleBus.emit("SpecTransition", {
      project,
      specName,
      transition: "status_change",
      toStatus: body.status,
    });
  } catch (err) {
    log.warn(
      { project, spec: specName, err: err instanceof Error ? err.message : String(err) },
      "lifecycle bus publish failed (non-fatal)",
    );
  }

  return new Response(
    JSON.stringify({ project, name: specName, status: body.status }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

/** ISO-8601 with `+HH:MM` / `-HH:MM` offset (matches the triage convention). */
function formatIsoWithOffset(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hour = pad(d.getHours());
  const min = pad(d.getMinutes());
  const sec = pad(d.getSeconds());
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const offsetHH = pad(Math.floor(Math.abs(offsetMin) / 60));
  const offsetMM = pad(Math.abs(offsetMin) % 60);
  return `${year}-${month}-${day}T${hour}:${min}:${sec}${sign}${offsetHH}:${offsetMM}`;
}
