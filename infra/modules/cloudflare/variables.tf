variable "zone_id" {
  description = "Cloudflare zone ID for the DNS zone"
  type        = string
}

variable "homelab_ip" {
  description = "Tailscale IP of the homelab machine hosting nexus-agent"
  type        = string
}
