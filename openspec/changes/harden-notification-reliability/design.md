## Context

The Nexus notification subsystem spans two runtimes: a Rust `nexus-agent` daemon (axum,
tokio) and a TypeScript Bun overlay (`apps/agent`). The 2026-04-06 platform audit produced
12 findings — two P1 blocking hazards, five P2 reliability gaps, and five P3 quality items.
This design records the key technical decisions so implementation is unambiguous.

## Goals / Non-Goals

- **Goals:** Eliminate indefinite blocking in the Rust receiver; add retry and config safety
  in the Rust notification engine; add parallel delivery, partial-success reporting,
  deduplication, and thread-safety in the TypeScript layer; redact PII from logs; validate
  input; persist buffer metadata.
- **Non-Goals:** Changing the external HTTP API surface or adding new delivery channels.
  Persistent retry queues (disk-backed) are out of scope; in-memory retry is sufficient.

## Decisions

### D1 — Request and Socket Timeouts (Rust)

**Decision:** Wrap both `handle_request` and `speak_from_socket` independently with
`tokio::time::timeout(Duration::from_secs(5), ...)`.

**Pattern:**

```rust
// handle_request — returns 504 on timeout
match tokio::time::timeout(Duration::from_secs(5), self.dispatch(req)).await {
    Ok(result) => result,
    Err(_elapsed) => {
        tracing::error!("handle_request timed out");
        (StatusCode::GATEWAY_TIMEOUT, Json(json!({ "error": "timeout" })))
    }
}

// speak_from_socket — propagates Err on timeout
tokio::time::timeout(Duration::from_secs(5), http_client.post(url).send())
    .await
    .map_err(|_| anyhow::anyhow!("speak_from_socket timed out"))?
```

**Why 5 seconds:** TTS HTTP calls are local-network or loopback; 5 s is generous for
legitimate calls and tight enough to prevent indefinite blocking during a network partition.

**Alternatives considered:**
- Configurable timeout via `agents.toml` — rejected for this change; adds surface area
  without clear need. Can be added later.
- Single timeout wrapping both — rejected; `handle_request` and `speak_from_socket` have
  independent call paths; a single outer timeout would not cover the socket path.

### D2 — Exponential Backoff Retry (Rust, notification_engine.rs)

**Decision:** Implement retry inline using a loop with `tokio::time::sleep`; avoid adding
`tokio-retry` as a dependency unless the pattern proves reusable.

**Pattern:**

```rust
const MAX_ATTEMPTS: u32 = 3;
const BASE_MS: u64 = 500;
const MAX_MS: u64 = 4_000;

let mut attempt = 0u32;
loop {
    match deliver_tts(&req).await {
        Ok(v) => break Ok(v),
        Err(e) if attempt + 1 < MAX_ATTEMPTS => {
            let delay_ms = (BASE_MS * 2u64.pow(attempt)).min(MAX_MS);
            // ±10% jitter
            let jitter = (delay_ms as f64 * 0.1 * (rand::random::<f64>() * 2.0 - 1.0)) as i64;
            let sleep_ms = (delay_ms as i64 + jitter).max(1) as u64;
            tracing::warn!(attempt, sleep_ms, "TTS delivery failed, retrying");
            tokio::time::sleep(Duration::from_millis(sleep_ms)).await;
            attempt += 1;
        }
        Err(e) => break Err(e),
    }
}
```

**Alternatives considered:**
- `tokio-retry` crate — deferred; adds a dependency; inline loop is < 20 lines.
- Fixed delay — rejected; exponential backoff prevents thundering herd.

### D3 — Config Reload Guard (Rust, notification_engine.rs)

**Decision:** Parse the new config into a temporary `Config` value before touching the live
reference. On parse error, retain the previous valid config and log a redacted error.

**Pattern:**

```rust
match toml::from_str::<Config>(&new_content) {
    Ok(new_cfg) => {
        *self.config.write().await = new_cfg;
        tracing::info!("config reloaded successfully");
    }
    Err(e) => {
        tracing::error!(error = %redact(&e.to_string()), "config reload failed; retaining previous config");
    }
}
```

**Alternatives considered:**
- Crash and restart — rejected; too disruptive for a config typo.
- Silent ignore — rejected; the error must be logged so operators notice.

### D4 — Parallel Channel Delivery with Partial Success (TypeScript, manager.ts)

**Decision:** Replace the sequential `for` loop with `Promise.allSettled` so all channels
are attempted in parallel and individual failures are isolated.

**Pattern:**

```typescript
const results = await Promise.allSettled(
  channels.map(ch => ch.deliver(msg))
);

const delivered: string[] = [];
const failed: string[] = [];
for (const [i, r] of results.entries()) {
  if (r.status === "fulfilled") delivered.push(channels[i].name);
  else {
    failed.push(channels[i].name);
    logger.error({ channel: channels[i].name, err: r.reason }, "channel delivery failed");
  }
}
return { delivered, failed };
```

**Why `allSettled` over `all`:** `Promise.all` short-circuits on the first rejection,
which is the current broken behavior. `allSettled` always settles all promises.

**Alternatives considered:**
- `Promise.all` with individual try/catch inside each channel — valid, but moves error
  isolation into each channel implementation; `allSettled` centralizes it in the manager.

### D5 — Thread-Safe Singleton Reset (TypeScript, notifications.ts)

**Decision:** Guard the singleton reference with an `AsyncMutex` from the `async-mutex`
package (already available in Bun environments).

