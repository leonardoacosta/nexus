# swift-menubar-client Delta

## ADDED Requirements

### Requirement: credentials-usage-bars
Each credential row in the Credentials tab MUST render two horizontal usage bars (5h on top, 7d below) when `usage5hLimit` and `usage7dLimit` are non-nil. Each bar MUST show `used / limit` as a percentage fill colored green below 70%, yellow between 70-90%, and red at 90%+. Bars MUST display the absolute values as a caption (`100 / 500 (20%)`) and the reset time as a ticking countdown (`Resets in 2h 14m`) using `TimelineView` so the countdown updates without a re-fetch.

#### Scenario: bars render for populated row
- **Given** a credential row with `usage5hUsed=100, usage5hLimit=500, usage5hResetAt=<2h-from-now>`
- **When** the row renders
- **Then** the 5h bar is 20% filled in green; the caption reads `100 / 500 (20%)`; the countdown reads `Resets in 2h 0m` and updates each second

#### Scenario: red zone above 90%
- **Given** `usage5hUsed=480, usage5hLimit=500`
- **When** the row renders
- **Then** the 5h bar is 96% filled in red

#### Scenario: bars hidden when poller hasn't sampled
- **Given** a row where `usage5hLimit == nil` (poller has not yet run for this credential)
- **When** the row renders
- **Then** the usage-bar block is omitted entirely; existing row content is unchanged

#### Scenario: countdown rolls over after reset
- **Given** `usage5hResetAt` is in the past (e.g. by 30s due to clock skew)
- **When** the row renders
- **Then** the countdown shows `Resets soon` rather than a negative value

### Requirement: credentials-refresh-identity-button
Each credential row in the Credentials tab MUST display a "Refresh identity" affordance (icon button or context menu item) when `accountEmail == nil`. Clicking it MUST call `POST /credentials/:id/refresh-identity` and optimistically replace the row's identity fields with the response. On error, the button MUST show a transient red dot for 2 seconds, then revert.

#### Scenario: refresh button shown only when email blank
- **Given** two credential rows: row A with `accountEmail = "leo@host"`, row B with `accountEmail = nil`
- **When** the tab renders
- **Then** only row B shows the "Refresh identity" affordance

#### Scenario: successful refresh updates row in place
- **Given** row B with blank identity
- **When** the user clicks "Refresh identity" and the response is `{ accountName: "Leo", accountEmail: "leo@host" }`
- **Then** the row immediately re-renders with the new identity; the affordance disappears (email is no longer nil)

#### Scenario: failed refresh shows error indicator
- **Given** the endpoint returns `502 { error: "..." }`
- **When** the user clicks "Refresh identity"
- **Then** the button shows a red dot for 2 seconds, then reverts; the row's identity fields are unchanged

### Requirement: credentials-dedupe-toggle
The Credentials tab header MUST display a "Dedupe" toggle switch defaulting ON. When ON, the tab MUST fetch `GET /credentials?dedupe=true` and render rows that include a `+N duplicates` chip when `siblingCount > 0`. Tapping the chip MUST expand the row to show the sibling ids (each with its own delete button). When the toggle is OFF, the tab MUST fetch `GET /credentials` (no query param) and render every row including non-primary siblings.

#### Scenario: dedupe-on default
- **Given** the Credentials tab is opened fresh (no @AppStorage override)
- **When** the tab renders
- **Then** the dedupe toggle is ON; `?dedupe=true` is the URL queried

#### Scenario: chip shows sibling count
- **Given** dedupe is ON and a primary row has `siblingCount: 2`
- **When** the row renders
- **Then** a `+2 duplicates` chip is visible to the right of the row identity

#### Scenario: chip expands to show siblings
- **Given** the chip is visible
- **When** the user taps it
- **Then** the row expands inline to list `siblingIds[]`, each with a small "delete" icon button

#### Scenario: dedupe-off renders all rows
- **Given** the user toggles dedupe OFF
- **When** the tab re-fetches
- **Then** the URL queried is `GET /credentials` (no param); all rows including non-primary siblings render with no `siblingCount` decorations
