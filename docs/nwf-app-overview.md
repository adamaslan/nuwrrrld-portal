# NWF app: overview, issue map and open work

**Written for:** engineers and the owner who need to know what the NWF app is, where each part lives, and what is still open.

> **Snapshot.** The issue list and fix status below come from the owner's investigation of 2026-10-07 (`homebase/docs/NWF - Portal App/todo1b.md`). Nothing here was re-checked against live systems when this file was written. Each item says what was verified and when. Re-verify before acting on any of it.

## 1. What NWF is

NWF (NuWrrrld Financial) is one product on two surfaces that share the same backends.

| Surface | Repo | Role |
|---|---|---|
| Web portal | `nuwrrrld-portal` (Next.js) · `financial.nuwrrrld.com` | Signals, followed tickers, paper trading, admin console (nulogdash) |
| Mobile app | `gcp3-mobile` (Expo) | Same features on phones; shares the `lib/` core with the portal |
| API backend | `gcp3` (Cloud Run) | Market data and LLM endpoints used by both surfaces |

Shared backends: Neon (Postgres), Modal (scheduled jobs), GitHub Actions (pipelines and alerts), and the gcp3 Cloud Run service. Because they are shared, a fix or metric in one place can change the other surface too. The mobile/web parity pages in `docs/wiki-portal/` track what is in sync.

## 2. Features and how they are fed

| Feature | Fed by | Notes |
|---|---|---|
| Signals | Modal and GHA signal pipelines, LLM councils | Quality is not yet measured against forward returns |
| Followed tickers | Daily tracker job (`gcp3-tracker-feed`) | Tracker was close to the 300 s limit |
| Paper trading | Paper engine, `live_prices` table | Control accounts were not invested as designed |
| Admin console (nulogdash) | Read-only views over pipeline runs | Shows pipeline health |
| Notifications | GHA `notify` jobs, planned ntfy channel | Duplicate issues were piling up |
| AI automations | Free-model chain via OpenRouter | Chain broke on retired model IDs |

## 3. Issue map (from the 2026-10-07 list)

The owner's original list had nine items. Each maps to a section of the detailed plan (`todo1b.md`, §2).

| Original issue | Plan section | Status at 2026-10-07 |
|---|---|---|
| Modal not fully optimized | §2.1 | Not started |
| Stale data, signals digest frozen | §2.2 | Not started; gcp3 returns/price fix planned |
| Admin section not working well | §2.3 | Not started |
| No real alerts from GCP, GHA or Modal | §1, §2.4 | Alert action committed locally, not pushed |
| Signals weak | §2.5 | Needs about three weeks of clean forward-return data |
| Followed tickers not working, vague | §2.6 | Split planned (§3.6); PR #226 bounds concurrency |
| Paper trades not in UI, not automated | §2.7 | Nav link committed locally; control accounts blocked |
| Native AI automations weak | §2.8 | Gated on the chain fix |
| Many financial APIs, data not working well | §2.9 | Alpaca-first fallback planned |

A tenth item, backup databases (§2.10), was added during the investigation.

## 4. Fix status at 2026-10-07

Fixes were committed on local worktree branches only. None were pushed and no PRs were opened at that date.

| Fix | Branch | Result |
|---|---|---|
| Model chain skips 404/410 models, dead-model memory | `fix/chain-404-skip` | 43 unit tests pass; live tests partly flaky |
| Grounding pack `npm ci` and cache | `fix/grounding-pack-deps` | One commit |
| Batch-scoped hydrate status | `fix/pipeline-run-status` | Tests pass |
| Paper nav link and real last-run status | `fix/paper-nav-and-status` | Five tests pass |
| Alert dedupe, auto-close, ntfy action | `feat/pipeline-alert-action` | Nine tests pass; not run on GitHub |
| Tracker run-log row in a `finally` | — | Still missing after PR #226 |
| Chain stored in Neon | — | Blocked: needs a migration (sensitive surface) |
| Control accounts invested | — | Blocked: `scripts/seed-paper-book.mjs` does not exist on `main` |

Merge order noted at the time: `grounding` before `alerts`, because both edit `compile-grounding-pack.yml`. The others are independent.

## 5. Recommended order of work

Taken from the plan, week by week:

1. **Week 1:** the chain 404 fix; alert dedupe and cleanup of the open failure issues; the compile-grounding-pack deps fix; the paper nav link; the status fixes. Then a watchdog v1 that alerts on "green but did nothing" runs.
2. **Week 2:** paper controls and journal; tracker split; digest `asOf` and stale badge.
3. **Week 3:** Alpaca fallback everywhere and a vendor scoreboard; backup report and a weekly restore test.
4. **Week 4:** admin Goals tab; content-graded sweep.
5. **Later:** forward-return measurement as a signal gate; AI usefulness checks.

## 6. Decisions still open

These are the owner's decisions. The defaults in the plan are proposals only.

| # | Question | Proposed default |
|---|---|---|
| D1 | Alert channel: ntfy, Discord webhook or email | ntfy, with GitHub issues as the record |
| D2 | Paper controls: seed now or back-fill from 2026-09-22 | Back-fill |
| D3 | Modal: deploy `gcp3-tracker-feed`, retire `nuwrrrld-signals` | Yes to both |
| D4 | Council: daily flow or archive | Put it on the signals card, decide after 30 days of feedback |
| D5 | Paid AI fallback budget per day | $1/day hard cap |
| D6 | Paper and followed-tickers pages: Pro-only or public teaser | Public teaser, full detail behind Pro |

## 7. Where the detail lives

- Full investigation, fix plans and metrics: `homebase/docs/NWF - Portal App/todo1b.md`
- Pipeline status: `docs/modal-pipeline-status.md`
- Alerting and watchdog design: `docs/wiki-portal/`
- New-slot infrastructure: `docs/nwf-new-slot-terraform.md` and `infra/slots/new-pipeline/` (on PR #292, not yet on `main`)
- Known bugs: `docs/known-bugs.md`
