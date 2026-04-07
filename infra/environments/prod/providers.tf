terraform {
  required_version = ">= 1.5"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }

    postgresql = {
      source  = "cyrilgdn/postgresql"
      version = "~> 1.22"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  cloud {
    organization = "leonardo-acosta"
    workspaces {
      name = "nx-prod"
    }
  }
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}


provider "postgresql" {
  host     = var.homelab_ip
  port     = 5436
  username = var.pg_superuser
  password = var.pg_superuser_password
  sslmode  = "disable"
  superuser = false
}
