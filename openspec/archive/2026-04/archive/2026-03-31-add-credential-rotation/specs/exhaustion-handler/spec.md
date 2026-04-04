# Capability: Exhaustion Handler

## ADDED Requirements

### Requirement: The system SHALL notify when all accounts are exhausted
When all credentials are at capacity, the agent MUST send a detailed notification instead of silently failing.

#### Scenario: All accounts rate-limited
Given all credentials have utilization >= 1.0 for either 5h or 7d window
When a rate limit event is detected
Then a notification is sent listing each account name, limit type, and reset time, with the soonest-to-reset account highlighted

#### Scenario: Notification format
Given accounts "personal" (5h resets 2:15 PM), "work" (7d resets Thu), "team" (5h resets 1:45 PM)
When the exhaustion notification is generated
Then it reads:
```
All accounts rate-limited:
  personal: 5h resets 2:15 PM
  work: 7d resets Thu
  team: 5h resets 1:45 PM ← next available
```

#### Scenario: Single account only
Given only one credential exists and it is rate-limited
When a rate limit event is detected
Then the notification shows the single account's reset time without the "next available" marker
