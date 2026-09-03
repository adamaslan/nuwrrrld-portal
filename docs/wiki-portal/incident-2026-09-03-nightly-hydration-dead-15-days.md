---
date: 2026-09-03
type: incident
tags: [pipeline, hydration, github-actions, secrets, monitoring, coverage, staleness]
sources: [../signal-engine-parity-across-hosts.md, ../../.github/workflows/hydrate-universe.yml, ../../scripts/sync-hydration-secrets.sh, ../../scripts/hydrate-local.mjs]
---

# Incident — Nightly Universe Hydration Silently Dead for 15 Days

## Date & severity

**2026-09-03**, discovered during the signal-engine parity audit (PR #100).
**High.** No new `ticker_cards` rows had been written in 15 days; every
downstream ranking, cohort selection and precompute-AI subject pick was reading
data frozen at `bar_date = 2026-08-19`.

## What happened

`.github/workflows/hydrate-universe.yml` is scheduled `30 22 * * 1-5`. Every
scheduled run since 2026-08-19 failed in ~25–30 seconds — **11 consecutive red
runs**, unbroken — before making a single Alpaca call. The failure was always
the workflow's own preflight guard:

```
##[error]PORTAL_PUSH_SECRET is not set — the portal will reject every POST.
##[error]Process completed with exit code 1.
```

`ticker_cards` held 1,864 rows, 100 % `source = hydrate-local`, newest
`bar_date` 2026-08-19. Nothing surfaced the red runs to a human; the staleness
was found only because the audit queried `max(bar_date)`.

## Root cause

`PORTAL_PUSH_SECRET`, `ALPACA_API_KEY`, and `ALPACA_API_SECRET` **do not exist
as GitHub repo secrets** (confirmed via `gh secret list` — 17 other secrets
do). [[entity-ticker-universe-pipeline]] Known failure #4 recorded PR #74 as
"half-closed": the workflow and `scripts/sync-hydration-secrets.sh` shipped,
but the doc's own caveat — *"Once a human runs that sync once"* — was never
satisfied. The sync script was never run, so the workflow has never had the
secrets it needs, from its first scheduled fire onward.

Two contributing design gaps:

1. **No alerting on a red scheduled run.** The workflow has no `if: failure()`
   notification step. A scheduled workflow that fails produces a red mark in a
   tab nobody opens.
2. **No writer-independent freshness check.** Every guard that could catch this
   lives *inside* the writer, and the writer never ran. Only an external
   assertion on `max(bar_date) FROM ticker_cards` would have caught a broken
   writer.

## Resolution

Not yet fixed at time of writing — PR #100 documents it as finding §0.1 and
proposes remediation **R0** in `../signal-engine-parity-across-hosts.md`:

1. Restore the three secrets via `scripts/sync-hydration-secrets.sh` (pipes
   values file → CLI, never through an LLM context — see the `secrets-sync`
   skill), then a `gh workflow run hydrate-universe.yml -f limit=25` smoke test.
2. Add an `if: failure()` step that notifies a channel a human reads.
3. Add a scheduled freshness assertion (or fold one into
   `afternoon-pipeline.yml`) that fails when `max(bar_date)` is more than ~3
   trading days old.

Requires an operator with the secret values; cannot be done from inside a
session.

## Impact on design

- **Confirms the failure class from Known failure #7** (empty ranking, nothing
  detected it) generalizes: a *loud* per-run failure is still silent if no one
  is subscribed to it. "Fails red" is necessary, not sufficient.
- **Staleness is the symptom that survives every cause.** A freshness check on
  the output table is the only assertion that catches a broken writer,
  regardless of *why* it broke. This is now R0 in the parity doc.
- Reframes "GHA is the live scheduler" throughout the docs: true of the cron
  definition, false of observed behavior. Nothing has hydrated the universe on
  a schedule, ever — every card in the table came from a human running
  `scripts/hydrate-local.mjs`.
- Feeds [[concept-free-tier-resilience]]: the pipeline degraded to "serve the
  last good cards" exactly as designed, which is why it stayed invisible.
  Graceful degradation without a staleness signal is indistinguishable from
  health.

## Open items

- [ ] R0.1 — three repo secrets restored, nightly run green
- [ ] R0.2 — failure notification wired
- [ ] R0.3 — writer-independent freshness check live
- [ ] `entity-ticker-universe-pipeline` Known failure #4 updated from
      "half-closed" to reflect that the sync was never run
- [ ] Decide whether the freshness check belongs in its own workflow or in
      `afternoon-pipeline.yml`

## See also

- [[entity-ticker-universe-pipeline]] — the pipeline this broke; Known
  failures #4 (secrets) and #7 (undetected empty ranking)
- [[concept-signal-engine-host-parity]] — the audit that surfaced this;
  confluence drift is finding §2, this is §0.1 and outranks it
- [[concept-free-tier-resilience]] — why "serve last good cards" hid the outage
- [[incident-2026-08-18-modal-under-recommended]] — the other half of "the
  scheduled lane isn't actually running"
- `../signal-engine-parity-across-hosts.md` — full findings and remediation R0–R7
