---
ARCHIVED: 2026-10-15
REASON: Original draft preserved before verification and expansion; the original external replacement was ../../NWF oct 26/AGY-SUBAGENT.md (not tracked here). The current repository design is ../nwf-new-slot-terraform.md.
---

# NuWrrrld Financial (NWF) · Parallel Infrastructure Migration Guide
**Target:** Creating a dual-slot Terraform architecture (`current` vs. `new-pipeline`) incorporating all audited GCP products.  
**Source Baseline:** 2026-09-29 GCP Audit & 2026-10-15 Codebase Inventory.

---

## Part 1: Current Product Inventory Mapping
Before splitting your infrastructure into discrete slots, let's map out the exact GCP products identified in your system audit. Your Terraform modules must account for these components:

| Category | Product | Role in NWF Stack | Slot Isolation Strategy |
| :--- | :--- | :--- | :--- |
| **Compute** | **Cloud Run (`gcp3`)** | Hosts FastAPI backend & job runners | Slot-suffixed service names (`gcp3-current`, `gcp3-new`) |
| **Database** | **Cloud Firestore** | Market/signal cache & paper mirror | Shared database instance or separate collections |
| **Orchestration** | **Cloud Scheduler** | Timed backend refreshes (premarket, midday, EOD) | Namespaced job schedules per slot |
| **Messaging** | **Pub/Sub** | Daily-analysis job message trigger | Slot-specific topic/subscription pairs |
| **Build** | **Cloud Build** | Staging build artifacts & YAML triggers | Independent trigger mapping |
| **Registry** | **Artifact Registry** | Stores built container images | Shared repository with tag/folder isolation |
| **Storage** | **Cloud Storage** | Build staging buckets | Slot-prefixed staging bucket naming |
| **Secrets** | **Secret Manager** | Runtime credentials and API keys | Slot-prefixed secret names or shared read access |
| **Observability** | **Cloud Logging & Monitoring** | Execution tracing, alert policies | Filtered dashboards per slot tag |

---

## Part 2: Proposed Directory Structure
To maintain a clean separation between your live operational stack (`current`) and your new experimental setup (`new-pipeline`), refactor your Terraform workspace into a modular pattern:

```text
infra/
├── modules/
│   └── nwf-app/
│       ├── main.tf          # Universal resource definitions
│       ├── variables.tf     # Slot inputs (environment, tags, image versions)
│       └── outputs.tf       # Service URLs, bucket names, topic IDs
└── slots/
    ├── current/
    │   ├── main.tf          # Instantiates module with environment = "current"
    │   ├── variables.tf     # Live environment overrides
    │   └── backend.tf       # State storage pointer for current
    └── new-pipeline/
        ├── main.tf          # Instantiates module with environment = "new"
        ├── variables.tf     # Experimental overrides
        └── backend.tf       # Separate state storage pointer for new-pipeline
```

---

## Part 3: Step-by-Step Implementation

### Step 1: Build the Reusable Core Module
Create `infra/modules/nwf-app/main.tf` to provision your audited GCP footprint parameterized by a slot suffix:

```hcl
variable "slot_name" {
  type        = string
  description = "Deployment slot identifier: e.g., current or new-pipeline"
}

variable "image_tag" {
  type        = string
  description = "Container image tag to deploy to Cloud Run"
}

# 1. Artifact Registry (Shared or Slot-Scoped)
resource "google_artifact_registry_repository" "repo" {
  location      = "us-central1"
  repository_id = "nwf-images-${var.slot_name}"
  description   = "Container repository for ${var.slot_name}"
  format        = "DOCKER"
}

# 2. Cloud Storage Staging Bucket
resource "google_storage_bucket" "staging" {
  name                        = "nwf-build-staging-${var.slot_name}"
  location                    = "US"
  uniform_bucket_level_access = true
}

# 3. Pub/Sub Topic for Scheduled Analysis
resource "google_pubsub_topic" "analysis_topic" {
  name = "nwf-daily-analysis-${var.slot_name}"
}

# 4. Cloud Run Service (`gcp3` backend)
resource "google_cloud_run_v2_service" "gcp3_api" {
  name     = "gcp3-api-${var.slot_name}"
  location = "us-central1"

  template {
    containers {
      image = "us-central1-docker.pkg.dev/${var.slot_name}-project/nwf-images-${var.slot_name}/gcp3:${var.image_tag}"
      env {
        name  = "SLOT"
        value = var.slot_name
      }
    }
  }
}

# 5. Cloud Scheduler Job
resource "google_cloud_scheduler_job" "refresh_job" {
  name             = "nwf-refresh-job-${var.slot_name}"
  schedule         ="0 8 * * 1-5"
  time_zone        = "America/New_York"
  attempt_deadline = "320s"

  http_target {
    http_method = "POST"
    uri         = "${google_cloud_run_v2_service.gcp3_api.uri}/api/refresh"
  }
}
```

### Step 2: Configure the `current` Slot Environment
Create `infra/slots/current/main.tf` to manage your existing live resources:

```hcl
terraform {
  backend "gcs" {
    bucket = "nwf-terraform-state-prod"
    prefix = "slots/current"
  }
}

provider "google" {
  project = "nwf-production-project"
  region  = "us-central1"
}

module "nwf_current" {
  source    = "../../modules/nwf-app"
  slot_name = "current"
  image_tag = "v1.4.2"
}
```

### Step 3: Configure the `new-pipeline` Slot Environment
Create `infra/slots/new-pipeline/main.tf` for your isolated experimental pipeline:

```hcl
terraform {
  backend "gcs" {
    bucket = "nwf-terraform-state-prod"
    prefix = "slots/new-pipeline"
  }
}

provider "google" {
  project = "nwf-production-project"
  region  = "us-central1"
}

module "nwf_new" {
  source    = "../../modules/nwf-app"
  slot_name = "new-pipeline"
  image_tag = "latest-experimental"
}
```

---

## Part 4: Verification and Deployment Workflow

1. **Initialize Current Slot:**
   ```bash
   cd infra/slots/current
   terraform init
   terraform plan
   ```
2. **Initialize New Slot:**
   ```bash
   cd infra/slots/new-pipeline
   terraform init
   terraform plan -out=plan.out
   ```
3. **Safe Promotion:** Once your `new-pipeline` slot validates successfully via Cloud Logging and Cloud Monitoring checks, update your image tag or routing parameters to shift production traffic over safely.