# Portfolio Health TODO — what's still wrong with the score

Everything still open on the portfolio-health surface (`/api/portfolio/health`,
`/api/portfolio/suggestions`, `/api/portfolio/health-ai`,
`/dashboard/portfolio`), after PR #123 made the score compute locally from
`ticker_cards` instead of waiting on gcp3's never-deployed route.

**Written 2026-09-14**, from live measurement against the production Neon
branch and the live gcp3 backend — not from reading the code. Every number
below was observed today; the commands that produced them are inline so they
can be re-run rather than trusted.

The headline: **the score works, and it is currently lying about its own
freshness.** §0 is the whole reason this file exists.

Companion files — keep the boundaries straight:

| File | Holds |
|---|---|
| this file | portfolio-health work that is a **code change** |
| [manual-setup-todo.md](manual-setup-todo.md) | items blocked on a **human** (a login, a secret, a decision) |
| [wiki-portal/incident-2026-07-26-portfolio-health-endpoint-missing.md](wiki-portal/incident-2026-07-26-portfolio-health-endpoint-missing.md) | the history and why the local path exists |
| [wiki-portal/decision-local-portfolio-scoring-over-upstream-wait.md](wiki-portal/decision-local-portfolio-scoring-over-upstream-wait.md) | the design call PR #123 made |

Ordered by what unblocks the most.

---

## 0. 🔴 The score claims "Latest bar 2026-09-13" while 95% of its inputs are from 2026-08-19

**This is a defect in the code PR #123 shipped, not an upstream problem.**
Observed today against production:

```sql
SELECT bar_date::date, round(avg(data_quality)::numeric,3) AS avg_dq, count(*)
FROM ticker_cards WHERE horizon='t1' GROUP BY 1 ORDER BY 1 DESC;
```

| bar_date | cards | avg `data_quality` |
|---|---|---|
| 2026-09-13 | 50 | **1.000** |
| 2026-09-05 | 1 | 0.800 |
| **2026-08-19** | **867** | **1.000** |
| 2026-08-18 | 14 | 0.800 |

A 936-ticker watchlist scores **74 / Grade C**, and its summary line reads
*"Latest bar 2026-09-13."* That sentence is true and misleading: 882 of the 932
covered cards are **26 days old**. `localPortfolioHealth` computes `barDate` as
the `max()` across the cards it read, so one fresh card re-dates the entire
portfolio.

**The sharper half — quality-weighting does not help, and I claimed it would.**
`lib/shared/portfolio-health-policy.ts`'s `buildSignalFactor` weights each card
by `dataQuality` on the documented rationale that a degraded card "should not
outvote a clean one." But `dataQuality` is computed *at hydration time* and
stored. `card-policy.barQuality()` measures `staleTradingDays` against the day
the card was built — so the 867 cards from 2026-08-19 were fresh **when
measured** and froze at `1.000`. The weighting discounts cards that were bad on
arrival; it does nothing at all about cards that went stale afterward, which is
the failure mode that actually occurs.

This is the open item the incident page filed as *"the cards can be stale and
the score does not say how stale"* — now measured, live, and worse than filed,
because the freshness signal is not merely absent but actively wrong.

**Fix, roughly in order of value:**

1. **Stop reporting `max(bar_date)` as the portfolio's bar date.** Report the
   distribution, or the median, or both — `"50 cards from 2026-09-13, 882 from
   2026-08-19"`. A single date cannot describe this set honestly.
2. **Re-derive staleness at read time**, not from stored `data_quality`. The
   read already has `bar_date`; trading days between it and today is the
   number that matters, and it is free to compute in `readCards`.
3. **Add a `Signal freshness` factor**, and unlike coverage, consider scoring
   it. Coverage is excluded from the score deliberately (§3) because "we have
   no data" must not read as "this is bad." Staleness is different: month-old
   signals genuinely *are* a worse basis for a grade, and saying so is honest
   rather than conflating.
4. **Decide the floor.** At what age does a card stop counting? If 95% of a
   portfolio is a month stale, arguably there is no score — the same terminal
   honest state §0's own design already returns for zero coverage.

