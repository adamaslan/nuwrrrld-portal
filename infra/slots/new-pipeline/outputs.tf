output "slot_project_id" {
  value       = var.slot_project_id
  description = "Existing billed project hosting the new-pipeline slot."
}

output "runtime_service_account" {
  value       = google_service_account.runtime.email
  description = "Runtime identity. No current-slot grants are configured here."
}

output "observer_service_account" {
  value       = google_service_account.observer.email
  description = "Watchdog identity; permissions are added with the watchdog in phase 2."
}

output "deploy_service_account" {
  value       = google_service_account.deploy.email
  description = "GitHub identity with writer access only to the new-slot image repository."
}

output "workload_identity_provider" {
  value       = google_iam_workload_identity_pool_provider.github.name
  description = "Provider resource name for google-github-actions/auth."
}

output "image_repository" {
  value       = google_artifact_registry_repository.images.name
  description = "Isolated image repository."
}

output "artifact_bucket" {
  value       = google_storage_bucket.artifacts.name
  description = "Versioned artifact bucket; separate from Terraform state."
}
