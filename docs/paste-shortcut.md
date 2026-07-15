---
status: current
updated: 2026-07-15
---

# Paste Shortcut — drop a pasted image into a project

The paste surface for Nexus is deliberately **zero-Swift**: an Apple Shortcut
that base64-encodes a clipboard image and POSTs it to `nexus-agent` over
Tailscale, which writes the bytes into a project directory on disk (`POST
/paste`, see `apps/agent/src/routes/paste.ts`). No app build, no App Store —
rebuildable on a fresh phone in a few minutes from this doc alone.

This is the phone-native version of the Raycast "paste → pick project → land in
`docs/screenshots`" flow, minus the terminal-detection magic. It is a **separate
route** from `POST /capture` (that proxies a thought to the mx gateway; this
writes a file to disk).

This document is the source of truth for that Shortcut. If the Shortcut is lost
or you set up a new device, rebuild it from the steps below.

## What it does

- **Manual tap** (Home Screen icon / Spotlight / "Hey Siri, Paste to Nexus") →
  pick a target → pick/paste an image → it lands as a file in that project's
  `docs/screenshots/`.
- **Share an image** → share sheet → *Paste to Nexus* → same, with the shared
  image as the payload.
- Pick a **project** from a list fetched live from the agent, OR choose *Enter
  absolute path* to drop into any directory on the machine.
- On success, a banner shows the written path. On failure (agent stopped,
  unknown project, off-tailnet) the Shortcut shows the error and **stops** — the
  image stays in your hands to re-tap. It is never silently swallowed.

## The requests the Shortcut makes

It makes up to two calls: one to list projects, one to drop the file.

### 1. List projects (to build the picker)

| Field | Value |
| ----- | ----- |
| Method | `GET` |
| URL | `http://<agent-host>:7400/projects` (Tailscale — see below) |
| Response | JSON array of `{ id, name, ... }` (a bare `Project[]`; no auth) |

Use the `name` values to populate a **Choose from List**; keep each item's `id`
(or, if you prefer human-friendly codes, ship a fixed code list) so the drop
call can send the selected target. The agent resolves either a project **code**
or a project **id** to the project's working directory.

### 2. Drop the file

| Field | Value |
| ----- | ----- |
| Method | `POST` |
| URL | `http://<agent-host>:7400/paste` |
| Header | `Content-Type: application/json` |
| Body | JSON: see below |

Body — **exactly one** of `project` / `path`, plus `filename` + `data_base64`:

```json
{ "project": "<code-or-id>", "filename": "shot.png", "data_base64": "<...>" }
```

or, for the absolute-path fallback:

```json
{ "path": "/home/nyaptor/dev/nx/docs/screenshots", "filename": "shot.png", "data_base64": "<...>" }
```

### Body field mapping

| Source in the Shortcut | Body field |
| ---------------------- | ---------- |
| Picked project's `id` (or code) from the `/projects` list | `project` |
| *Enter absolute path* branch: the directory you typed | `path` (omit `project`) |
| A filename you type / dictate, or a generated `Current Date` name | `filename` |
| The picked/pasted/shared image, **Base64 Encoded** | `data_base64` |

So a project drop yields
`{"project":"nx","filename":"shot.png","data_base64":"iVBORw0KGgo..."}` and lands
the bytes at `<project-cwd>/docs/screenshots/shot.png`. An absolute-path drop
yields `{"path":"/abs/dir","filename":"shot.png","data_base64":"..."}` and writes
`/abs/dir/shot.png`.

**No overwrite:** if `shot.png` already exists in the destination, the agent
suffixes the new file (`shot-1.png`, `shot-2.png`, ...) and returns the actual
written path — an existing file is never clobbered.

## The agent URL over Tailscale

The agent listens on **port 7400, Tailscale-only** (bound to loopback + the
tailnet — it is unreachable from the public internet). Use the MagicDNS name or
Tailscale IP of the machine running `nexus-agent`:

- MagicDNS: `http://<machine>.<your-tailnet>.ts.net:7400/paste`
- Tailscale IP: `http://100.x.y.z:7400/paste` (the homelab agent is
  `100.73.182.4` as of this writing — confirm with `tailscale status`).

The phone MUST be on the same tailnet (Tailscale app installed, logged in,
connected). Off-tailnet, the request cannot reach the agent and the Shortcut
shows a connection failure — see banners below.

### Auth header shape

There is **no bearer token or secret header**. The legacy `x-nexus-secret`
gate was removed (`drop-attach-secret-gate`); the agent's auth model is now:

1. **Transport auth — Tailscale ACL.** Only devices on your tailnet can reach
   `:7400` at all. This is the real gate: tailnet membership *is* the credential.
