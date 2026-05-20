# credential-pool Specification Delta

## ADDED Requirements

### Requirement: Credential rows include rich CcProfile metadata

The credential-pool reader SHALL emit full CcProfile-compatible rows on
`GET /credentials`. Each row MUST include `id`, `name`, `fingerprint`,
`status`, `rateLimit429Count` (Int), and `isActive` (Bool). Optional
fields (`subscriptionType`, `rateLimitTier`, `accountEmail`,
`accountName`, `orgName`, `expiresAt`, `lastSwapAt`) MUST be populated
when the underlying credential file exposes them.

#### Scenario: complete credential file produces complete row

- **GIVEN** `~/.claude/.credentials.json` contains a credential with
  `accountUuid`, `email`, `subscriptionType: "pro"`, `oauthToken.expiresAt: "2026-12-31T..."`
- **WHEN** `GET /credentials` is fetched
- **THEN** the response row includes `id`, `name=<email>`, `fingerprint`,
  `subscriptionType="pro"`, `expiresAt="2026-12-31T..."`, and all
  required fields populated

#### Scenario: minimal credential file still decodes

- **GIVEN** a credential entry with only `oauthToken` and no email/name
- **WHEN** the reader projects it
- **THEN** `id` falls back to the fingerprint-derived UUID
- **AND** `name` falls back to the short fingerprint prefix
- **AND** the Swift decoder accepts the row without error

#### Scenario: row marked active matches activeFingerprint

- **GIVEN** the response envelope's `activeFingerprint` is X
- **WHEN** the credentials array is built
- **THEN** exactly one row has `isActive=true` (the row with `fingerprint=X`)
- **AND** all other rows have `isActive=false`

### Requirement: Rate-limit counter tracks 429 responses per fingerprint

The credential-pool service SHALL maintain a per-fingerprint count of
HTTP 429 responses observed in the trailing 24-hour window. The
`rateLimit429Count` field on each `/credentials` row MUST reflect that
count.

#### Scenario: 429 increments the counter

- **GIVEN** a fingerprint F with `rateLimit429Count=2`
- **WHEN** the agent observes a new 429 response from CC for F
- **THEN** the counter for F increments to 3 within the next refresh
- **AND** the next `/credentials` fetch shows `rateLimit429Count=3` for F

#### Scenario: counter ages out at 24h

- **GIVEN** a 429 was recorded for F more than 24h ago
- **WHEN** the counter is queried
- **THEN** that stale 429 is NOT included in the count
- **AND** counts older than 24h are pruned on read

### Requirement: Swap timestamp tracks credential rotation

The credential-pool service SHALL record a `lastSwapAt` timestamp
whenever the agent rotates the active credential. The
`/credentials` response row MUST include the most recent swap
timestamp for each fingerprint.

#### Scenario: swap updates lastSwapAt for both rotated credentials

- **GIVEN** the active fingerprint changes from A to B
- **WHEN** the next `/credentials` fetch occurs
- **THEN** row A has `lastSwapAt=<rotation-timestamp>` (swapped OUT)
- **AND** row B has `lastSwapAt=<rotation-timestamp>` (swapped IN)
- **AND** other rows retain their previous `lastSwapAt` or `null` if
  never swapped

#### Scenario: never-swapped row has null lastSwapAt

- **GIVEN** a credential F has never been the active fingerprint
- **WHEN** its row is projected
- **THEN** `lastSwapAt` is `null` (not omitted, not a zero date)
