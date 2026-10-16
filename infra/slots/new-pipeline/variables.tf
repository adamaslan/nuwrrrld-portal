variable "new_project_id" {
  description = "Existing dedicated GCP project for the new-pipeline slot. This configuration never creates or adopts the current project."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.new_project_id))
    error_message = "new_project_id must be a valid GCP project ID."
  }
}

variable "current_project_id" {
  description = "Current production project ID, used only for the isolation guard."
  type        = string
}

variable "region" {
  description = "Region for the new slot's Artifact Registry and artifact bucket."
  type        = string
}

variable "artifact_bucket_name" {
  description = "Globally unique bucket name for new-slot pipeline artifacts. Not the Terraform state bucket."
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

variable "github_ref" {
  description = "Only this trusted Git ref may exchange GitHub OIDC tokens."
  type        = string
  default     = "refs/heads/main"

  validation {
    condition     = can(regex("^refs/heads/[A-Za-z0-9._/-]+$", var.github_ref))
    error_message = "github_ref must be a branch ref such as refs/heads/main."
  }
}
