# Non-sensitive defaults — committed to repo.
# Sensitive values (tokens, secrets, URLs) are sourced via TF_VAR_* in infra/.secrets.env

cloudflare_zone_name = "leonardoacosta.dev"

# Placeholder: replace with actual Tailscale IP of the homelab machine.
# Run `tailscale ip` on the homelab server to get the correct value.
homelab_ip = "100.64.0.1"
