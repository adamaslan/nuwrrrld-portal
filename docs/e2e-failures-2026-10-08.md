# e2e failures — 2026-10-08

Recorded while merging PR #234 (`fix(digest): durable stale fallback`). PR #234 was
merged with red e2e checks because none of the failures touch the digest code it
changes.

## PR #234's e2e run (before the rebase, base `53adcb8`)

| Shard | Test | Error |
|---|---|---|
| e2e (1) | `e2e/frontend/dashboard-brief-fault-injection.spec.ts:90` — real `/api/brief` renders a non-empty brief | `expect(locator).toBeVisible()` failed; server log `Brief error Error: OpenRouter 404: all models in chain failed` |
| e2e (4) | `e2e/frontend/portfolio-liveness.spec.ts:86` — `/api/portfolio/health-ai` reaches OpenRouter | `unexpected status: {"error":"AI unavailable"}`; server log `Health AI error Error: OpenRouter 404: all models in chain failed` |
| e2e (4) | `e2e/frontend/portfolio-liveness.spec.ts:42` — `/api/portfolio/health` score | flaky (passed on retry) |

**Root cause:** every model in the OpenRouter fallback chain returned 404. The head
`qwen :free` model was withdrawn upstream.

## After PR #239 (`fix(openrouter): drop withdrawn qwen :free head`) landed on main

The latest e2e run on `main` (`eb033ca`) has **one** failure left:

- `dashboard-brief-fault-injection.spec.ts:90` — real `/api/brief` brief does not render.

The `portfolio-liveness` health-AI failure is gone, which matches #239 fixing the
chain for that route. Nobody has diagnosed why the brief route still fails. The
likely cause is that `/api/brief`'s chain still has no model that returns 200 from
CI, but nobody has checked this.

## Next check

Read the brief error from the latest main run:

```bash
cd ~/code/nuwrrrld-portal
RID=$(gh run list --branch main --workflow e2e-resiliency.yml --limit 1 --json databaseId -q '.[0].databaseId')
gh run view "$RID" --log | grep -E "Brief error|OpenRouter [0-9]{3}" | head
```

Then check which models the brief route's chain tries:

```bash
cd ~/code/nuwrrrld-portal
grep -rn "free\|MODEL" lib/openrouter.ts | head -30
```

## PR #235's e2e run (`feat(tools): nwf-lab`, run `37828569453`)

PR #235 adds only `tools/nwf-lab/` (Python) and docs. It changes nothing in the
Next.js app. Its red e2e run used a base from before #239, and it shows the same
OpenRouter-404 signature as #234's run:

| Shard | Test | Error |
|---|---|---|
| e2e (1) | `e2e/frontend/dashboard-brief-fault-injection.spec.ts:90`: real `/api/brief` renders a non-empty brief | `expect(locator).toBeVisible()` failed, element not found; server log `Brief error Error: OpenRouter 404: all models in chain failed` |
| e2e (4) | `e2e/frontend/portfolio-liveness.spec.ts:86`: `/api/portfolio/health-ai` reaches OpenRouter | expected 200, received 503 `{"error":"AI unavailable"}`; server log `Health AI error Error: OpenRouter 404: all models in chain failed` |

Both failed on retry too. Shards 2 and 3 passed. The same shard (4) logged
`[signals/chat] local path failed for SOXX/MU/GOOG: no signal data available`,
but it was not a failing assertion.

The branch was rebased onto `main` after #239. Re-check the new run:

```bash
cd ~/code/nuwrrrld-portal
gh pr checks 235
```

If shard 4 turns green and shard 1 stays red, the result matches the
"brief route still fails" note above. It is not caused by this PR.

### Re-run after the rebase onto `916cc31` (with #239)

The OpenRouter-404 failures are gone, and shards 1–3 passed. Shard 4 fails with
a **different, new cause**, a Playwright strict-mode violation in the
`portfolio-liveness` `beforeEach`:

- `e2e/frontend/portfolio-liveness.spec.ts:37` calls `page.getByPlaceholder(/ticker/i)`.
  That now matches two inputs on `/dashboard/portfolio`: `Add ticker (e.g. AAPL)` and
  the new watchlist filter `Filter 148 tickers…` (`aria-label="Filter watchlist"`,
  in `app/dashboard/portfolio/PortfolioClient.tsx`).
- So every test in the describe block fails before it asserts anything. That
  includes `:42` (health score) and `:86` (health AI). The OpenRouter 503 seen
  earlier is masked by this failure, not fixed.
- **`main` itself fails the same way.** The E2E Resiliency run on `916cc31` fails
  `portfolio-liveness.spec.ts:42`, `:86`, and `:115`, plus
  `signals-liveness.spec.ts:53` (SOXX chat). PR #235 changes no TS/app code.

**Fix (not applied; it belongs on its own branch):** make the locator target only
the add box:

```bash
cd ~/code/nuwrrrld-portal
grep -n 'getByPlaceholder(/ticker/i)' e2e/frontend/portfolio-liveness.spec.ts
sed -i '' 's|getByPlaceholder(/ticker/i)|getByPlaceholder(/add ticker/i)|' e2e/frontend/portfolio-liveness.spec.ts
```

Verify:

```bash
cd ~/code/nuwrrrld-portal
npx playwright test e2e/frontend/portfolio-liveness.spec.ts --project=frontend
```

## PR #236's e2e run (`feat(watchlist): CSV import`, run `37806845243`, head `646ce94`)

PR #236 adds a watchlist CSV import route and its UI. Its red run used a base
from before #239 (4 commits behind `main`), and it shows the same OpenRouter-404
signature as #234's and #235's runs. Shards 2 and 3 passed: 53 passed, 2 failed,
1 flaky, 6 skipped.

| Shard | Test | Error |
|---|---|---|
| e2e (1) | `e2e/frontend/dashboard-brief-fault-injection.spec.ts:90`: real `/api/brief` renders a non-empty brief | `expect(locator).toBeVisible()` failed, element not found; server log `Brief error Error: OpenRouter 404: all models in chain failed` |
| e2e (4) | `e2e/frontend/portfolio-liveness.spec.ts:86`: `/api/portfolio/health-ai` reaches OpenRouter | `unexpected status: {"error":"AI unavailable"}`; server log `Health AI error Error: OpenRouter 404: all models in chain failed` |
| e2e (4) | `e2e/frontend/signals-liveness.spec.ts:53`: `POST /api/signals/MU/chat` responds without a 5xx | `apiRequestContext.post: Timeout 25000ms exceeded` |

None of these touch the watchlist import code. The `signals-liveness` MU chat
timeout is the same test that fails on `main` (`916cc31`, see above).

The branch was rebased onto `5ff5567` (with #239), and the watchlist unit tests
still pass locally (41/41). A CodeRabbit review was re-requested on 2026-10-08
after the rebase. Expect the re-run to look like `main`: the OpenRouter-404
failures go away, and `portfolio-liveness` fails on the strict-mode locator
instead. The locator fix above has not been applied yet.

Re-check:

```bash
cd ~/code/nuwrrrld-portal
gh pr checks 236
```
