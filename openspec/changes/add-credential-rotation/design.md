# Design: Auto Credential Rotation

## Architecture

```
                    ~/.config/nexus/credentials/
                    ├── acct-personal.json
                    ├── acct-work.json
                    └── acct-team.json
                              │
                    ┌─────────▼──────────┐
                    │  CredentialPool     │
                    │  Service            │
                    │                     │
                    │  • file watcher     │
                    │  • token parser     │
                    │  • usage poller     │◄── Anthropic /api/oauth/usage
                    │  • cache persist    │──► ~/.config/nexus/state/usage-cache.json
                    │  • best_available() │
                    └─────────┬──────────┘
                              │
              ┌───────────────┼───────────────┐
              │               │               │
    ┌─────────▼────┐  ┌──────▼──────┐  ┌─────▼──────────┐
    │ RateLimitInt- │  │ Symlink     │  │ Exhaustion     │
    │ erceptor     │  │ Swapper     │  │ Handler        │
    │              │  │             │  │                │
    │ • socket evt │  │ • atomic    │  │ • all-exhaust  │
    │   intercept  │  │   swap of   │  │   notification │
    │ • debounce   │  │   symlink   │  │ • next-avail   │
    │   window     │  │ • verify    │  │   calculation  │
    │ • trigger    │  │             │  │                │
    │   rotation   │  │             │  │                │
    └──────────────┘  └─────────────┘  └────────────────┘
              │
    ┌─────────▼────┐
    │ dispatch.rs  │
    │ tmux send-   │
    │ keys         │
    │ "continue"   │
    └──────────────┘
```

## Data Model

### CredentialAccount (nexus-core)
```rust
pub struct CredentialAccount {
    pub name: String,                    // derived from filename: "acct-personal" → "personal"
    pub path: PathBuf,                   // ~/.config/nexus/credentials/acct-personal.json
    pub access_token: String,            // parsed from file
    pub expires_at: Option<DateTime<Utc>>,
    pub usage: Option<AccountUsage>,     // populated by poller
    pub last_polled: Option<DateTime<Utc>>,
}

pub struct AccountUsage {
    pub five_hour: UsageWindow,
    pub seven_day: UsageWindow,
}

pub struct UsageWindow {
    pub utilization: f32,               // 0.0 to 1.0
    pub resets_at: DateTime<Utc>,
}
```

### Usage Cache (persisted JSON)
```json
{
  "accounts": {
    "personal": {
      "five_hour": { "utilization": 0.45, "resets_at": "2026-03-31T19:15:00Z" },
      "seven_day": { "utilization": 0.72, "resets_at": "2026-04-03T00:00:00Z" },
      "last_polled": "2026-03-31T14:30:00Z"
    }
  }
}
```

## Credential Selection Algorithm

```
fn best_available(accounts: &[CredentialAccount]) -> Option<&CredentialAccount> {
    accounts.iter()
        .filter(|a| !a.is_expired())
        .filter(|a| a.usage.map_or(true, |u| u.five_hour.utilization < 1.0 && u.seven_day.utilization < 1.0))
        .min_by(|a, b| {
            let a_util = a.effective_utilization();
            let b_util = b.effective_utilization();
            a_util.partial_cmp(&b_util).unwrap_or(Ordering::Equal)
        })
}

fn effective_utilization(&self) -> f32 {
    // Use the higher of the two windows — the binding constraint
    self.usage.map_or(0.0, |u| u.five_hour.utilization.max(u.seven_day.utilization))
}
```

## Symlink Swap Procedure

```rust
async fn swap_credential(pool: &CredentialPool, target: &CredentialAccount) -> Result<()> {
    let link_path = home_dir().join(".claude").join(".credentials.json");
    
    // Atomic on same filesystem: remove + create
    if link_path.exists() {
        tokio::fs::remove_file(&link_path).await?;
    }
    tokio::fs::symlink(&target.path, &link_path).await?;
    
    tracing::info!(account = %target.name, "Swapped active credential");
    Ok(())
}
```

## Debounce Window

```
Time ──────────────────────────────────────────►
  │
  │  Session A hits limit
  │  ├── intercept notification
  │  ├── query pool → best_available()
  │  ├── swap symlink
  │  ├── send "continue" to A via tmux
  │  ├── START 3-min debounce window
  │  │
  │  │   Session B hits limit (within window)
  │  │   ├── intercept notification
  │  │   ├── skip pool query (debounce active)
  │  │   ├── skip swap (already done)
  │  │   └── send "continue" to B via tmux
  │  │
  │  │   Session C hits limit (within window)
  │  │   └── same as B
  │  │
  │  └── END debounce window
```

## Integration Points

### Socket Event Interception (socket.rs)
The `handle_notification` path checks for rate limit indicators before forwarding to TTS:
1. Text contains "hit your limit" or "resets" → rate limit notification
2. `rate_limit_event` with `utilization >= 1.0` → rate limit event
Either triggers the rotation flow instead of TTS delivery.

### Usage API Client (extracted from nexus-status)
Move the Anthropic usage API call (`/api/oauth/usage`) from `nexus-status/src/main.rs:286-370`
into a shared module in `nexus-core` or `nexus-agent`. The client takes an OAuth access token and
returns `AccountUsage`.

### Fallback Behavior
When `~/.config/nexus/credentials/` is empty or doesn't exist, the service operates in passthrough
mode — no interception, no symlink management, rate limit notifications delivered normally via TTS.
