# kokoro-provider Specification

## Purpose
TBD - created by archiving change add-kokoro-integration-provider. Update Purpose after archive.
## Requirements
### Requirement: A committed container config SHALL make the Kokoro synthesis server deployable on the homelab
The repo MUST carry `deploy/kokoro/docker-compose.yml` running
`ghcr.io/remsky/kokoro-fastapi-cpu:latest` on port 8880 with `restart: unless-stopped`, and
`deploy/README.md` MUST document homelab placement, Tailscale-only exposure (never a public
bind), and an example `/v1/audio/speech` synthesis call. The server requires no API key; access
control is Tailscale ACLs, consistent with the repo's no-token-management convention.

#### Scenario: Operator brings up the server
Given the operator runs `docker compose up -d` in `deploy/kokoro/` on the homelab
When any tailnet machine calls `GET http://<tailscale-ip>:8880/v1/audio/voices`
Then the server responds with the Kokoro voice list

#### Scenario: Synthesis returns MP3
Given the Kokoro container is running
When a client POSTs `{ input, voice, response_format: "mp3" }` to `{baseUrl}/v1/audio/speech`
Then the response body is MP3 audio

### Requirement: The dashboard SHALL render a Kokoro panel on the generic integrations page
`/integrations/kokoro` MUST resolve through the existing `PROVIDER_UI_REGISTRY` to a
`KokoroPanel` exposing `baseUrl` and `defaultVoice` fields with save, Test Connection, and
delete actions against the generic integration client. The panel MUST NOT render a secret
input.

#### Scenario: Panel saves and tests without a secret
Given the operator enters a `baseUrl` and clicks save, then Test Connection
When the agent handles the PATCH and test requests
Then the row persists with `hasSecret: false` and the test result renders from the probe response

#### Scenario: Unregistered providers still 404
Given `kokoro` is registered in `PROVIDER_UI_REGISTRY`
When a user navigates to `/integrations/nope`
Then the page calls `notFound()` as before

