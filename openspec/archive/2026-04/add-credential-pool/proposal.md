# Add Credential Pool

## Why
Multiple concurrent CC sessions on the same machine compete for shared API credentials, causing rate limit collisions and wasted tokens. The Rust v1 Nexus solved this with a centralized credential pool managed by the agent. Porting this to v2 is essential for reliable multi-session operation, especially as session counts grow across machines.

## What Changes
Implement a credential pool in the agent that manages API credentials (e.g., Claude API keys) with lease/release semantics. Sessions request credentials via agent API endpoints. The pool tracks credential state (available, leased, cooldown) in SQLite and automatically rotates credentials when rate limits or expiry are detected. This is a direct port of the Rust v1 credential management logic.

---

> **Note (cross-reference):** The `encrypt-credential-storage` change (archived 2026-04) supersedes
> the plaintext storage introduced here. Credentials are now encrypted at rest using AES-256-GCM.
> The `value_plaintext` column has been dropped. See `docs/runbook-credential-encryption.md` for
> the migration procedure.