**Do not fix this by hiding stale cards.** Dropping them silently shrinks the
scored portfolio, which is the exact substitution
[wiki-portal/concept-graceful-degradation.md](wiki-portal/concept-graceful-degradation.md)
warns about. Count them, weight them down, and say so.

---

## 1. 🔴 `health-ai` still doesn't consume the score that now exists

`app/api/portfolio/health-ai/route.ts:18` still has its own `fetchHealth()`
calling `{MCP_BACKEND_URL}/api/portfolio/health` directly. That URL has never
resolved (§6). So the AI narrative degrades to *"Portfolio health data:
unavailable (no GCP3 backend connection)"* and narrates a portfolio it was
handed no data about — which it has done since it shipped.

What changed on 2026-09-11 is that this is now **needless**.
`localPortfolioHealth(tickers)` returns a real, factor-level score one import
away. The obligation recorded on
[wiki-portal/concept-graceful-degradation.md](wiki-portal/concept-graceful-degradation.md)
— *health-ai falls back to the deterministic score rather than erroring* — has
been satisfiable for three days and is still unsatisfied.

**Fix:** point `fetchHealth` at `localPortfolioHealth` on upstream failure,
exactly as `health/route.ts` does. Keep the `X-Portfolio-Health-Grounded`
header honest: grounded becomes true when the local score is used, because it
*is* grounding — but see §0, since grounding an LLM narrative in silently
month-old data is a worse failure than ungrounding it loudly.

Left out of PR #123 deliberately, to keep the fallback change reviewable alone.
That reason has expired.

---

## 2. 🟠 The nightly hydration is succeeding on a technicality

The dependency §0 created is not healthy. `gh run list --workflow=hydrate-universe.yml`:

| Date | Result |
|---|---|
| 2026-09-13 | ✅ success — but `workflow_dispatch`, `IN_LIMIT: 25` |
| 2026-09-12 | ❌ failure |
| 2026-09-11 | ❌ failure |
| 2026-09-10 | ❌ failure |
| 2026-09-09 | ❌ failure |
| 2026-09-08 | ❌ failure |

The only green run in a week was a **manual, limited smoke test**. The
scheduled nightly has not carded the universe at all. This is
[wiki-portal/incident-2026-09-03-nightly-hydration-dead-15-days.md](wiki-portal/incident-2026-09-03-nightly-hydration-dead-15-days.md)
still in progress, not resolved — and now it has a second, user-visible
consumer that did not exist when that incident was written.

> ❓ **Discrepancy worth chasing before trusting either number:** the dispatch
> passed `--limit=25`, but 50 `t1` cards carry the 2026-09-13 bar. Either the
> limit applies per-horizon-pair, or it is not doing what its name says. Read
> the run log rather than assuming; if `--limit` is off by 2×, every
> capacity estimate built on it is too.

The failing runs' root cause belongs in
[manual-setup-todo.md](manual-setup-todo.md) if it is secrets again. The
**code** item here: a run that writes 50 of 932 cards should not report
success to anything that reads it as coverage.

---

## 3. 🟠 "Signal coverage: 100" is technically true and practically false

The coverage factor reports *932 of 936 tickers had a computed signal* →
`score: 100, impact: neutral`. Correct by its own definition, and it renders
beside a Grade C as though the inputs were complete. They are 26 days old
(§0).

Coverage answers *"did we have a card?"* — nobody's actual question, which is
*"do we have a card worth using?"* Either fold recency into coverage, or ship
the separate freshness factor from §0.4 so the two questions stop being
answered by one number.

Keep `impact: neutral` and keep it out of the score, for the reason already
documented in the policy module: a thinly-covered portfolio must not be
arithmetically indistinguishable from an unhealthy one. That rationale is
correct and unchanged by this item.

---

## 4. 🟡 Mobile renders a locally-computed score with no provenance

`/api/portfolio/health` returns `X-Portfolio-Health-Source: upstream|local`;
`PortfolioClient.tsx` renders a line from it. `gcp3-mobile`'s
`lib/usePortfolio.ts` does not read the header, so mobile presents a
portal-computed score as though it came from the documented backend.

Mobile's Portfolio tab was repaired by PR #123 with **zero mobile commits** —
it calls the portal route — so the fix reached it for free and the *honesty*
half did not.

