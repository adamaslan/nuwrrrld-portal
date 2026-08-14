# Modal pipeline — remaining issues

Status as of the 2026-07-15 test run of `modal run homebase/modal_locrun.py --universe beta1`.
Firestore writes and the portal push are now working. Two things still fail.

## 1. GCP3 backend `/refresh/bake` and `/refresh/ai-summary` → 401

**Where:** `locrun.py:208-211`

```python
for endpoint in ["/refresh/bake", "/refresh/ai-summary"]:
    r = requests.post(f"{GCP3_URL}{endpoint}", timeout=30)
```

**Why it fails:** the request carries no `Authorization` or `X-Scheduler-Token`
header at all. The gcp3 backend's `_verify_scheduler()`
(`gcp3/backend/main.py:524-555`) requires one of:

- a Google-signed OIDC bearer token whose `email` claim matches
  `SCHEDULER_EXPECTED_SA` (the real Cloud Scheduler path), or
- header `X-Scheduler-Token: <value>` matching the `SCHEDULER_SECRET` env var
  (the manual/local fallback).

Since neither is sent, every call 401s — this isn't a secret-value problem,
it's a missing-header problem.

**Fix options:**

- **Minimal:** add `SCHEDULER_SECRET` to the Modal secret bundle
  (`nuwrrrld-secrets`) and send it from `locrun.py`:
  ```python
  headers = {"X-Scheduler-Token": os.environ.get("SCHEDULER_SECRET", "")}
  r = requests.post(f"{GCP3_URL}{endpoint}", headers=headers, timeout=30)
  ```
  Requires knowing (or resetting) the value of `SCHEDULER_SECRET` currently
  configured on the gcp3 Cloud Run service — check
  `gcloud run services describe gcp3-backend --region=us-central1` or the
  Cloud Run console env vars.
- **Correct long-term:** mint a Google-signed OIDC token for the dedicated
  scheduler service account and send it as `Authorization: Bearer <token>`,
  matching how real Cloud Scheduler calls this endpoint. From Modal this
  means loading a service-account key with
  `iam.serviceAccounts.getOpenIdToken` permission for
  `gcp3-scheduler@ttb-lang1.iam.gserviceaccount.com` — more setup, but avoids
  a second shared secret.
- Either way, confirm whether these two calls are actually needed from
  `locrun.py` at all — they may be redundant with gcp3's own Cloud Scheduler
  trigger, in which case the simplest fix is to drop the calls from
  `locrun.py` entirely.

## 2. Zo space push fails

**Where:** `locrun.py:634-652` → `zo_integration.push_briefing_to_zo_space()`
→ `ZoClient.write_space_route()` / `.publish_site()`

**Why it fails:** unlike the gcp3 calls, this is a plain REST client
(`zo_integration.py:58-153`) authenticated with `ZO_API_KEY` via
`Authorization: Bearer`, and the Modal secret already includes
`ZO_API_KEY`. So this isn't a missing-credential issue — the failure is
swallowed silently:

```python
try:
    ...
    ok = push_briefing_to_zo_space(briefing_obj)
    print(f"  {'✓ published to zo.space' if ok else '⚠ zo.space push failed'}")
except Exception as _zo_err:
    print(f"  ⚠ Zo push skipped: {_zo_err}")
```

`push_briefing_to_zo_space` catches its own exception and returns `False`
without surfacing the underlying `requests` error (status code / body), so
the true cause (bad key, wrong path, Zo API error, network/DNS from Modal's
sandbox, etc.) is currently invisible.

**Fix:**

1. Temporarily log the real exception instead of swallowing it, e.g. in
   `zo_integration.py:223-225`:
   ```python
   except Exception as e:
       log.warning("push_briefing_to_zo_space failed: %s", e, exc_info=True)
       return False
   ```
2. Re-run `modal run homebase/modal_locrun.py --universe beta1 --zo-push`
   (dry-run is off) and read the actual error — likely one of:
   - `ZO_API_KEY` in the Modal secret is stale/rotated vs. the key active on
     `chillcoder.zo.computer`
   - the `/space/routes` or `/space/publish` endpoint path changed
   - Modal's outbound network can reach `zo.computer` fine, but the response
     is a non-2xx that `raise_for_status()` turns into an `HTTPError` — the
     status code will say which
3. Once the real cause is visible, it's a one-line fix (rotate key, fix
   path, etc.) rather than more guessing.

## Suggested order

1. Add the swallowed-exception logging fix for Zo (#2) — cheapest, and
   turns a silent failure into an actionable one on the next run.
2. Decide whether gcp3's `/refresh/bake` + `/refresh/ai-summary` calls from
   `locrun.py` are still needed; if yes, add `SCHEDULER_SECRET` + the
   `X-Scheduler-Token` header (#1 minimal fix) as the fastest unblock.
