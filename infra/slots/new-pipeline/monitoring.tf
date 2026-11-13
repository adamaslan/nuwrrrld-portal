resource "google_monitoring_notification_channel" "alert_email" {
  for_each = toset(var.alert_emails)

  project      = var.slot_project_id
  display_name = "NWF slot alerts: ${each.value}"
  type         = "email"

  labels = {
    email_address = each.value
  }

  depends_on = [google_project_service.monitoring]
}

resource "google_project_service" "monitoring" {
  project            = var.slot_project_id
  service            = "monitoring.googleapis.com"
  disable_on_destroy = false
  depends_on         = [terraform_data.project_guard]
}
