# Production Judge: frozen-input and gold denominator candidate

November15,2026. Base portal aedf972. Code-only candidate, not merged, deployed or runtime validated. No models, databases, scheduler, migration or billing operations were used. Author implementation does not clear independent review or release gates.

## Changes

- Missing/unparseable gold grades remain failures in the full gold-set denominator. Before this change, one correct response and two missing responses passed100%; now they fail at1/3.
- New council verdict JSON stores exact author brief and actual served model. Judge reads that frozen context instead of rebuilding a tickerless present-day brief.
- Historical context, malformed/oversized context and validator-flagged verdicts are not graded. No historical context is invented.
- Different seat names do not establish different actual models. If fallback serves the author model, this candidate discards the self-grade. It does not change the runtime provider chain.

## Tests

37 targeted tests pass across eval-judge, outcome-leak, observation-first, frozen-context and mocked production route. They cover gold denominator wiring, original brief reuse, historical fail-closed behavior and same actual-model rejection. Full TypeScript check and changed-file ESLint pass. Tests mock model, DB and run logging. They do not prove production freshness, independence of underlying model families or provider delivery. No UI changed.

## Unresolved, not silently repaired

- D3 manual gold expansion: fixture explicitly requires manual labels, not model-generated self-labels. Three seeds still demand all3 agree for an80%threshold.
- D5 query still limits resolved scores to7days and joins latest observation. Frozen inputs prevent time-travel evidence inside a selected verdict, but do not prove that verdict belongs to the original pick/horizon. Historical score-to-verdict binding and bounded catch-up need an explicit provenance contract. Old grades are not rewritten.
- Provider model aliases/families can be equivalent even when ID strings differ. Equality rejection is a fail-closed improvement, not proof of independent model families.
- Gold calls can be served by different fallback models; gate quality is not yet stratified by actual model. Judge rubric version remains v1; publish only after a reviewer decides whether new-series versioning/storage is needed.
- Followup makes production sample reads throw on DB failure, logs status fail and returns503instead of empty success. Historical binding and7dayselection remain unchanged.
- Runtime has not been invoked. Release needs independent qualified review, verified source/deploy parity and authorized observation of real next-run outputs. No provider/DB backfill authority follows from offline tests.
