#!/usr/bin/env bun
/**
 * nexus-listener — full Mac-side SSE consumer for nexus-agent.
 *
 * Replaces `nexus-notifier.sh listen` mode. The bash `drain` mode is
 * still used for FIFO-serialised `say` fallback playback.
 *
 * Why this exists (2026-05-16):
 *   bash 3.2 (macOS default) + `done < <(curl ...)` has a lifecycle bug
 *   where the parent shell can hang waiting on a dead process-sub
 *   subshell after curl dies. `curl ... | while read` works for the
 *   pipeline but suffers from intermittent silent-subscriber drops where
 *   bytes flow to one subscriber but not another. Hybrid bash+bun pipe
 *   approaches hit pipe-buffering and EPIPE-on-stale-FD issues.
 *
 *   Bun's native fetch + ReadableStream has none of these issues. This
 *   is the same architecture as the original Bun listener decommissioned
 *   in spec `consolidate-mac-tts-listener` — the consolidation was
 *   wrong and is being reversed.
 *
 * Scope: SSE consumer + banner dispatch + audio dispatch. The bash
 * `drain` worker stays as-is — listener writes to the FIFO for say
 * fallback, and writes pid to current-utterance.pid for banner-click
 * cancel.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  writeFileSync,
  truncateSync,
  chmodSync,
} from "node:fs";
import { homedir } from "node:os";

const HOME = homedir();
const NEXUS_URL = process.env.NEXUS_URL ?? "http://localhost:7400";
const LOG_FILE = process.env.NEXUS_NOTIFIER_LOG ?? `${HOME}/Library/Logs/nexus-notifier.log`;
const FIFO_PATH =
  process.env.NEXUS_NOTIFIER_FIFO ??
  `${HOME}/Library/Application Support/nexus/tts-queue.fifo`;
const PID_FILE =
  process.env.NEXUS_PID_FILE ??
  `${HOME}/Library/Application Support/nexus/current-utterance.pid`;
const ICON_CACHE_DIR = `${HOME}/Library/Application Support/nexus/icons`;
const STREAM_MAX_MS = 30 * 60 * 1000;
const RECONNECT_DELAY_MS = 5_000;
const DEDUP_WINDOW_S = Number(process.env.NEXUS_NOTIFIER_DEDUP_WINDOW ?? 30);

// Cached settings — bootstrapped via GET and mutated by SettingsChanged.
let TTS_ENABLED = true;
let BANNER_ENABLED = true;
let DUCKING_MODE: "full" | "half" | "mute" = "full";

// Dedup state — survives across reconnects within a single process.
let LAST_DEDUP_ID = "";
let LAST_DEDUP_TS = 0;

let shuttingDown = false;
process.on("SIGTERM", () => { shuttingDown = true; });
process.on("SIGINT",  () => { shuttingDown = true; });

const TERMINAL_NOTIFIER_PATHS = [
  "/opt/homebrew/bin/terminal-notifier",
  "/usr/local/bin/terminal-notifier",
];
const TERMINAL_NOTIFIER = TERMINAL_NOTIFIER_PATHS.find(existsSync) ?? null;

function log(msg: string): void {
  const line = `[${new Date().toString().split(" GMT")[0]}] ${msg}\n`;
  try { appendFileSync(LOG_FILE, line); } catch { /* disk full */ }
}

function writePidAtomic(pid: number): void {
  try {
    writeFileSync(`${PID_FILE}.tmp`, String(pid));
    renameSync(`${PID_FILE}.tmp`, PID_FILE);
  } catch { /* disk full */ }
}

function clearPid(): void {
  try { truncateSync(PID_FILE, 0); } catch { /* missing */ }
}

function readActivePid(): number | null {
  try {
    const data = require("node:fs").readFileSync(PID_FILE, "utf8").trim();
    if (!/^\d+$/.test(data)) return null;
    const n = Number(data);
    return n > 0 ? n : null;
  } catch { return null; }
}

function ensurePidFile(): void {
  const dir = `${HOME}/Library/Application Support/nexus`;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(PID_FILE)) {
    writeFileSync(PID_FILE, "");
    chmodSync(PID_FILE, 0o600);
  }
}

function shouldSkipDup(id: string): boolean {
  if (!id) return false;
  const now = Math.floor(Date.now() / 1000);
  if (id === LAST_DEDUP_ID && now - LAST_DEDUP_TS < DEDUP_WINDOW_S) return true;
  LAST_DEDUP_ID = id;
  LAST_DEDUP_TS = now;
  return false;
}

// ─── Ducking ────────────────────────────────────────────────────────────────
let savedVolume = "";
let savedMuted = "";

function applyDucking(): void {
  savedVolume = "";
  savedMuted = "";
  if (DUCKING_MODE === "half") {
    const r = spawnSync("/usr/bin/osascript", ["-e", "output volume of (get volume settings)"]);
    savedVolume = r.stdout.toString().trim();
    spawnSync("/usr/bin/osascript", ["-e", "set volume output volume 25"]);
  } else if (DUCKING_MODE === "mute") {
    const r = spawnSync("/usr/bin/osascript", ["-e", "output muted of (get volume settings)"]);
    savedMuted = r.stdout.toString().trim();
    spawnSync("/usr/bin/osascript", ["-e", "set volume with output muted"]);
  }
}

