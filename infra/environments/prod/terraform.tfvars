# Non-sensitive defaults — committed to repo.
# Sensitive values (tokens, secrets, URLs) are sourced via TF_VAR_* in infra/.secrets.env

cloudflare_zone_name = "leonardoacosta.dev"
cloudflare_zone_id   = "8700a80499b536a453e2c8734531bbad"

# Placeholder: replace with actual Tailscale IP of the homelab machine.
# Run `tailscale ip` on the homelab server to get the correct value.
homelab_ip = "100.94.11.104"
