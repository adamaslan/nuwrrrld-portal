variable "slot_project_id" {
  description = "Existing billed project hosting the NWF backend. The project guard currently permits only ttb-lang1."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.slot_project_id))
    error_message = "slot_project_id must be a valid GCP project ID."
  }
}

variable "region" {
  description = "Region for the new slot's Artifact Registry and artifact bucket."
  type        = string
}

variable "artifact_bucket_name" {
  description = "Globally unique bucket name prefix for slot artifacts. Each slot appends its name, for example -hydration. Not the Terraform state bucket."
  type        = string
}

variable "github_repository_id" {
  description = "Immutable numeric GitHub repository ID allowed to impersonate the deploy service account."
  type        = string

  validation {
    condition     = can(regex("^[0-9]+$", var.github_repository_id))
    error_message = "github_repository_id must contain only digits."
  }
}

variable "github_owner_id" {
  description = "Immutable numeric GitHub owner ID for the trusted repository."
  type        = string

  validation {
    condition     = can(regex("^[0-9]+$", var.github_owner_id))
    error_message = "github_owner_id must contain only digits."
  }
}

variable "hydration_image_digest" {
  description = "Tested sha256 digest of the hydration image, for example sha256:abc... . Empty until an image is built and tested; the job and schedules are not created while empty."
  type        = string
  default     = ""

  validation {
    condition     = var.hydration_image_digest == "" || can(regex("^sha256:[0-9a-f]{64}$", var.hydration_image_digest))
    error_message = "hydration_image_digest must be empty or a sha256 digest."
  }
}

variable "hydration_neon_endpoint_id" {
  description = "Neon endpoint ID of the nwf-hydration branch. The worker rejects a target whose hostname does not contain it. Set in the local, ignored terraform.tfvars; not a secret, but kept out of committed files."
  type        = string
  default     = ""
}

variable "hydration_schedules" {
  description = "Cron times (America/New_York) for the three weekday hydration runs."
  type        = map(string)
  default = {
    open   = "0 10 * * 1-5"
    midday = "30 12 * * 1-5"
    close  = "30 18 * * 1-5"
  }
}

variable "alert_emails" {
  description = "Shared distribution list for slot Monitoring alerts. Set in the local, ignored terraform.tfvars."
  type        = list(string)

  validation {
    condition     = length(var.alert_emails) > 0 && alltrue([for address in var.alert_emails : can(regex("^[^@\\s]+@[^@\\s]+$", address))])
    error_message = "alert_emails must contain at least one well-formed email address."
  }
}

variable "github_ref" {
  description = "Only this trusted Git ref may exchange GitHub OIDC tokens."
  type        = string
  default     = "refs/heads/main"

  validation {
    condition     = can(regex("^refs/heads/[A-Za-z0-9._/-]+$", var.github_ref))
    error_message = "github_ref must be a branch ref such as refs/heads/main."
  }
}
