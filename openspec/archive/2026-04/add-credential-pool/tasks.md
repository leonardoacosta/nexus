## 1. Core Model
- [x] [1.1] Define credential model in `@nexus/core` (id, provider, key, state, leased_to, leased_at, cooldown_until) [owner:agent]
- [x] [1.2] Implement pool logic (round-robin selection, state machine: available -> leased -> cooldown -> available) [owner:agent]

## 2. API Endpoints
- [x] [2.1] Implement `POST /credentials/lease` endpoint (returns credential, sets leased state) [owner:agent]
- [x] [2.2] Implement `POST /credentials/{id}/release` endpoint (returns credential to pool) [owner:agent]
- [x] [2.3] Implement `GET /credentials/status` endpoint (pool overview for dashboard) [owner:agent]

## 3. Rotation
- [x] [3.1] Add automatic rotation on rate limit detection (move to cooldown, lease next available) [owner:agent]
- [x] [3.2] Add expiry-based rotation (TTL on leases, auto-release stale leases) [owner:agent]

## 4. Persistence
- [x] [4.1] SQLite persistence for credential state (survive agent restarts) [owner:agent]

## 5. Validation
- [x] [5.1] Write tests for pool lifecycle (lease, release, cooldown, re-lease) [owner:agent]
- [x] [5.2] Write tests for rate limit rotation (lease fails -> cooldown -> next credential) [owner:agent]
- [x] [5.3] Write tests for stale lease cleanup [owner:agent]
