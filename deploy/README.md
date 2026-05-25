# Nexus Deploy

Operator notes for shipping nexus to a homelab Linux host and a Mac
listener. Everything here is shell scripts and plists — there's no
container runtime, no Kubernetes, no Terraform required for the runtime
path. (Networking and Cloudflare DNS are managed separately, out of
scope for this README.)

## Layout

```
deploy/
├── install.sh                       # entry point — Linux install (agent + git hooks + self-deploy timer)
├── nexus-agent.service              # systemd user unit (Linux agent)
├── deploy-homelab.sh                # homelab self-deploy: pull origin/main, build, restart, verify, roll back
├── nexus-homelab-deploy.service     # systemd --user oneshot that runs the self-deploy script
├── nexus-homelab-deploy.timer       # systemd --user timer (OnBootSec=2min, OnUnitActiveSec=2min)
├── hooks/                           # git-hook dispatchers for spec-aware automation
└── hooks.d/post-merge/02-deploy     # rebuilds + fans out to every Mac in agents.toml
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

### Homelab auto-deploy (self-deploy timer)

The homelab is the PRIMARY agent host and pulls its own updates on a
systemd `--user` timer — no manual `git pull`, no Mac-side post-push
coupling. `deploy/install.sh` (Linux branch) installs this automatically;
to (re)provision the timer alone without rebuilding the agent:

```bash
deploy/install.sh --homelab-deploy
```

This drops `deploy/deploy-homelab.sh` at the STABLE path
`~/.local/bin/nexus-homelab-deploy` (deliberately decoupled from the repo
checkout so the timer can run while the repo is mid-pull), installs the
`nexus-homelab-deploy.{service,timer}` units, and enables the timer
(`OnBootSec=2min`, `OnUnitActiveSec=2min`, `Persistent=true`).

On each tick the script:

1. `git fetch origin main`. If `HEAD == origin/main`, logs "already up to
   date" and exits 0 — a cheap no-op (no rebuild, no restart).
2. If behind: backs up the current `nexus-agent` binary, then
   `git pull --ff-only`. The pull fires the existing post-merge hooks
   (`02-deploy` rebuilds + installs + restarts the agent;
   `03-migrate` runs `db:migrate` if `packages/db/` changed). The build is
   fail-fast BEFORE the running binary is overwritten, so a broken build
   can never corrupt the live agent.
3. Health-checks the restarted agent (`systemctl --user is-active` AND
   `HTTP 200` on `http://127.0.0.1:7400/sessions`, with retries to absorb
   the post-restart Tailscale-IP probe).
4. On health failure: restores the backed-up binary, restarts the agent,
   re-checks, and exits non-zero. The agent is NEVER left down.

Inspect:

```bash
systemctl --user status nexus-homelab-deploy.timer
journalctl --user -u nexus-homelab-deploy.service -f   # timestamped deploy log
systemctl --user list-timers nexus-homelab-deploy.timer
```

Force an immediate deploy (bypass the timer):

```bash
systemctl --user start nexus-homelab-deploy.service
# or run the script directly:
~/.local/bin/nexus-homelab-deploy
```

Overridable env (for non-default layouts): `NX_REPO`, `NX_BIN_DIR`,
`NX_AGENT_URL`, `NX_SERVICE`.

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