function restoreDucking(): void {
  if (savedVolume) {
    spawnSync("/usr/bin/osascript", ["-e", `set volume output volume ${savedVolume}`]);
    savedVolume = "";
  }
  if (savedMuted === "false") {
    spawnSync("/usr/bin/osascript", ["-e", "set volume without output muted"]);
  }
  savedMuted = "";
}

// ─── Audio dispatch ─────────────────────────────────────────────────────────
//
// In-process serial queue. afplay (ElevenLabs mp3) and say (fallback) both
// run as children of this Bun process so the pid is captured synchronously
// — the banner dispatched right after this returns can pass that pid to
// terminal-notifier's -execute for click-to-cancel. The earlier
// FIFO-handoff-to-bash-drain pattern had an unfixable cross-process race
// where the drain hadn't spawned say yet when banner read the pid file.
//
// Serial playback: one child at a time, queue while busy. Mirrors the
// original Bun listener's design. Avoids the N-overlapping-`say`-procs
// problem the bash FIFO+drain was originally built to solve.
const audioQueue: string[] = [];
let audioBusy = false;

function startNextAudio(): number {
  if (audioBusy || audioQueue.length === 0 || !TTS_ENABLED) return 0;
  audioBusy = true;
  const body = audioQueue.shift()!;
  applyDucking();
  const child = spawn("/usr/bin/say", ["--", body], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  const pid = child.pid ?? 0;
  if (pid) writePidAtomic(pid);
  // 60s cap per utterance — wedged audio device cannot stall queue.
  const cap = setTimeout(() => child.kill("SIGTERM"), 60_000);
  child.on("exit", () => {
    clearTimeout(cap);
    clearPid();
    restoreDucking();
    audioBusy = false;
    // Pump next queued body if any.
    if (audioQueue.length > 0) startNextAudio();
  });
  return pid;
}

function dispatchAudio(audioB64: string, body: string): number {
  if (!TTS_ENABLED) {
    log(`tts suppressed (tts_enabled=false) body="${body}"`);
    return 0;
  }
  if (!audioB64) {
    // No pre-synthesized mp3 — use say. Queue + start synchronously so
    // the banner dispatched right after can grab the active pid.
    audioQueue.push(body);
    const pid = startNextAudio();
    log(`say scheduled pid=${pid} ducking=${DUCKING_MODE}`);
    return pid;
  }
  // ElevenLabs mp3 path: decode + afplay (also in-process, queues alongside say).
  applyDucking();
  const tmp = `/tmp/nexus-listener-${crypto.randomUUID()}.mp3`;
  try {
    writeFileSync(tmp, Buffer.from(audioB64, "base64"));
  } catch (e) {
    log(`base64 decode failed: ${e instanceof Error ? e.message : String(e)}`);
    restoreDucking();
    return 0;
  }
  const child = spawn("/usr/bin/afplay", [tmp], { stdio: ["ignore", "ignore", "ignore"] });
  const pid = child.pid ?? 0;
  if (pid) writePidAtomic(pid);
  log(`afplay scheduled pid=${pid} path=${tmp} ducking=${DUCKING_MODE}`);
  child.on("exit", () => {
    clearPid();
    try { require("node:fs").unlinkSync(tmp); } catch { /* gone */ }
    restoreDucking();
  });
  return pid;
}

// ─── Banner dispatch ────────────────────────────────────────────────────────
function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function leadingEmoji(title: string): string {
  const first = title.split(" ")[0] ?? "";
  // crude emoji detect: any codepoint above 0x1f300 OR known emoji ranges
  for (const ch of first) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp > 0x1f000 || (cp >= 0x2600 && cp <= 0x27bf)) return first;
  }
  return "";
}

function dispatchBanner(title: string, body: string, project: string): void {
  if (!BANNER_ENABLED) {
    log(`banner suppressed (banner_enabled=false) title="${title}"`);
    return;
  }

  const activePid = readActivePid();

  if (TERMINAL_NOTIFIER) {
    const args = ["-title", title, "-message", body];
    // Bundle-per-project — call bundle manager if available.
    const bundleMgr = `${HOME}/bin/nexus-bundle-manager.sh`;
    if (existsSync(bundleMgr)) {
      const emoji = leadingEmoji(title);
      const name = emoji && title.startsWith(emoji + " ") ? title.slice(emoji.length + 1) : "";
      let bundleId = "";
      if (project && emoji && name) {
        const r = spawnSync(bundleMgr, ["ensure", project, emoji, name]);
        bundleId = r.stdout.toString().trim();
      }
      if (!bundleId) {
        const r = spawnSync(bundleMgr, ["ensure-default"]);
        bundleId = r.stdout.toString().trim();
      }
      if (bundleId) args.push("-sender", bundleId);
    }
    if (activePid) args.push("-execute", `/bin/kill -TERM ${activePid}`);
    spawn(TERMINAL_NOTIFIER, args, { stdio: ["ignore", "ignore", "ignore"] });
    return;
  }

  // Fallback: osascript display notification (no click handler support).
  const escTitle = escapeAppleScript(title);
  const escBody = escapeAppleScript(body);
  spawn("/usr/bin/osascript", ["-e", `display notification "${escBody}" with title "${escTitle}"`], {
    stdio: ["ignore", "ignore", "ignore"],
  });
}

