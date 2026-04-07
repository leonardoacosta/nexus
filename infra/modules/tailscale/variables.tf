variable "tailscale_api_key" {
  description = "Tailscale API key for ACL management"
  type        = string
  sensitive   = true
}

variable "tailscale_tailnet" {
  description = "Tailscale tailnet name"
  type        = string
}
