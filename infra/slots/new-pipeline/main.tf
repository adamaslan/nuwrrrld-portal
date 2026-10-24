locals {
  # Slots 2 and 3 of the three-slot layout (docs §0.5). Slot 1 is production
  # and is deliberately absent: no Terraform manages it.
  slots = {
    hydration = {
      secrets = ["alpaca_api_key", "alpaca_api_secret", "openrouter_api_key", "source_database_url", "hydration_database_url"]
    }
    core = {
      secrets = ["alpaca_api_key", "alpaca_api_secret"]
    }
  }

  secret_suffixes = {
    alpaca_api_key     = "alpaca-api-key"
    alpaca_api_secret  = "alpaca-api-secret"
    openrouter_api_key = "openrouter-api-key"
    # Neon connection strings. Source is the read-only production branch;
    # hydration is the writer scoped to nwf-hydration. Versions are added
    # by hand through the approved secret path, never through Terraform.
    source_database_url    = "source-database-url"
    hydration_database_url = "hydration-database-url"
  }

  slot_secrets = merge([
    for slot, config in local.slots : {
      for secret in config.secrets : "${slot}/${secret}" => {
        slot   = slot
        secret = secret
      }
    }
  ]...)
}

resource "terraform_data" "project_guard" {
  input = var.slot_project_id

  lifecycle {
    precondition {
      condition     = var.slot_project_id == "ttb-lang1"
      error_message = "This root is approved only for the existing ttb-lang1 project."
    }
  }
}

resource "google_project_service" "sts" {
  project            = var.slot_project_id
  service            = "sts.googleapis.com"
  disable_on_destroy = false
  depends_on         = [terraform_data.project_guard]
}

resource "google_service_account" "runtime" {
  for_each = local.slots

  project      = var.slot_project_id
  account_id   = "nwf-${each.key}-runtime"
  display_name = "NWF ${each.key} runtime"
  depends_on   = [google_project_service.sts]

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_service_account" "observer" {
  for_each = local.slots

  project      = var.slot_project_id
  account_id   = "nwf-${each.key}-observer"
  display_name = "NWF ${each.key} watchdog"
  depends_on   = [google_project_service.sts]

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_service_account" "deploy" {
  for_each = local.slots

  project      = var.slot_project_id
  account_id   = "nwf-${each.key}-deploy"
  display_name = "NWF ${each.key} GitHub deploy"
  depends_on   = [google_project_service.sts]

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_artifact_registry_repository" "images" {
  for_each = local.slots

  project       = var.slot_project_id
  location      = var.region
  repository_id = "nwf-${each.key}"
  description   = "Immutable container images for the NWF ${each.key} slot"
  format        = "DOCKER"
  labels        = { app = "nwf", slot = each.key }

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

  depends_on = [google_project_service.sts]

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_artifact_registry_repository_iam_member" "deploy_writer" {
  for_each = local.slots

  project    = var.slot_project_id
  location   = var.region
  repository = google_artifact_registry_repository.images[each.key].name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.deploy[each.key].email}"
}

resource "google_storage_bucket" "artifacts" {
  for_each = local.slots

  project                     = var.slot_project_id
  name                        = "${var.artifact_bucket_name}-${each.key}"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  labels                      = { app = "nwf", slot = each.key }

  versioning {
    enabled = true
  }

  depends_on = [google_project_service.sts]

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_secret_manager_secret" "slot" {
  for_each = local.slot_secrets

  project   = var.slot_project_id
  secret_id = "nwf-${each.value.slot}-${local.secret_suffixes[each.value.secret]}"
  labels    = { app = "nwf", slot = each.value.slot }

  replication {
    auto {}
  }

  depends_on = [google_project_service.sts]

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_secret_manager_secret_iam_member" "runtime_access" {
  for_each = local.slot_secrets

  project   = var.slot_project_id
  secret_id = google_secret_manager_secret.slot[each.key].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime[each.value.slot].email}"
}

resource "google_iam_workload_identity_pool" "github" {
  for_each = local.slots

  project                   = var.slot_project_id
  workload_identity_pool_id = "nwf-${each.key}-github"
  display_name              = "NWF ${each.key} GitHub"
  description               = "GitHub OIDC scoped to the NWF ${each.key} slot"
  depends_on                = [google_project_service.sts]

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_iam_workload_identity_pool_provider" "github" {
  for_each = local.slots

  project                            = var.slot_project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github[each.key].workload_identity_pool_id
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
  for_each = local.slots

  service_account_id = google_service_account.deploy[each.key].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github[each.key].name}/attribute.repository_id/${var.github_repository_id}"
  depends_on         = [google_iam_workload_identity_pool_provider.github]
}
