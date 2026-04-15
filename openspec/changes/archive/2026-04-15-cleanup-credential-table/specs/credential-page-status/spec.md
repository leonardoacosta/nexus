# credential-page-status — Spec Delta

## MODIFIED Requirements

### Requirement: MCP provider display format

The MCP providers column MUST display full provider names (e.g., "figma", "slack", "posthog") as small colored pills instead of single-letter abbreviations. Each pill MUST retain the provider-specific color scheme and MUST show the full lowercase name.

#### Scenario: multiple MCP providers displayed as full-name pills
- **Given** a credential has `mcpProviders: "figma,posthog,slack"`
- **When** the credential table renders that row
- **Then** three colored pills appear: "figma" (purple), "posthog" (blue), "slack" (green)

#### Scenario: single MCP provider displayed as full-name pill
- **Given** a credential has `mcpProviders: "posthog"`
- **When** the credential table renders that row
- **Then** one blue pill appears with the text "posthog"

---

### Requirement: Rate limits column hidden

The credential table MUST NOT render the `rateLimitCount` column or its sort header. The column data and sort logic MAY remain in the codebase for future use but MUST NOT be visible to the user.

#### Scenario: rate limits column absent from table
- **Given** the credential table renders with any set of credentials
- **When** the user views the table headers
- **Then** there is no "Rate Limits" column header and no rate limit values in any row

---

## ADDED Requirements

### Requirement: Credential metadata refresh on agent startup

On startup, the agent MUST re-read all `acct-*.json` files from `~/.config/nexus/credentials/`, compute the fingerprint for each, and update `expiresAt`, `subscriptionType`, `rateLimitTier`, and `mcpProviders` in the database for every credential row whose fingerprint matches. Credentials in the DB with no matching file on disk MUST NOT be deleted or modified.

#### Scenario: stale expiresAt refreshed on startup
- **Given** credential file `acct-abc.json` has a refreshed access token expiring in 2 hours
- **And** the DB row with the same fingerprint has `expiresAt` set to 11 days ago
- **When** the agent starts and calls `refreshMetadata()`
- **Then** the DB row's `expiresAt` is updated to the new 2-hour expiry timestamp

#### Scenario: new MCP provider added to credential file
- **Given** credential file `acct-abc.json` now contains `mcpOAuth` entries for "figma" and "slack"
- **And** the DB row has `mcpProviders: "figma"`
- **When** the agent starts and calls `refreshMetadata()`
- **Then** the DB row's `mcpProviders` is updated to "figma,slack"

#### Scenario: credential file missing from disk
- **Given** the DB contains a credential with fingerprint "xyz"
- **And** no file in `~/.config/nexus/credentials/` has fingerprint "xyz"
- **When** the agent starts and calls `refreshMetadata()`
- **Then** the DB row with fingerprint "xyz" is NOT deleted or modified
