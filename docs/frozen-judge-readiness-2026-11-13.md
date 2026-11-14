# Local candidate: frozen selection-day Judge context

Not published, deployed, run against providers, or run against a database.
Base: nuwrrrld-portal 470bda6cf6c6f120bd4602bcbe1d5c3f229d29fa.

## Correctness changes

- Author stores the exact generated brief before calling its model, together with ticker, version and capture time in the existing raw council JSON payload.
- Grader uses only that frozen brief, never reconstructs historical context from current data.
- Sample selection joins the New York selection-day observation, not max/latest observation. Missing originals stay in the sample and are explicitly skipped.
- Consumption checks ticker equality, capture not before selection, and matching New York selection/observation/capture day. Legacy, mismatched and late contexts do not receive a grade.
- The complete checked-in gold-set size stays the denominator even when individual model replies cannot be parsed. The 80% gate is unchanged.
- Sample query failure is a 503 with published=false, not an empty successful run.
- Judge version becomes v2-frozen-selection-day. Existing stored grades are not rewritten or backfilled.

## Readiness and privacy gates

This is source candidate work, not authorization to activate. Retaining a full brief permanently in council_json is NEW data retention. Existing author-model transmission does not authorize this retention or any additional judge-model disclosure. Review brief contents, destinations, service permissions, retention and access before activation. There is no new raw private data in this patch or its synthetic tests.

This conservatively grades same-day observer verdicts, not a cryptographically frozen exact cohort-selection prediction. It skips missing entry-day context rather than substituting a later verdict. A stronger design should persist an explicit prediction ID, immutable original payload and precise price/prediction timestamp at selection, then join every horizon to that identity. Existing daily observation upsert can replace same-day data. Later schema work must resolve that before calling this a fully immutable prediction/outcome ledger.

Current weekly sample window still excludes older ungraded resolved rows. No catch-up/backfill is implemented or authorized here. Dashboard now loads existing judge_version and filters current-series mean/cards/quadrants; old/unknown grades are explicitly excluded and counted, outcome-only scoreboard totals stay unchanged. UI labels the selected research series and mutable same-day limitation. No version comparator UI or historical backfill is implemented. The existing gold-set file metadata remains v1 because the manually scored rubric examples did not change; actual persisted grading version is v2. Gold loading/schema validation and judge model independence across fallback chains remain separate review gaps.

## Local checks

56 focused injected tests passed across frozen-context helper, author, route, DB query shape, rubric, leak guard and auth gates. TypeScript, focused eslint and git diff --check passed. All provider and DB effects in new tests are mocks. Local390/1280synthetic component pixels inspected. Screenshots are explicitly LOCAL SYNTHETIC FIXTURE, not deployed preview or production. No product activation claim.

Final factual-label correction removes all inferred strategy/reasoning causal labels. A series with no grades renders explicit no-measurements text and hides numeric quadrants, not measured zeros. Actual local390/1280 component pixels and390empty-state pixels inspected; 142component tests passed. This is local fixture proof, not actual authenticated page or deployment proof.
