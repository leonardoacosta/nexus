variable "homelab_ip" {
  description = "Tailscale IP of the homelab machine"
  type        = string
}

variable "pg_port" {
  description = "Exposed port for homelab-postgres (5436 per docker-compose)"
  type        = number
  default     = 5436
}