2. **Origin defense-in-depth.** The agent rejects browser requests from
   non-Tailscale origins with `403 origin not allowed`. The Shortcut sends **no**
   `Origin` header (it is not a browser), so it is unaffected — do not add one.

So the only header the drop call needs is `Content-Type: application/json`. If a
future change reintroduces a per-request secret, it would arrive as an added
request header here; today there is none to set.

## Build it — manual + share-sheet, one Shortcut

1. **Shortcuts app → +** (new shortcut). Name it **Paste to Nexus**.
2. **Shortcut Details** (the ⓘ / settings): enable **Show in Share Sheet**. Set
   **Share Sheet Types** to accept **Images** (so it appears in the share sheet
   on a photo/screenshot).
3. Add actions in order:
   1. **Get the image** to drop:
      - **If** *Shortcut Input* **has any value** (shared from the share sheet):
        use *Shortcut Input* as the image.
      - **Otherwise** (manual invocation): **Select Photos** (or paste from the
        clipboard via **Get Clipboard**) → the chosen image.
   2. **Get Contents of URL** → `http://<agent-host>:7400/projects` (**GET**) →
      **Get Dictionary from Input** / **Get Items from List** to pull the
      project `name`s (keep `id`s alongside).
   3. **Choose from List** on the project names. Add a literal first item
      **"Enter absolute path…"** so the picker doubles as the fallback.
   4. **If** the chosen item **is** "Enter absolute path…":
      - **Ask for Input** (Text): prompt "Destination directory" → set `Target`.
      - Later, build the body with `path` = `Target` (omit `project`).
   5. **Otherwise**:
      - Set `Target` to the picked project's `id` (or code).
      - Later, build the body with `project` = `Target` (omit `path`).
   6. **Base64 Encode** the image → set `ImageB64`.
   7. Decide a **filename** — either **Ask for Input** (Text) or a generated
      name like `Current Date` formatted `paste-yyyyMMdd-HHmmss.png` → set
      `Filename`.
   8. **Text** action holding the literal JSON body with `Target` / `Filename` /
      `ImageB64` interpolated into the correct field (`project` **or** `path`).
   9. **Get Contents of URL**:
      - URL: `http://<agent-host>:7400/paste`
      - Method: **POST**
      - Headers: `Content-Type` = `application/json`
      - Request Body: **File** (or **Text**) with the JSON built above.
   10. **Get Dictionary from Input** on the response → read `path` (the written
       absolute path).
   11. **Show Notification** / **Show Result** with the `path` on success.
4. Optionally add the Shortcut to the Home Screen and enable the Siri phrase
   "Paste to Nexus" for hands-free manual invocation.

> Tip: the simplest robust body construction is a **Text** action containing the
> literal JSON with `Target` / `Filename` / `ImageB64` variables interpolated,
> passed to *Get Contents of URL* as the request body with `Content-Type:
> application/json`. Because `data_base64` can be large, prefer passing the body
> as a **File** if a **Text** body truncates.

## Success / failure banners

The route is **not fail-soft** — it never fabricates a success. Match the
Shortcut's UI to the agent's response:

| Situation | Agent response | Shortcut should show |
| --------- | -------------- | -------------------- |
| Written | `200` + `{"path": "..."}` | Banner: "Saved — `<path>`" |
| Missing/undecodable/oversized payload, both or neither target, non-absolute `path` | `400` + `{"error": "..."}` | Banner: the error text, then stop |
| Unknown `project` (resolves to nothing) | `404` + `{"error": "unknown project: ..."}` | Banner: "Unknown project", then stop |
| Destination dir cannot be created / written | `500` + `{"error": "..."}` | Banner: the error text, then stop |
| **Agent stopped** / off-tailnet | connection error (no HTTP response) | Shortcut's built-in "Could not connect" error, then stop |

To wire this: after *Get Contents of URL*, branch on the HTTP status (or use the
Shortcut's error handling — turn **off** "Allow Sharing failures silently" so a
non-2xx / connection failure surfaces). On any non-2xx, show the error body and
**stop the Shortcut** rather than reporting success. The image is preserved in
your photo library / clipboard — retry is a re-tap.

## Verifying end-to-end (the `[user]` step)

On a real phone (this cannot be simulated):

1. Rebuild the Shortcut from this doc on a fresh device.
2. Manually invoke → pick a project → pick a screenshot → confirm the success
   banner shows a path under `<project>/docs/screenshots/`.
3. On the host, confirm the file actually landed at that path with the right
   bytes.
4. **Stop `nexus-agent`** on the host, drop again → confirm the documented
   failure banner appears and nothing is silently accepted.
