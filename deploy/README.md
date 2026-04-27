# Nexus Deploy

Operator notes for shipping nexus to a homelab Linux host and a Mac
listener. Everything here is shell scripts and plists — there's no
container runtime, no Kubernetes, no Terraform required for the runtime
path. (Networking and Cloudflare DNS are managed separately, out of
scope for this README.)

## Layout

```
deploy/
├── install.sh                    # entry point — Linux install (Linux agent + git hooks)
├── nexus-agent.service           # systemd user unit (Linux agent)
├── com.nexus.agent.plist         # legacy launchd unit (Mac agent — rarely used)
├── nexus-notifier.sh             # Mac listener — FIFO+say + afplay/audioBase64 + dashboard
├── com.nexus.notifier.plist      # launchd unit for the Mac listener
├── com.nexus.tts-player.plist    # drain worker for the FIFO (legacy say path)
├── traefik/                      # dashboard reverse-proxy config
├── hooks/                        # git-hook dispatchers for spec-aware automation
└── hooks.d/post-merge/02-deploy  # rebuilds + fans out to every Mac in agents.toml
```

`deploy/nexus-notifier.sh` is the single canonical Mac listener. It carries
the legacy FIFO+`say` pipeline (with dedup, banner emoji icons, drain
worker) and the audioBase64+`afplay` path from the audio-dispatch spec, plus
the bootstrap-from-`/notifications/settings` and SSE `SettingsChanged`
hooks from the dashboard spec. The audio path takes precedence whenever a
NotificationFired frame carries `payload.audioBase64`; otherwise dispatch
falls through to the FIFO so the drain worker plays it serially via `say`.

## Linux agent install (homelab side)

Run on the Linux host that hosts the agent:

```bash
git clone github.com/leonardoacosta/nexus ~/dev/nx
cd ~/dev/nx
deploy/install.sh
```

This builds `apps/agent` via `bun run build`, drops the binary at
`~/.local/bin/nexus-agent`, and installs the systemd user unit. Activate:

```bash
systemctl --user daemon-reload
systemctl --user enable --now nexus-agent
journalctl --user -u nexus-agent -f
```

To also install the Next.js dashboard service (port 3100, fronted by
Traefik), pass `--dashboard`:

```bash
deploy/install.sh --dashboard
```

## Mac listener install (audio dispatch side)

The Mac listener subscribes to the agent's `/events/stream` SSE endpoint
and pipes ElevenLabs mp3 bytes into `/usr/bin/afplay`. When a frame
arrives without `audioBase64` (signal-only — no key, or the upstream call
failed), dispatch falls through to the FIFO so the drain worker plays
the body via `/usr/bin/say` serially.

**Mac install is automatic via the post-merge hook.** When you push to
`main` (or pull on the Linux host), `deploy/hooks.d/post-merge/02-deploy`
fans out to every entry in `~/.config/nexus/agents.toml` whose `host` is
not `localhost`/`127.0.0.1`, runs `git pull --ff-only`, and rebuilds. On
Darwin targets the same script `cp`s `deploy/nexus-notifier.sh` to
`~/bin/`, installs `deploy/com.nexus.notifier.plist` and
`deploy/com.nexus.tts-player.plist` into `~/Library/LaunchAgents/`, and
runs `launchctl bootout && launchctl load`. There is no separate `--mac`
shipping flow — the install path is just a `git pull` away.

Verify the listener is healthy:

```bash
ssh mac 'launchctl list | grep com.nexus.notifier'
ssh mac 'tail -f ~/Library/Logs/nexus-notifier.log'
```

## Secret provisioning

| Secret                  | Where it lives                | Why                                                  |
| ----------------------- | ----------------------------- | ---------------------------------------------------- |
| `ELEVENLABS_API_KEY`    | Linux agent only (DB or env)  | The agent synthesizes; the Mac just plays bytes.     |
| `ELEVENLABS_VOICE_ID`   | Linux agent only (optional)   | Defaults to `21m00Tcm4TlvDq8ikWAM` if unset.         |
| `NEXUS_ATTACH_SECRET`   | Linux agent **and** Mac       | Bearer for the SSE handshake (`x-nexus-secret`).     |

### Linux side

Preferred: write the ElevenLabs key to the per-agent
`elevenlabs_credentials` row through the dashboard (encrypted at rest,
rotates without an agent restart). The agent reads the row on every
dispatch — see `apps/agent/src/notifications/channels/tts.ts` for the
resolution order.

Fallback: drop the bare env var into the systemd user environment via
`~/.config/systemd/user/nexus-agent.service.d/override.conf` so the
secret survives reboot:

```ini
[Service]
Environment="ELEVENLABS_API_KEY=sk_..."
Environment="NEXUS_ATTACH_SECRET=..."
```

`systemctl --user daemon-reload && systemctl --user restart nexus-agent`.

### Mac side

The listener reads `NEXUS_ATTACH_SECRET` from `~/.env` on startup
(launched via `set -a; . ~/.env; set +a` so plain `KEY=value` lines
work). Drop it once:

```bash
echo 'NEXUS_ATTACH_SECRET=...' >> ~/.env
chmod 600 ~/.env
```

Restart the listener: `launchctl unload && launchctl load
~/Library/LaunchAgents/com.nexus.notifier.plist`.

Do not put `ELEVENLABS_API_KEY` on the Mac. The Mac never calls
ElevenLabs directly — every byte of audio comes pre-synthesized over
the SSE stream as `payload.audioBase64`.

## Dashboard hooks (suppression UI)

`deploy/com.nexus.notifier.plist` declares three env vars that seed the
listener's settings cache before the on-startup GET to
`/notifications/settings` populates real values:

| Var               | Default | Effect                                                       |
| ----------------- | ------- | ------------------------------------------------------------ |
| `TTS_ENABLED`     | `1`     | `false`/`0` short-circuits both afplay and the say-fallback. |
| `BANNER_ENABLED`  | `1`     | `false` short-circuits the osascript/terminal-notifier call. |
| `DUCKING_MODE`    | `none`  | `half` lowers volume to 25, `mute` mutes; restored after.    |

Live updates flow through the SSE `SettingsChanged` event — the listener
mutates its cache in place, no restart required. The plist values matter
only for the brief window between launchctl load and the bootstrap GET
landing.
