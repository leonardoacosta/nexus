# Nexus Deploy

Operator notes for shipping nexus to a homelab Linux host and a Mac
listener. Everything here is shell scripts and plists — there's no
container runtime, no Kubernetes, no Terraform required for the runtime
path. (Networking and Cloudflare DNS are managed separately, out of
scope for this README.)

## Layout

```
deploy/
├── install.sh                    # entry point — Linux install + --mac shipping
├── nexus-agent.service           # systemd user unit (Linux agent)
├── com.nexus.agent.plist         # legacy launchd unit (Mac agent — rarely used)
├── nexus-notifier.sh             # legacy say(1)+FIFO listener (existing prod)
├── com.nexus.notifier.plist      # legacy plist for the say(1) listener
├── com.nexus.tts-player.plist    # legacy drain worker for the FIFO
├── mac/                          # NEW — restore-tts-mac-audio-dispatch (afplay+audioBase64)
│   ├── nexus-notifier.sh
│   └── com.nexus.notifier.plist
├── traefik/                      # dashboard reverse-proxy config
└── hooks/                        # git-hook dispatchers for spec-aware automation
```

The `mac/` subdirectory is the canonical Mac listener going forward. The
legacy `deploy/nexus-notifier.sh` (say + FIFO) stays in-tree until the
existing host has been migrated; remove only after Leo confirms the
afplay-based listener has been live for at least one full work day.

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
arrives without `audioBase64` (the agent ran in signal-only mode — no
key, or the upstream call failed), the listener falls back to
`/usr/bin/say` with the body text.

Ship the listener from the Linux side:

```bash
# One-shot, with the Mac host as a positional arg:
deploy/install.sh --mac mac.tail-scale-net.ts.net

# Or set MAC_HOST in your shell:
MAC_HOST=mac.tail-scale-net.ts.net deploy/install.sh --mac
```

The `--mac` branch:

1. SSH-preflights `~/bin`, `~/Library/LaunchAgents`, and `~/Library/Logs`.
2. `scp`s `deploy/mac/nexus-notifier.sh` to `~/bin/nexus-notifier.sh`
   (chmod +x).
3. `scp`s `deploy/mac/com.nexus.notifier.plist` to
   `~/Library/LaunchAgents/com.nexus.notifier.plist`.
4. Runs `launchctl unload && launchctl load` to bootstrap the listener.

Verify the listener is healthy:

```bash
ssh mac 'launchctl list | grep com.nexus.notifier'
ssh mac 'tail -f ~/Library/Logs/nexus-notifier.log'
```

Override the Mac SSH user with `MAC_USER` if it differs from your local
`$USER`.

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

## Wave 2 hooks (suppression UI)

`deploy/mac/nexus-notifier.sh` declares three placeholder env vars that
the dashboard spec will populate:

| Var               | Default | Effect                                                       |
| ----------------- | ------- | ------------------------------------------------------------ |
| `TTS_ENABLED`     | `1`     | `0` short-circuits both afplay and the say-fallback path.    |
| `BANNER_ENABLED`  | `1`     | Reserved for the dashboard banner pipeline (no-op today).    |
| `DUCKING_MODE`    | `none`  | Reserved for the AVAudioSession ducking work in Wave 2.      |

The plist's `<EnvironmentVariables>` stanza is the surface the dashboard
will mutate — see `restore-tts-mac-audio-dispatch/proposal.md` § Wave 2.

## Migration: legacy say(1) listener → afplay listener

Today's production Mac runs the legacy
`~/bin/nexus-notifier.sh` (say + FIFO) installed manually. The
canonical replacement lives in `deploy/mac/`. Migration steps (do these
on the Mac, not via SSH from the Linux side, so launchctl can attach to
your GUI session):

```bash
# 1. Unload the legacy listener + drain worker.
launchctl unload ~/Library/LaunchAgents/com.nexus.notifier.plist
launchctl unload ~/Library/LaunchAgents/com.nexus.tts-player.plist 2>/dev/null || true

# 2. Remove the legacy script + plists. (Keep ~/.env.)
rm ~/bin/nexus-notifier.sh
rm ~/Library/LaunchAgents/com.nexus.notifier.plist
rm ~/Library/LaunchAgents/com.nexus.tts-player.plist 2>/dev/null || true

# 3. Run the canonical install from the Linux host:
ssh homelab 'cd ~/dev/nx && deploy/install.sh --mac mac.tail-scale-net.ts.net'

# 4. Verify the new listener is consuming SSE frames:
tail -f ~/Library/Logs/nexus-notifier.log
```
