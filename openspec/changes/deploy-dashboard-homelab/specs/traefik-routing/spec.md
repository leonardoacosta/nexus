# Spec: Traefik routing for nexus.leonardoacosta.dev

## ADDED Requirements

### Requirement: Traefik dynamic config file

`deploy/traefik/nexus-dashboard.yml` MUST define a Traefik file-provider configuration that:
- Routes `Host("nexus.leonardoacosta.dev")` to `http://localhost:3100`
- Enables TLS with cert resolver `cloudflare` (Let's Encrypt DNS-01 via Cloudflare)
- Entrypoints: `websecure` (443)
- HTTP → HTTPS redirect handled at Traefik entrypoint level (not in this file)

```yaml
# Shape of the required config (not the implementation — engineer writes the final file)
http:
  routers:
    nexus-dashboard:
      rule: Host(`nexus.leonardoacosta.dev`)
      entryPoints: [websecure]
      service: nexus-dashboard
      tls:
        certResolver: cloudflare
  services:
    nexus-dashboard:
      loadBalancer:
        servers:
          - url: http://localhost:3100
```

#### Scenario: Traefik routes nexus.leonardoacosta.dev to dashboard
- **Given** the yml is in Traefik's dynamic config directory and Traefik is running
- **When** an HTTP request arrives for `nexus.leonardoacosta.dev` on port 443
- **Then** Traefik proxies the request to `http://localhost:3100` and returns the dashboard HTML

#### Scenario: TLS cert is issued automatically
- **Given** Traefik has a valid Cloudflare API token and the `cloudflare` cert resolver configured
- **When** the router is first active with an uncached certificate
- **Then** Traefik completes ACME DNS-01 challenge and serves a valid certificate for `nexus.leonardoacosta.dev`

---

### Requirement: install.sh copies config to Traefik dynamic dir

`deploy/install.sh --dashboard` MUST copy `deploy/traefik/nexus-dashboard.yml` to the Traefik dynamic config directory. The destination defaults to `/etc/traefik/dynamic/` and is overridable via `TRAEFIK_DYNAMIC_DIR` environment variable.

#### Scenario: config lands in correct directory
- **Given** `TRAEFIK_DYNAMIC_DIR=/custom/traefik/conf` is set
- **When** `deploy/install.sh --dashboard` is run
- **Then** `/custom/traefik/conf/nexus-dashboard.yml` exists with the correct content