**Pattern:**

```typescript
import { Mutex } from "async-mutex";

let _instance: NotificationManager | null = null;
const _mutex = new Mutex();

export async function getInstance(): Promise<NotificationManager> {
  return _mutex.runExclusive(() => {
    if (!_instance) _instance = new NotificationManager();
    return _instance;
  });
}

export async function reset(): Promise<void> {
  return _mutex.runExclusive(() => {
    _instance = null;
  });
}
```

**Alternatives considered:**
- Atomic swap via a shared `SharedArrayBuffer` — overly complex for this use case.
- Removing the singleton entirely — desirable long-term but out of scope for this change.

### D6 — Deduplication by Content Hash (TypeScript, routes/notifications.ts)

**Decision:** Compute `sha256(message + "|" + target)` truncated to hex-16 chars as the
dedup key. Store keys in a `Map<string, number>` (key → expiry epoch ms). Check and evict
on each incoming request.

**Pattern:**

```typescript
import { createHash } from "node:crypto";

const dedupMap = new Map<string, number>();
const DEDUP_TTL_MS = 5_000;

function isDuplicate(message: string, target: string): boolean {
  const key = createHash("sha256")
    .update(`${message}|${target}`)
    .digest("hex")
    .slice(0, 16);
  const now = Date.now();
  // evict expired
  for (const [k, exp] of dedupMap) {
    if (exp < now) dedupMap.delete(k);
  }
  if (dedupMap.has(key)) return true;
  dedupMap.set(key, now + DEDUP_TTL_MS);
  return false;
}
```

**Why truncate to 16 chars:** Collision risk is negligible (2^64) for the volume of
notifications in this system; it keeps the map keys compact.

**Alternatives considered:**
- Full SHA-256 — functionally identical, marginally larger memory footprint.
- Redis TTL set — out of scope; no Redis dependency in the agent.

### D7 — PII Redaction (Rust, notification_engine.rs)

**Decision:** Implement `redact(s: &str) -> String` using compiled regex patterns for
email addresses, URLs (http/https/ftp), and absolute filesystem paths (`/…` sequences).

```rust
fn redact(s: &str) -> String {
    use once_cell::sync::Lazy;
    use regex::Regex;
    static EMAIL: Lazy<Regex> = Lazy::new(|| Regex::new(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}").unwrap());
    static URL:   Lazy<Regex> = Lazy::new(|| Regex::new(r"https?://\S+").unwrap());
    static PATH:  Lazy<Regex> = Lazy::new(|| Regex::new(r"/(?:[a-zA-Z0-9._-]+/)+[a-zA-Z0-9._-]*").unwrap());
    let s = EMAIL.replace_all(s, "[REDACTED_EMAIL]");
    let s = URL.replace_all(&s, "[REDACTED_URL]");
    PATH.replace_all(&s, "[REDACTED_PATH]").into_owned()
}
```

**Why `once_cell::sync::Lazy`:** Avoids recompiling regexes on every call; `once_cell` is
already a transitive dependency via `axum`.

### D8 — Notification Validation (line 136)

**Decision:** Validate at the route handler boundary before the payload reaches the engine.
Return HTTP 400 with a structured error body; do not log the rejected payload (avoids PII
in logs at the entry point).

```rust
if notification.message.is_empty() {
    return (StatusCode::BAD_REQUEST, Json(json!({ "error": "validation", "detail": "message is empty" }))).into_response();
}
if notification.message.len() > 500 {
    return (StatusCode::BAD_REQUEST, Json(json!({ "error": "validation", "detail": "message exceeds 500 characters" }))).into_response();
}
```

### D9 — Buffer Metadata Persistence (TypeScript, buffer.ts)

**Decision:** Write a JSON sidecar file (`~/.config/nexus/buffer-meta.json`) on every
mutation. Read it on startup if present; ignore read errors gracefully (fresh state).

**Format:**

```json
{ "count": 42, "watermark": 1000, "lastFlushMs": 1712345678000 }
```

**Alternatives considered:**
- SQLite row for buffer state — more durable but adds a DB dependency to the buffer module.
- In-memory only — current behavior; loses state on restart, which the audit flagged.

## Risks / Trade-offs

- **Parallel delivery race:** `Promise.allSettled` runs channels concurrently. If channels
  share mutable state (e.g., a shared rate limiter), concurrent access must be considered.
  Mitigation: each channel is stateless in the current implementation.
- **Dedup map memory:** Under extremely high notification volume, the map could grow. The
  eviction-on-lookup strategy bounds it to entries within the 5-second window. At 1000
  notifications/second (far above current load), this is ~5000 entries ≈ 1 MB.
- **Regex performance in `redact`:** Called on every error log. `Lazy` compilation amortizes
  cost; all patterns are O(n) in message length.
- **`async-mutex` dependency:** Adds one small TS dependency. Alternative: use a boolean
  flag + microtask queue, but that is fragile.

## Migration Plan

All changes are backward-compatible at the HTTP API level. No schema migrations required.
Buffer metadata sidecar is created fresh on first run; absence is handled gracefully.
Config reload behavior change is observable via logs only — no config file format changes.

## Open Questions

- Should the dedup TTL (5 s) be configurable via `agents.toml`? Currently hardcoded.
  Low urgency; can be addressed in a follow-up change.
- Should `retry_with_backoff` become a shared utility in `nexus-core`? Deferred until a
  second call site exists.
