# Nulogdash quality evidence review prompts

These prompts are for focused review of the local `nulogdash-quality/v1`
contract and its existing runner, report, and dashboard readers. They use only
the synthetic fixtures in the focused tests. Do not call providers, databases,
or the NWF workload pipeline. A reviewer should report only what the artifact
and code prove.

## Contract and fail-closed prompt

> Act as a fail-closed evidence auditor for Nulogdash quality results. Inspect
> only the `nulogdash-quality/v1` contract, its readers/evaluator, and the
> deterministic tests. For each case below, report three independent outcomes:
> (1) transport/job outcome, (2) useful workload coverage, and (3) measured
> quality. Include observed value, eligible and measured denominators, target,
> rationale, and any insufficient/blocked reason. Treat absent evidence as
> missing; preserve explicit SQL `NULL`; never infer quality from job status,
> training-corpus accuracy, a target, or a synthetic fixture. Flag any path that
> can turn missing, malformed, empty, skipped, deferred, errored, or zero-label
> evidence green. Return a compact table and cite the test/code location for
> each conclusion. If data is not locally present, say it is unrecovered.
>
> Evaluate these cases separately: (a) transport says `ok` but quality values
> and workload denominators are absent; (b) `deltaIC` is explicitly SQL `NULL`;
> (c) observed numeric zero with complete denominators and a zero target; (d)
> zero useful labels and an empty item array; (e) mixed useful plus skipped,
> deferred, or errored items; (f) malformed versioned evidence; and (g) a legacy
> operational report with no quality artifact.

## Reader and display prompt

> Review the existing dashboard and HTML report readers using only the
> synthetic desktop/mobile fixtures. Confirm that raw operational summaries
> remain visibly separate from quality, legacy reports state “quality not
> recorded,” and unavailable values/denominators render as unavailable rather
> than zero or a pass. Check that the artifact retains source/run/evaluator
> versions, cutoff, scope, observed value/null, denominators, target/rationale,
> and reason. Report only visible, reproducible issues; do not claim deployed
> parity or recover actual NWF/news metrics from these fixtures.

## Local regression cases already encoded

`__tests__/nulogdash-quality.test.ts` covers the contract cases above, including
the key distinction between a real measured numeric zero and missing evidence.
`app/dashboard/nulogdash/page.test.tsx` covers missing-quality dashboard
rendering and accessibility. These prompts are review aids; they do not claim
that a model/provider was called or that unrecovered production results were
obtained.