// ─── Event router ───────────────────────────────────────────────────────────
interface NotificationPayload {
  id?: string;
  title?: string;
  body?: string;
  message?: string;
  channel?: string;
  project?: string;
  audioBase64?: string;
}

function processNotification(payload: NotificationPayload): void {
  const id = payload.id ?? "";
  const title = payload.title ?? payload.project ?? "Claude Code";
  const body = payload.body ?? payload.message ?? "";
  const channel = (payload.channel ?? "").trim();
  const project = payload.project ?? "";
  const audioB64 = payload.audioBase64 ?? "";

  if (!body) return;
  if (shouldSkipDup(id)) {
    log(`dedup skipped id=${id}`);
    return;
  }

  // Audio MUST run before banner so the pid file is populated and the
  // banner-click cancel target points at the active utterance.
  switch (channel) {
    case "desktop":
    case "banner":
      dispatchBanner(title, body, project);
      log(`banner: [${title}] ${body}`);
      break;
    case "tts":
      dispatchAudio(audioB64, body);
      dispatchBanner(title, body, project);
      log(`tts+banner: [${title}] ${body}`);
      break;
    case "":
    case "slack":
      // silent
      break;
    default:
      if (channel.includes("tts") || channel.includes("desktop")) {
        if (channel.includes("tts")) dispatchAudio(audioB64, body);
        dispatchBanner(title, body, project);
        log(`both: [${title}] ${body}`);
      } else {
        log(`unknown channel: ${channel}`);
      }
  }
}

function processSettings(payload: Record<string, unknown>): void {
  const t = payload.ttsEnabled ?? payload.tts_enabled;
  const b = payload.bannerEnabled ?? payload.banner_enabled;
  const d = payload.duckingMode ?? payload.ducking_mode;
  if (typeof t === "boolean") TTS_ENABLED = t;
  if (typeof b === "boolean") BANNER_ENABLED = b;
  if (d === "full" || d === "half" || d === "mute") DUCKING_MODE = d;
  log(`SettingsChanged applied tts=${TTS_ENABLED} banner=${BANNER_ENABLED} ducking=${DUCKING_MODE}`);
}

// ─── Bootstrap + stream loop ────────────────────────────────────────────────
async function bootstrapSettings(): Promise<void> {
  try {
    const r = await fetch(`${NEXUS_URL}/notifications/settings`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!r.ok) {
      log(`settings GET failed (http=${r.status}); using defaults`);
      return;
    }
    const s = (await r.json()) as Record<string, unknown>;
    processSettings(s);
  } catch (e) {
    log(`settings bootstrap error (${e instanceof Error ? e.message : String(e)}); using defaults`);
  }
}

async function streamOnce(): Promise<void> {
  const ctl = new AbortController();
  const cap = setTimeout(() => ctl.abort("max-time"), STREAM_MAX_MS);
  try {
    const res = await fetch(`${NEXUS_URL}/events/stream`, {
      headers: { Accept: "text/event-stream" },
      signal: ctl.signal,
    });
    if (!res.ok || !res.body) {
      log(`stream: HTTP ${res.status}`);
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let eventName = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const raw of lines) {
        const line = raw.replace(/\r$/, "");
        if (line.startsWith("event: ")) {
          eventName = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (eventName === "NotificationFired") {
            try {
              const parsed = JSON.parse(data) as { payload?: NotificationPayload };
              if (parsed.payload) processNotification(parsed.payload);
            } catch (e) {
              log(`parse error: ${e instanceof Error ? e.message : String(e)}`);
            }
          } else if (eventName === "SettingsChanged") {
            try {
              const parsed = JSON.parse(data) as { payload?: Record<string, unknown> };
              if (parsed.payload) processSettings(parsed.payload);
            } catch { /* swallow */ }
          }
          eventName = "";
        } else if (line === "") {
          eventName = "";
        }
      }
    }
  } catch (e) {
    log(`stream error: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(cap);
  }
}

async function main(): Promise<void> {
  ensurePidFile();
  await bootstrapSettings();
  log(`nexus-listener starting — url=${NEXUS_URL} fifo=${FIFO_PATH} pidfile=${PID_FILE} tts=${TTS_ENABLED} banner=${BANNER_ENABLED} ducking=${DUCKING_MODE}`);
  if (!TERMINAL_NOTIFIER) {
    log(`terminal-notifier not found; banner-click cancel disabled (osascript fallback)`);
  }
  while (!shuttingDown) {
    await streamOnce();
    if (shuttingDown) break;
    log(`stream disconnected, reconnecting in ${RECONNECT_DELAY_MS / 1000}s`);
    await new Promise((r) => setTimeout(r, RECONNECT_DELAY_MS));
  }
  log(`nexus-listener exiting`);
}

main().catch((e) => {
  log(`fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
