# Simulator fidelity measurement

Measured 2026-11-16 against the unchanged three-entry human seed fixture in
`__tests__/fixtures/followed-tickers-gold-set.json`, using `judge_sim_v1`.
Every result is SIMULATED. This measures the deterministic simulator, not a
real Judge run, live outcome accuracy or the real scorecard.

| Human seed entry | Human total | SIMULATED total | Within ±1 |
| --- | ---: | ---: | --- |
| gold-excellent-01 | 10 | 3 | No |
| gold-mediocre-01 | 5 | 2 | No |
| gold-ungrounded-01 | 1 | 1 | Yes |

Agreement: **1/3 (33.33%)**, below the **80%** target. The simulator does not
meet the fidelity target. A three-entry seed is small and is not an estimate
of general performance. No gold totals, fixtures or simulator scoring were
changed to improve the number.

The seed briefs predate the simulator's quoted RULES input format. The
simulator therefore cannot match their BACKTEST HIT-RATES evidence as RULES.
Missing declared confidence is not invented. These are compatibility limits,
not grounds to silently rewrite the human fixture or relax the target.

Reproduce from the repository root:

```sh
node node_modules/tsx/dist/cli.mjs scripts/report-judge-sim-fidelity.ts
node node_modules/vitest/vitest.mjs run --project unit __tests__/judge-sim-fidelity.test.ts
```

The report shares only the real gate's tolerance and threshold constants.
It does not invoke the real gate, write storage, call a model, publish grades
or change any scheduled job. `publicationEligible` is always false, even on
synthetic controls that meet the target. Passing this measurement would not
authorize simulator scores in the real `v1` series. Full end-to-end storage
and scorecard isolation acceptance remains separate work (T-021/T-022).

T-019/T-020 are the source and measurement scope. The four tests check truthful
seed reporting without mutation, exact tolerance/threshold boundaries,
SIMULATED labels and empty failure, and invalid human-total/identity refusal.
Before implementation the new suite cannot load the absent harness module;
after implementation all four pass. That is missing-feature evidence, not
an existing production regression or a demonstrated real Judge improvement.
