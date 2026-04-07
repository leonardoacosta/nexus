variable "cloudflare_api_token" {
  description = "Cloudflare API token with DNS edit permissions"
  type        = string
  sensitive   = true
  default     = ""
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID for leonardoacosta.dev"
  type        = string
  default     = ""
}

variable "cloudflare_zone_name" {
  description = "DNS zone name managed by Cloudflare"
  type        = string
  default     = "leonardoacosta.dev"
}

variable "homelab_ip" {
  description = "Tailscale IP of the homelab machine hosting nexus-agent"
  type        = string
  default     = "100.64.0.1"
}

variable "tailscale_api_key" {
  description = "Tailscale API key for ACL management"
  type        = string
  sensitive   = true
  default     = ""
}

variable "tailscale_tailnet" {
  description = "Tailscale tailnet name (e.g. example.com or user@github)"
  type        = string
  default     = ""
}

variable "nexus_encryption_key" {
  description = "AES-256 encryption key for nexus session data"
  type        = string
  sensitive   = true
  default     = ""
}

variable "nexus_attach_secret" {
  description = "Shared secret for nexus attach authentication"
  type        = string
  sensitive   = true
  default     = ""
}

variable "postgres_url" {
  description = "PostgreSQL connection URL for nexus-agent"
  type        = string
  sensitive   = true
  default     = ""
}
