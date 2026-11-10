output "slot_project_id" {
  value       = var.slot_project_id
  description = "Existing billed project hosting the hydration and core slots."
}

output "runtime_service_accounts" {
  value       = { for slot, sa in google_service_account.runtime : slot => sa.email }
  description = "Per-slot runtime identity. Each reads only its own slot's secret containers."
}

output "observer_service_accounts" {
  value       = { for slot, sa in google_service_account.observer : slot => sa.email }
  description = "Per-slot watchdog identity; permissions are added with the watchdog in phase 2."
}

output "deploy_service_accounts" {
  value       = { for slot, sa in google_service_account.deploy : slot => sa.email }
  description = "Per-slot GitHub identity with writer access only to that slot's image repository."
}

output "workload_identity_providers" {
  value       = { for slot, provider in google_iam_workload_identity_pool_provider.github : slot => provider.name }
  description = "Per-slot provider resource names for google-github-actions/auth."
}

output "image_repositories" {
  value       = { for slot, repo in google_artifact_registry_repository.images : slot => repo.name }
  description = "Per-slot isolated image repositories."
}

output "artifact_buckets" {
  value       = { for slot, bucket in google_storage_bucket.artifacts : slot => bucket.name }
  description = "Per-slot versioned artifact buckets; separate from Terraform state."
}
