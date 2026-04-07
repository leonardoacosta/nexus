module "cloudflare" {
  source = "../../modules/cloudflare"

  zone_id    = var.cloudflare_zone_id
  homelab_ip = var.homelab_ip
}

module "tailscale" {
  source = "../../modules/tailscale"

  tailscale_api_key = var.tailscale_api_key
  tailscale_tailnet = var.tailscale_tailnet
}
