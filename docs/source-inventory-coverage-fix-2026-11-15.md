# Source inventory and final hydration completeness

November15,2026. Source-only candidate against aedf972. Not merged, deployed or runtime validated. No compute jobs, providers, database operations, schedules, migrations or billing controls were invoked.

## D12 source inventory

Catalog covers all5 tracked deploy/*/modal_app.py definitions, including nwf4 and general backend. Every Modal entry says deployment and live schedule unverified. Source schedules are not deployment evidence. Free-model-refresh source is Wednesday09:00UTC, not catalog's Monday. GitHub Actions hydration workflow source has15:00and22:30UTC; separate Modal hydration app source has00:05UTCdaily. These are different owning schedulers, not two versions of one verified runtime schedule. GitHub descriptions allow workflow-declared timezones. This does not change schedules or claim to fix delivery delays.

Actual ScheduledWorkSection rendered with synthetic/no-live-run data. Desktop and390px mobile screenshots inspected: all5cards readable, explicit unverified labels, no horizontal overflow. This is a component fixture, not an authenticated production page.

## D13 denominator separation

Finalization previously derived expected and filled from the same caller-supplied item list minus skips. A clean list could omit active symbols and still report100%. Finalization now reads coverageForUniverseAndDate independently. Persisted coverage uses active-ticker counts at the requested bar date; supplied-item counts remain separately named batchCoverage/batchStatus. Unknown/empty independent coverage fails closed. A clean batch with99/100active tickers finalizes partial,50/100fails. Intermediate batch grading is unchanged and is not treated as whole-universe failure.

Boundary: this uses CURRENT active universe membership and ANY stored horizon at the requested bar date. It is not a frozen historical membership snapshot, per-horizon completeness, proof that this exact run wrote the cards, feed/source parity or fully reconciled skipped/unservable symbols. Those need a dated run manifest and provenance contract, not inferred migrations. Existing direct GCP writer already records expectedCards from selected universe*2, so the old audit claim should not be applied indiscriminately to every writer.

## Checks and review

28 unit/mock-route tests and8component/accessibility tests pass. Full TypeScript check passes. Targeted lint and diff checks required before publication. No full Next build or live route was run. Independent qualified review and exact-head build remain required; author does not merge. No news weight or control inception change.
