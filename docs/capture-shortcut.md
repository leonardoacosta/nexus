# Capture Shortcut — the pilot phone capture surface

The pilot capture surface for Nexus is deliberately **zero-Swift**: an Apple
Shortcut, share-sheet enabled, that POSTs a captured thought to `nexus-agent`
over Tailscale. The agent proxies it to the mx gateway (`POST /capture`, see
`apps/agent/src/routes/capture.ts`). No app build, no App Store — rebuildable
on a fresh phone in a few minutes from this doc alone.

This document is the source of truth for that Shortcut. If the Shortcut is lost
or you set up a new device, rebuild it from the steps below.

## What it does

- **Share a page** → share sheet → *Capture to Nexus* → the page title + URL are
  captured as a thought.
- **Manual tap** (Home Screen icon / Spotlight / "Hey Siri, Capture to Nexus")
  → type or dictate a bare thought → captured with no URL.
- On success, a banner shows the created request id. On failure (agent stopped,
  gateway down, off-tailnet) the Shortcut shows the error and **stops** — the
  thought stays in your hands to re-tap. It is never silently swallowed.

## The request the Shortcut makes

| Field | Value |
| ----- | ----- |
| Method | `POST` |
| URL | `http://<agent-host>:7400/capture` (Tailscale — see below) |
| Header | `Content-Type: application/json` |
| Body | JSON: `{ "title": <text>, "url": <shared page URL, optional> }` |

### Body field mapping

The agent forwards the body **verbatim** to the mx gateway — the Shortcut owns
the field mapping:

| Source in the Shortcut | Body field |
| ---------------------- | ---------- |
| Share-sheet input (a web page): the page **name/title** | `title` |
| Share-sheet input: the page **URL** | `url` |
| Manual invocation: the text you type / dictate (`Ask Each Time`) | `title` |
| Manual invocation | `url` omitted (a bare thought has no source page) |

So a shared page yields `{"title":"Some Article","url":"https://..."}` and a
manual thought yields `{"title":"call the vet"}`.

## The agent URL over Tailscale

The agent listens on **port 7400, Tailscale-only** (bound to loopback + the
tailnet — it is unreachable from the public internet). Use the MagicDNS name or
Tailscale IP of the machine running `nexus-agent`:

- MagicDNS: `http://<machine>.<your-tailnet>.ts.net:7400/capture`
- Tailscale IP: `http://100.x.y.z:7400/capture` (the homelab agent is
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

So the only header the Shortcut needs is `Content-Type: application/json`. If a
future change reintroduces a per-request secret, it would arrive as an added
request header here; today there is none to set.

## Build it — share-sheet + manual, one Shortcut

1. **Shortcuts app → +** (new shortcut). Name it **Capture to Nexus**.
2. **Shortcut Details** (the ⓘ / settings): enable **Show in Share Sheet**. Set
   **Share Sheet Types** to accept **URLs** (and Safari web pages). This makes it
   appear in the share sheet on a page.
3. Add actions in order:
   1. **If** *Shortcut Input* **has any value** (this branch = shared from a page):
      - **Get Details of Safari Web Page** (or **Get URLs from Input**) → to get
        the page URL.
      - **Text** action holding the page **Name/Title** → set an intermediate
        variable `CaptureTitle`.
      - Build the JSON body with both `title` and `url`.
   2. **Otherwise** (manual invocation, no input):
      - **Ask for Input** (Text): prompt "Capture a thought" → set `CaptureTitle`.
      - Build the JSON body with `title` only (omit `url`).
   3. **Get Contents of URL**:
      - URL: `http://<agent-host>:7400/capture`
      - Method: **POST**
      - Headers: `Content-Type` = `application/json`
      - Request Body: **JSON** (or **File** with the text built above) — the
        `{title, url?}` object.
   4. **Get Dictionary from Input** on the response → read `id` (the created
      request id).
   5. **Show Notification** / **Show Result** with the `id` on success.
4. Optionally add the Shortcut to the Home Screen and enable the Siri phrase
   "Capture to Nexus" for hands-free manual capture.

> Tip: the simplest robust body construction is a **Text** action containing the
> literal JSON with `CaptureTitle` / URL variables interpolated, passed to *Get
> Contents of URL* as the request body with `Content-Type: application/json`.

## Success / failure banners

The route is **not fail-soft** — it never fabricates a success. Match the
Shortcut's UI to the agent's response:

| Situation | Agent response | Shortcut should show |
| --------- | -------------- | -------------------- |
| Captured | `200` + `{"id": "..."}` | Banner: "Captured — `<id>`" |
| Bad payload (e.g. missing title) | `4xx` + gateway error body, **verbatim** | Banner: the error text, then stop |
| mx gateway unreachable / hung | `504 {"error":"capture gateway unreachable"}` | Banner: "Capture gateway unreachable — try again", then stop |
| **Agent stopped** / off-tailnet | connection error (no HTTP response) | Shortcut's built-in "Could not connect" error, then stop |

To wire this: after *Get Contents of URL*, branch on the HTTP status (or use the
Shortcut's error handling — turn **off** "Allow Sharing failures silently" so a
non-2xx / connection failure surfaces). On any non-2xx, show the error body and
**stop the Shortcut** rather than reporting success. The thought is preserved on
the share sheet / in the dictated text — retry is a re-tap.

## Verifying end-to-end (the `[user]` step)

On a real phone (this cannot be simulated):

1. Rebuild the Shortcut from this doc on a fresh device.
2. Share a web page → confirm the success banner shows a created id.
3. Manually capture a bare thought → confirm a second created id.
4. **Stop `nexus-agent`** on the host, capture again → confirm the documented
   failure banner appears and nothing is silently accepted.
