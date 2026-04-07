terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }
}

resource "cloudflare_dns_record" "nexus_homelab" {
  zone_id = var.zone_id
  name    = "nexus"
  type    = "A"
  content = var.homelab_ip
  ttl     = 120
  proxied = false

  comment = "Nexus agent — internal Tailscale mesh (not proxied)"
}
