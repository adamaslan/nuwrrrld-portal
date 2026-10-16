locals {
  slot = "new-pipeline"
  labels = {
    app  = "nwf"
    slot = "new-pipeline"
  }
}

resource "terraform_data" "isolation_guard" {
  input = var.new_project_id

  lifecycle {
    precondition {
      condition     = var.new_project_id != var.current_project_id
      error_message = "The new-pipeline project must differ from the current production project."
    }
  }
}

resource "google_project_service" "required" {
  for_each = toset([
    "artifactregistry.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "secretmanager.googleapis.com",
    "sts.googleapis.com",
    "storage.googleapis.com",
  ])

  project            = var.new_project_id
  service            = each.value
  disable_on_destroy = false
  depends_on         = [terraform_data.isolation_guard]
}

resource "google_service_account" "runtime" {
  project      = var.new_project_id
  account_id   = "nwf-new-runtime"
  display_name = "NWF new-pipeline runtime"
  depends_on   = [google_project_service.required]

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_service_account" "observer" {
  project      = var.new_project_id
  account_id   = "nwf-new-observer"
  display_name = "NWF new-pipeline watchdog"
  depends_on   = [google_project_service.required]

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_service_account" "deploy" {
  project      = var.new_project_id
  account_id   = "nwf-new-deploy"
  display_name = "NWF new-pipeline GitHub deploy"
  depends_on   = [google_project_service.required]

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_artifact_registry_repository" "images" {
  project       = var.new_project_id
  location      = var.region
  repository_id = "nwf-new-pipeline"
  description   = "Immutable container images for the isolated NWF new-pipeline slot"
  format        = "DOCKER"
  labels        = local.labels

  docker_config {
    immutable_tags = true
  }

  cleanup_policy_dry_run = true

  cleanup_policies {
    id     = "keep-recent-versions"
    action = "KEEP"

    most_recent_versions {
      keep_count = 2
    }
  }

  cleanup_policies {
    id     = "delete-untagged-after-1d"
    action = "DELETE"

    condition {
      tag_state  = "UNTAGGED"
      older_than = "86400s"
    }
  }

  depends_on = [google_project_service.required]

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_artifact_registry_repository_iam_member" "deploy_writer" {
  project    = var.new_project_id
  location   = var.region
  repository = google_artifact_registry_repository.images.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.deploy.email}"
}

resource "google_storage_bucket" "artifacts" {
  project                     = var.new_project_id
  name                        = var.artifact_bucket_name
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  labels                      = local.labels

  versioning {
    enabled = true
  }

  depends_on = [google_project_service.required]

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_secret_manager_secret" "alpaca_api_key" {
  project   = var.new_project_id
  secret_id = "nwf-new-alpaca-api-key"
  labels    = local.labels

  replication {
    auto {}
  }

  depends_on = [google_project_service.required]

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_secret_manager_secret" "alpaca_api_secret" {
  project   = var.new_project_id
  secret_id = "nwf-new-alpaca-api-secret"
  labels    = local.labels

  replication {
    auto {}
  }

  depends_on = [google_project_service.required]

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_secret_manager_secret" "openrouter_api_key" {
  project   = var.new_project_id
  secret_id = "nwf-new-openrouter-api-key"
  labels    = local.labels

  replication {
    auto {}
  }

  depends_on = [google_project_service.required]

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_secret_manager_secret_iam_member" "runtime_access" {
  for_each = {
    alpaca_api_key     = google_secret_manager_secret.alpaca_api_key.id
    alpaca_api_secret  = google_secret_manager_secret.alpaca_api_secret.id
    openrouter_api_key = google_secret_manager_secret.openrouter_api_key.id
  }

  project   = var.new_project_id
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_iam_workload_identity_pool" "github" {
  project                   = var.new_project_id
  workload_identity_pool_id = "nwf-new-github"
  display_name              = "NWF new GitHub"
  description               = "GitHub OIDC for the isolated new-pipeline slot"
  depends_on                = [google_project_service.required]

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = var.new_project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  display_name                       = "Trusted NWF GitHub branch"

  attribute_mapping = {
    "google.subject"          = "assertion.sub"
    "attribute.repository_id" = "assertion.repository_id"
  }

  attribute_condition = "assertion.repository_owner_id == '${var.github_owner_id}' && assertion.repository_id == '${var.github_repository_id}' && assertion.ref == '${var.github_ref}'"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_service_account_iam_member" "github_deploy" {
  service_account_id = google_service_account.deploy.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository_id/${var.github_repository_id}"
  depends_on         = [google_iam_workload_identity_pool_provider.github]
}
