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
├── hooks/                        # git-hook dispatchers for spec-aware automation
└── hooks.d/post-merge/02-deploy  # rebuilds + fans out to every Mac in agents.toml
```

The Mac side is now owned by the Swift app at `/Applications/Nexus.app`
(`com.nexus.menubar`) — it subscribes to the agent's SSE stream and owns
TTS dispatch + banner-click cancel natively. The previous bash listener
(`deploy/nexus-notifier.sh`) and its launchd plists were retired in
spine-migration wave 6.

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

## Mac listener install (audio dispatch side)

The Mac listener is the Swift app at `/Applications/Nexus.app`
(`com.nexus.menubar`). It subscribes to the agent's `/events/stream` SSE
endpoint and owns TTS dispatch (ElevenLabs synthesis + playback) and
banner-click cancel natively — no bash scripts, no FIFOs, no drain workers.

**Mac install is automatic via the post-merge hook.** When you push to
`main` (or pull on the Linux host), `deploy/hooks.d/post-merge/02-deploy`
fans out to every entry in `~/.config/nexus/agents.toml` whose `host` is
not `localhost`/`127.0.0.1`, runs `git pull --ff-only`, and rebuilds the
agent. The Swift dashboard ships separately via the Xcode archive flow.

## Secret provisioning

| Secret                  | Where it lives                | Why                                                  |
| ----------------------- | ----------------------------- | ---------------------------------------------------- |
| `ELEVENLABS_API_KEY`    | Linux agent only (DB or env)  | The agent synthesizes; the Mac just plays bytes.     |
| `ELEVENLABS_VOICE_ID`   | Linux agent only (optional)   | Defaults to `21m00Tcm4TlvDq8ikWAM` if unset.         |

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
```

`systemctl --user daemon-reload && systemctl --user restart nexus-agent`.

### Mac side

The listener no longer reads any auth secret — the agent's REST/SSE
endpoints are loopback + Tailscale-bound and require no header
(`drop-attach-secret-gate`). If the listener is already installed it
will keep working after a `git pull` + relaunch with no extra
provisioning step.

Do not put `ELEVENLABS_API_KEY` on the Mac. The Mac never calls
ElevenLabs directly — every byte of audio comes pre-synthesized over
the SSE stream as `payload.audioBase64`.

## Dashboard hooks (suppression UI)

Notification settings (`TTS_ENABLED`, `BANNER_ENABLED`, `DUCKING_MODE`) are
read by the Swift dashboard from the agent's `/notifications/settings`
endpoint on startup, then kept live via the SSE `SettingsChanged` event.
There are no longer any plist-level env-var seeds — the Swift app holds
defaults internally and overlays remote settings as they arrive.
