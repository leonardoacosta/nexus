# Proposal: Auto-Bootstrap Credential Pool from CC Sessions

## Change ID
`bootstrap-credential-pool`

## Summary
Eliminate manual credential setup by auto-creating the credentials directory, fingerprinting tokens
from `~/.claude/.credentials.json`, auto-importing new accounts into the pool, and converting the
original file to a managed symlink on first startup.

## Context
- Extends: `crates/nexus-agent/src/services/credential_pool.rs` (passthrough logic, startup),
  `crates/nexus-agent/src/services/credential_watcher.rs` (file change detection),
  `crates/nexus-core/src/credentials.rs` (shared helpers)
- Related: `add-credential-rotation` (active spec) -- this spec fills the "credential file
  creation" gap explicitly listed as OUT-of-scope in that proposal

## Motivation
The `add-credential-rotation` spec assumes users manually copy credential files to
`~/.config/nexus/credentials/`. In practice, every machine already has a working
`~/.claude/.credentials.json` managed by Claude Code. This creates unnecessary friction: users
must discover the convention, copy files, name them correctly, and repeat for each account. By
auto-importing from the CC credential file, Nexus bootstraps itself from existing state with zero
user action, and the credential rotation feature becomes functional immediately on first install.

## Requirements

### Req-1: Auto-Create Credentials Directory
On agent startup, if `~/.config/nexus/credentials/` does not exist, create it with
`create_dir_all()` and proceed normally (start the file watcher, check for CC credentials).
Passthrough mode only activates when the directory exists but is empty AND no CC credential file
is detected as a real (non-symlink) file.

### Req-2: Token Fingerprinting
When the credential watcher detects a change to `~/.claude/.credentials.json`, compute a SHA-256
hash of the `accessToken` field and take the first 8 hex characters as a stable fingerprint. If no
file exists in the pool with filename `acct-{fingerprint}.json`, copy the credential file into the
pool directory under that name. If the fingerprint already exists, update the existing file
in-place (the token may have been refreshed with the same account identity).

### Req-3: Symlink Detection
Before importing a CC credential file, check if `~/.claude/.credentials.json` is a symlink whose
target is inside `~/.config/nexus/credentials/`. If so, the pool is already managing this file --
skip the import entirely. This prevents import loops when the pool's own symlink swap triggers a
watcher event on the CC credential path.

### Req-4: Initial Bootstrap on First Startup
If the credentials directory is empty and `~/.claude/.credentials.json` exists as a real file (not
a symlink), auto-import it as the first account using the fingerprint naming convention. After
successful import, replace `.credentials.json` with a symlink pointing to the imported copy. This
makes the credential pool active from day one with zero user action.

### Req-5: Account Name Discovery
After importing a new credential, attempt to resolve a human-readable account name by calling the
Anthropic API (reuse the existing `query_usage` path or try a profile/whoami endpoint if
available). If a name is returned, rename the pool file from `acct-{fingerprint}.json` to
`acct-{sanitized_name}.json` and update the in-memory account entry. Fall back to the fingerprint
name if the API call fails or returns no identifiable name.

## Scope
- **IN**: Auto-create credentials directory, token SHA-256 fingerprinting, symlink detection
  before import, initial bootstrap with symlink conversion, best-effort name discovery from API
- **OUT**: OAuth token refresh (CC handles this), multi-account interactive setup UI, credential
  deletion/cleanup, cross-machine credential sync

## Impact
| Area | Change |
|------|--------|
| credential_pool.rs | Remove passthrough on missing dir, add `create_dir_all`, add initial bootstrap logic in `start()` |
| credential_watcher.rs | Add fingerprint + auto-import bridge when `.credentials.json` changes |
| credentials.rs (core) | Add `fingerprint_token()` helper, add `is_managed_symlink()` helper |
| paths.rs (core) | Add `claude_credentials_path()` convenience function |

## Risks
| Risk | Mitigation |
|------|-----------|
| Symlink conversion while CC is actively reading | CC re-reads from disk on each API call (confirmed in add-credential-rotation); atomic remove+symlink is safe |
| Token fingerprint collision (8 hex chars) | 4 billion unique values; with typical pool sizes (2-5 accounts), collision probability is negligible |
| Credential watcher sees pool's own symlink swap as a change | Symlink detection (Req-3) prevents re-import loops |
| Name discovery API unavailable | Graceful fallback to fingerprint name; no user-visible failure |
| File permissions on created directory | Use default umask; credentials directory inherits user permissions |
