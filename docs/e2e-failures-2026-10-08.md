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
