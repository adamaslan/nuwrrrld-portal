locals {
  hydration_job_name = "nwf-hydration"
  # Created only once a tested image digest, the Neon endpoint ID and verified
  # database-URL secret versions exist, so a scheduled run can never start a job
  # that Cloud Run cannot launch and page the alert list for nothing.
  hydration_enabled = (
    var.hydration_image_digest != "" &&
    var.hydration_neon_endpoint_id != "" &&
    var.hydration_secrets_ready
  ) ? 1 : 0
}

resource "google_project_service" "run" {
  project            = var.slot_project_id
  service            = "run.googleapis.com"
  disable_on_destroy = false
  depends_on         = [terraform_data.project_guard]
}

resource "google_project_service" "cloudscheduler" {
  project            = var.slot_project_id
  service            = "cloudscheduler.googleapis.com"
  disable_on_destroy = false
  depends_on         = [terraform_data.project_guard]
}

# Identity that only Cloud Scheduler uses to start the job. It has no
# secret access and no repository access.
resource "google_service_account" "hydration_scheduler" {
  project      = var.slot_project_id
  account_id   = "nwf-hydration-scheduler"
  display_name = "NWF hydration scheduler"
  depends_on   = [google_project_service.sts]

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_cloud_run_v2_job" "hydration" {
  count = local.hydration_enabled

  project  = var.slot_project_id
  location = var.region
  name     = local.hydration_job_name
  labels   = { app = "nwf", slot = "hydration" }

  template {
    task_count = 1

    template {
      service_account = google_service_account.runtime["hydration"].email
      max_retries     = 1
      timeout         = "1800s"

      containers {
        image = "${google_artifact_registry_repository.images["hydration"].registry_uri}@${var.hydration_image_digest}"

        resources {
          limits = {
            cpu    = "1"
            memory = "512Mi"
          }
        }

        env {
          name = "SOURCE_DATABASE_URL"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.slot["hydration/source_database_url"].secret_id
              version = "latest"
            }
          }
        }

        env {
          name = "HYDRATION_DATABASE_URL"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.slot["hydration/hydration_database_url"].secret_id
              version = "latest"
            }
          }
        }

        # Guards that the worker checks before any write. Writes stay off
        # (ENABLE_HYDRATION_WRITES is not set) until acceptance is approved.
        env {
          name  = "HYDRATION_NEON_BRANCH_NAME"
          value = "nwf-hydration"
        }

        env {
          name  = "HYDRATION_NEON_ENDPOINT_ID"
          value = var.hydration_neon_endpoint_id
        }

        env {
          name = "ALPACA_API_KEY"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.slot["hydration/alpaca_api_key"].secret_id
              version = "latest"
            }
          }
        }

        env {
          name = "ALPACA_API_SECRET"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.slot["hydration/alpaca_api_secret"].secret_id
              version = "latest"
            }
          }
        }
      }
    }
  }

  depends_on = [google_project_service.run]
}

resource "google_cloud_run_v2_job_iam_member" "scheduler_invoker" {
  count = local.hydration_enabled

  project  = var.slot_project_id
  location = var.region
  name     = google_cloud_run_v2_job.hydration[0].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.hydration_scheduler.email}"
}

# Three weekday runs in Eastern time (America/New_York follows DST, so the
# times hold in both seasons): after the open, midday, and after the close.
# Mid-day and early runs store partial bars; the after-close run replaces them.
resource "google_cloud_scheduler_job" "hydration" {
  for_each = local.hydration_enabled == 1 ? toset(["open", "midday", "close"]) : toset([])

  project   = var.slot_project_id
  region    = var.region
  name      = "nwf-hydration-${each.key}"
  time_zone = "America/New_York"
  schedule  = var.hydration_schedules[each.key]

  http_target {
    http_method = "POST"
    uri         = "https://run.googleapis.com/v2/projects/${var.slot_project_id}/locations/${var.region}/jobs/${local.hydration_job_name}:run"

    oauth_token {
      service_account_email = google_service_account.hydration_scheduler.email
    }
  }

  retry_config {
    retry_count = 0
  }

  depends_on = [google_project_service.cloudscheduler, google_cloud_run_v2_job_iam_member.scheduler_invoker]
}
