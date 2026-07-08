# Add Paste-to-Project Drop

## Why

Leo wants the Raycast "paste -> pick target -> land it in the project" flow on his
iPhone, minus the terminal-detection magic. The common case is a clipboard
screenshot he wants to file into a project's `docs/screenshots/` from his phone,
without SSH, scp keys, or a laptop.

Nexus already has the exact transport for this: a per-machine `nexus-agent` on
`:7400` over Tailscale. The companion `capture-intake` capability (archived
`add-capture-proxy`) proved the pattern — a zero-Swift Apple Shortcut posting to
the agent with a loud-failure posture and a rebuild-from-scratch docs recipe. This
reuses that pattern for a different destination: a **project directory on disk**,
not the mx gateway.

## What Changes

- New agent route **`POST /paste`** (distinct from the existing `POST /capture`
  mx-gateway proxy). JSON body carries base64 file bytes + a target selector:
  - `{ "project": "<code|id>", "filename": "...", "data_base64": "..." }` — resolves
    the project to its `cwd` and writes to `<cwd>/docs/screenshots/<filename>`.
  - `{ "path": "<absolute-dir-or-file>", "filename": "...", "data_base64": "..." }` —
    writes to the caller-described absolute path.
  - This is the agent's first binary-ingest route (base64 in JSON — simplest for an
    Apple Shortcut; no multipart upload surface exists today).
- **Atomic write** (tmp + `rename`), mirroring `PUT /commands/:name`. **No overwrite:**
  a colliding filename is suffixed (`-1`, `-2`, ...) so a drop never clobbers.
- **Loud-failure posture** (same as `capture-intake`): unresolved project -> 404,
  bad/oversized/base64-undecodable body -> 400, filesystem error -> 500, never a
  fabricated success.
- **`docs/paste-shortcut.md`** — the Apple Shortcut rebuild recipe: fetch the project
  list from `GET /projects`, present a picker (or an absolute-path prompt), base64 the
  clipboard image, POST to the agent over Tailscale, success/failure banners. Enough to
  rebuild on a fresh phone from the doc alone (mirrors `docs/capture-shortcut.md`).

## Non-Goals

- No native iOS Share Extension or App Intents / Shortcuts action — the MVP is a
  user-built Apple Shortcut, zero Swift. A first-class "Paste to Project" App Intent is
  a follow-on (`nexus-widgets` is the target template if ever built).
- No terminal/tmux inject path — Leo explicitly dropped the "auto-detect terminal"
  step. `POST /commands/send-text` stays untouched.
- No cross-machine fleet routing. Projects live on multiple dev servers (P2P); the MVP
  targets the phone's one configured agent (`homelab:7400`). Auto-routing a drop to
  whichever machine hosts the project is a follow-on.
- No app-layer auth. The agent has none (dropped by `drop-attach-secret-gate`); trust
  is the Tailnet, consistent with `PUT /commands/:name` already writing files unauthed.
- No DB schema change — the payload lands on disk, not in Postgres.

## Context

- depends on: none
- touches: `apps/agent/src/routes/paste.ts`, `apps/agent/src/server-request-handler.ts`, `docs/paste-shortcut.md`

## Impact

- Affected specs: new capability `paste-drop`.
- Affected code: `apps/agent/src/routes/paste.ts` (new), dispatch wiring in
  `apps/agent/src/server-request-handler.ts`, `docs/paste-shortcut.md` (new).
- Precedents reused: `routes/capture.ts` (loud-failure), `routes/commands.ts` (atomic
  write), `routes/projects.ts` (project -> cwd resolution), `docs/capture-shortcut.md`.

## Testing

- **API seam** — route vitest (`apps/agent/src/routes/paste.test.ts`, mirroring
  `capture.test.ts`): project-mode resolves cwd and lands the file under
  `docs/screenshots/`; absolute-path mode writes to the given path; filename collision
  is suffixed, never overwritten; unknown project -> 404; missing/oversized/undecodable
  base64 -> 400; filesystem failure -> 500; write is atomic (tmp + rename).
- **E2E / on-device** — `[user]` task: rebuild the Shortcut on the phone from
  `docs/paste-shortcut.md` alone, drop a screenshot into a picked project, confirm it
  lands in `<project>/docs/screenshots/`, then stop the agent and confirm the documented
  failure banner. (searched: agent route vitest cannot drive a physical iPhone or execute
  an Apple Shortcut; no documented nx pattern automates on-device Shortcut runs.)