**Fix (mobile repo):** read the header in `usePortfolio.ts`, render a label in
`PortfolioScreen.tsx` matching web's `.port-health-source`. Three lines plus a
string.

Tracked at
[wiki-portal/concept-sync-requirements.md](wiki-portal/concept-sync-requirements.md)
§2. Note the general lesson recorded there: **`shared-drift-check` cannot see
this class of drift.** No `lib/shared/` file diverged; the surfaces diverge on
a response field one client reads and the other ignores. Adding a header is a
cross-surface contract change.

---

## 5. 🟡 The score's weights have never been validated against anything

`0.45` signal / `0.30` directional / `0.25` diversification, and a ten-name
diversification target, are reasoned — not fitted. Nothing measures whether a
Grade-B watchlist subsequently behaves differently from a Grade-D one.

Shipping an unvalidated heuristic was defensible when the alternative was no
score at all. That trade should be **revisited, not inherited**.
[wiki-portal/entity-backtest-engine.md](wiki-portal/entity-backtest-engine.md)
is where the question would be answered and is not wired to it.

Concretely: grade the ~8 seeded paper portfolios (PRs #124/#127/#128) on day 0,
then compare realized returns by grade. That machinery now exists and did not
when the scorer was written.

---

## 6. 🟢 gcp3's upstream route is still absent — 50 days on. Delete the path?

Re-checked today: the live backend's OpenAPI lists **39 paths, none containing
`portfolio`**. Unchanged since 2026-07-26, now across five confirmations.

```bash
curl -s "$MCP_BACKEND_URL/openapi.json" | jq '.paths | keys | map(select(contains("portfolio")))'
# []
```

Both routes still call it first and still eat a timeout budget on every cache
miss before falling back. Open design question, not a bug:

- **Keep it** — costs one failed fetch per cache miss, and the day gcp3 ships
  the route it resumes winning with no code change (the liveness test logs the
  switch).
- **Delete it** — removes a branch that has never once executed successfully,
  and stops pretending a dependency exists.

Leaning keep, because the cost is bounded and the fallback is exercised on
every single request, which is the strongest possible evidence it works. But
**50 days of a never-taken branch is worth an explicit decision** rather than
another month of default.

---

## 7. 🟢 `health-ai` is unmetered

No rate limit, no token accounting — unlike `/api/nuai`'s `checkRateLimit` +
`getRemainingBudget` + `recordUsage`. It bypasses `NU_AI_DAILY_TOKEN_BUDGET`
entirely. An unmetered model-call path on a Pro-gated button.

Pre-dates all of the above; carried forward from the incident's Open items so
it does not get lost now that its neighbours are closing.

---

## 8. ❓ Is a ~1000-ticker watchlist a real user state?

`scripts/seed-watchlist-universe.mjs` makes one reachable, and two accounts
now have one (936 and 934 tickers). That surfaced a real UI bug — the panel
rendered every row on mount — now fixed with a filter and a 50-row window.

The deeper question is unresolved: a watchlist of the entire universe is not a
watchlist, it is a screener wearing the watchlist's clothes. Every downstream
consumer treats it as a portfolio, and "your portfolio" being 932 equal-weight
names makes `Diversification: 100` true and meaningless.

Decide whether to cap it, or to split "watchlist" from "universe subscription"
as distinct concepts. Related: §5's paper portfolios are the surface that
actually wants a real portfolio shape.

---

## Verification commands

Re-derive everything above rather than trusting this file's numbers:

```bash
# Card freshness distribution — the §0 table
node --env-file=.env.local -e '
  const { neon } = require("@neondatabase/serverless");
  neon(process.env.DATABASE_URL).query(`
    SELECT bar_date::date AS bar, round(avg(data_quality)::numeric,3) AS avg_dq, count(*) AS n
    FROM ticker_cards WHERE horizon=$1 GROUP BY 1 ORDER BY 1 DESC`, ["t1"])
    .then(r => console.table(r));
'

# Live score for a real watchlist, through the real code path
npx vitest run --project live __tests__/live/portfolio-health.live.test.ts

# Does gcp3 have a portfolio route yet?
curl -s "$MCP_BACKEND_URL/openapi.json" | jq '.paths | keys | length'

# Hydration run history
gh run list --workflow=hydrate-universe.yml --limit 10
```
