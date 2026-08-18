# How I use Zo — current state

*Snapshot taken 2026-08-12. Reflects live automations, skills, routes, and data on this machine.*

---

## The short version

Almost everything on this Zo serves one project: **NuWrrrld**, an automated daily financial briefing. Zo acts as the research-and-reasoning brain (web + X research, AI council write-up, image generation, delivery), while a separate backend (`gcp3-backend`, on Google Cloud Run) is supposed to supply the hard numbers, and `financial.nuwrrrld.com` is the public face.

Secondary uses: a 3D interactive homepage on zo.space, a calendar/Telegram bridge that calls Zo's own API, a couple of saved reading articles, and ops docs for hardening the NuWrrrld sites.

---

## Automations (2 active)

### 1. NuWrrrld Daily Engine

- **ID** `96802664-a601-4a62-8aed-00c6aed15a76`
- **Runs** daily at **12:15 PM New York** (5:15 PM London). Next: Thu 13 Aug, 12:15 ET.
- **Model** `zo:deepseek/deepseek-v4-pro` · **Delivery** email
- **What it does**, in nine steps:
  1. Pulls real signals from `https://gcp3-backend-…run.app/api/nwf-digest` (yfinance/Finnhub-computed). If that fails or is &gt;6h stale, falls back to web-searching price + RSI/MACD context for SPY, QQQ, NVDA, AAPL, MSFT, GLD, IBIT, GEV, TSLA, AMD.
  2. Macro + sentiment sweep — Fed tone, CPI/PCE, overnight futures, plus `$SPX/$VIX/$NDX` chatter on X — distilled into a −1.0…+1.0 score.
  3. Classifies the regime: Risk-On / Risk-Off / Transitioning.
  4. Writes the **AI Investment Council** view (1–60 day and 2 month–5 year), with the rule that every sentence must cite a real number.
  5. Composes `file site_data/briefing.json` (schemaVersion 2) and archives a dated copy.
  6. Generates the branded hero card + regime diagram.
  7. Publishes so `/api/nuwrrrld-briefing` serves fresh JSON before the open.
  8. Posts enrichment back to the GCP backend via `/api/zo-hydrate` (auth'd with a local secret file).
  9. Emails the full briefing, then Telegrams the top-3 signals. SMS only on a genuine regime flip.

### 2. NuWrrrld Free Model Chain Refresh

- **ID** `48410717-7ea0-447f-bfb9-7868e5468889`
- **Runs** Mondays at **9:00 AM New York**. Next: Mon 17 Aug.
- **Model** `zo:openai/gpt-5.4-mini` · no delivery (silent unless something's wrong)
- Runs `/root/free-model-refresh.sh`: clones `adamaslan/nuwrrrld-portal`, re-probes OpenRouter's free model catalog, and opens/updates a PR (`chore/refresh-free-models`) only if the chain actually changed.

---

## Three things are quietly broken

1. **The GCP digest is down.** `GET /api/nwf-digest` returns `404 {"detail":"No digest available"}` right now. The delivery log shows the briefing has been running on **fallback web-search methodology since 14 July** — 8 of the last 10 runs. The briefing still ships every day, so this failure is invisible unless you read the log. Every signal in today's briefing is `HOLD`, which is what the fallback tends to produce.
2. **The hydrate step never runs.** Step 8 reads `file secrets/zo_hydrate_secret.txt`. That directory doesn't exist, so the step self-skips every time and the backend never receives Zo's macro/sentiment enrichment.
3. **The Monday refresh is a no-op.** `/root/.free-model-env` exists but both `OPENROUTER_API_KEY` and `GH_TOKEN` are empty, so the script bails before doing anything. It has never done real work since being created on 14 July.

There's also a **schedule mismatch**: the automation fires at 12:15 PM ET, but the zo.space homepage tells visitors it runs at 9:45 AM ET, and the skills' internal timings say 5:45–6:10 AM ET.

---

## Skills (11)

Nine are the NuWrrrld pipeline, decomposed into layers. The Daily Engine reads them for scoring rules and output shapes but does *not* execute their Python — the local pipeline (`file homebase/locrun.py`) isn't installed here.

| Skill | Layer | Role |
| --- | --- | --- |
| `market-data-fetcher` | data | SPX/NDX/DJI/VIX + RSI, MACD, ADX, Bollinger, volume via yfinance; cross-checked against Finnhub |
| `macro-sentiment-scanner` | context | Fed/CPI/futures narrative + X cashtag sentiment → score |
| `signal-generator` | signals | Indicators + macro → BUY/HOLD/SELL with confidence |
| `council-analyst` | reasoning | Short- and long-term council views, top picks, key risks |
| `briefing-composer` | aggregation | Merges everything into `file briefing.json` + dated archive |
| `visual-card-maker` | visuals | Hero card image + D2 regime/rotation diagram |
| `performance-tracker` | feedback | Grades yesterday's calls, keeps rolling hit-rate, logs to Sheets |
| `site-publisher` | publish | Republishes the site and pushes to the zo.space route |
| `delivery-dispatcher` | distribution | Email / Telegram / SMS fan-out + delivery log |

Two general-purpose ones: `frontend-design` (Anthropic's, for non-generic UI work) and `humanizer` (community, strips AI writing tells from outbound text).

Note: `performance-tracker` writes to Google Sheets, but Google Sheets isn't connected as an integration — so that leg can't actually run.

---

## zo.space (4 routes, all public)

- `/` — a Three.js scene: a loaded `dog1.glb` walks a street with nine stations, one per Daily Engine step. Three of the chalkboards hydrate live from today's briefing (macro label, top signal, regime). Mobile-responsive HUD, station strip, modal detail view.
- `/api/nuwrrrld-briefing` — serves `file site_data/briefing.json` off disk with CORS open, trying three candidate paths, degrading to an empty payload rather than erroring. This is what `financial.nuwrrrld.com` consumes.
- `/api/calendar-events` — GET lists the next 14 days of Google Calendar; POST creates an event. Implemented by calling **Zo's own** `/zo/ask` **API** and parsing the prose reply.
- `/api/telegram-bot` — bearer-auth'd Telegram webhook, same `/zo/ask` round-trip, calendar-scoped, replies via the Bot API.

19 assets uploaded, mostly dated hero/regime images. Paths are inconsistent across four different prefixes (`/briefings/`, `/nuwrrrld/`, `/site_data/`, `/assets/nuwrrrld/`) — an artifact of the automation choosing its own path each day.

---

## Files

```markdown
/home/workspace/
├── site_data/
│   ├── briefing.json          ← today's briefing, served live
│   ├── archive/               ← 49 dated briefings, 25 Jun → 12 Aug
│   ├── assets/                ← generated hero + regime images
│   └── delivery_log.jsonl     ← 24 dispatch records
├── data/delivery_log.jsonl    ← 4 records (older/duplicate path)
├── ops/
│   ├── nuwrrrld-probe.sh      ← synthetic probe, 6 endpoints + auth gate
│   ├── probe-log.jsonl        ← last run 12 Aug 10:37 UTC, all ok
│   └── financial-nuwrrrld-security-threat-guide.md
├── nuwrrrld-robustness-plan.md ← v3, measured baseline + fix register
├── Articles/                   ← AI trading guides, Pace Layers, Synthesis of Form
├── Images/                     ← pegasus.svg, wordmark.svg, icon.png, bountiful.jpg
├── Skills/                     ← the 11 above
└── dog1.glb                    ← the homepage dog
```

Two delivery logs at two paths mean the record is split. `--full-page` at the workspace root is a stray file from a mistyped screenshot command.

---

## Integrations

**Connected:** Google Calendar (read/write), Telegram (`@adamfromnyc`), Telegram Bot API, email to `chillcoders@gmail.com`.

**Not connected but referenced by the work:** Google Sheets (performance tracker needs it), GitHub (the Monday PR script needs a token), X (research runs on `x_search`, which doesn't require a connection).

No rules are configured. No user services or Zo Sites are registered — everything web-facing runs through zo.space routes.

---

## If I fixed three things

1. Point the Daily Engine at a working data source, or make it **shout** when it falls back — a month of silent degradation defeats the purpose of cross-validated numbers.
2. Create the hydrate secret so the enrichment loop actually closes, or delete step 8 so the instruction stops lying.
3. Fill in the two tokens in `/root/.free-model-env`, or deactivate the Monday automation until they exist.

---

## Could this run for $0? Ten free-tier pipelines

The Daily Engine is really four jobs: **fetch data → reason/compose → publish JSON + page → deliver**. Every piece has a free-tier home. The common free ingredients across all of these: **yfinance** (free), **Finnhub free tier** (60 calls/min), **Telegram Bot API** (free), **Gmail SMTP or Resend** (3,000 emails/mo free), and free LLM inference via **Google Gemini API free tier**, **Groq free tier**, or **OpenRouter's** `:free` **models** — the same chain the Monday automation was built to maintain.

Ten ways to assemble it:

### 1. GitHub Actions (all-in-one)

A scheduled workflow (cron, \~12:10 ET) runs the whole Python pipeline: yfinance → signals → LLM call → commit `file briefing.json` to the repo → GitHub Pages serves it. Free: 2,000 min/mo on private repos, **unlimited on public repos**. The archive becomes git history for free. Caveat: cron can fire 5–15 min late. This is the single lowest-friction rebuild.

**This isn't hypothetical — `nuwrrrld-portal` already runs two of the three GHA integrations this rebuild would need**, and the third (the Daily Engine's own cron) is a direct copy of an existing pattern:

- **The Monday refresh IS this pattern, already live.** `.github/workflows/refresh-free-models.yml` runs `scripts/refresh-free-models.mjs` weekly (`cron: '17 6 * * 1'`), re-probes OpenRouter's free-model catalog the same way `/root/free-model-refresh.sh` on Zo tries to, and opens a PR via `peter-evans/create-pull-request` only if the chain changed. **This is the fix for broken item #3 above** — Zo's copy fails silently because `/root/.free-model-env` has two empty tokens; the GHA copy fails *loudly* (job goes red in the Actions tab, `MIN_WORKING` guard refuses to write a stranding chain) because `OPENROUTER_API_KEY` lives in repo secrets, not a file that can silently go missing. Retiring the Zo automation in favor of this workflow removes failure #3 entirely rather than patching it.
- **E2E credential/dependency preflight already exists as a CI gate**, not just a manual check. `.github/workflows/e2e-resiliency.yml` runs a Playwright suite (`e2e/preflight/*`) on every push/PR that asserts every API key is present, correctly shaped, and *live* (one real authenticated call per provider — OpenRouter, Stripe, MCP) before any feature test runs. This is the mechanism that would have caught broken item #1 (`GET /api/nwf-digest` 404ing since 14 July) on day one instead of a month later: a scheduled run of the same `preflight`/`health` projects against the GCP backend's `/health` endpoint turns "silently degraded for a month" into a red check within minutes of the break. See `docs/e2e.md` §0 and §8, and `docs/wiki-portal/entity-playwright-e2e.md`.
- **The handshake pattern (mint a short-lived credential once, share it, never persist the underlying secret) is the template for fixing broken item #2** (the hydrate step's missing `secrets/zo_hydrate_secret.txt`). `e2e-resiliency.yml`'s `auth` job signs in once via `@clerk/testing`, uploads only the resulting session artifact (never the password) with 1-day retention, and every sharded job downloads that artifact instead of re-authenticating. The same shape — a dedicated GHA job holds the one secret, mints/writes a derived credential, everything downstream consumes the derived artifact — is how the GCP hydrate secret should be provisioned instead of a flat file in Zo's filesystem that can silently not exist.
- **Keyless GCP auth is already wired**, via Workload Identity Federation (`google-github-actions/auth@v2`, `id-token: write`, no service-account JSON in secrets) — the same mechanism a GHA-hosted Daily Engine would use to call `gcp3-backend` instead of Zo's local secret file.

Net effect: rebuilding the Daily Engine on GitHub Actions doesn't just move *where* it runs — it inherits the credential-preflight-as-CI-gate pattern this repo already built for its own test suite, which is structurally what's missing from all three of Zo's current failure modes (silent fallback, silently-skipped step, silently-empty tokens). A GHA cron fails loudly by default; each of Zo's three breakages above is a variant of "failed silently because nothing was watching."

### 2. Modal (closest to the current architecture)

`@app.schedule(Cron(...))` on a Python function; Modal gives **$30/mo in free credits** on the Starter plan — a daily 2-minute CPU job uses pennies of it. Serve the briefing from a Modal web endpoint. Bonus: free GPU seconds if you ever want to run a local model for the council. [^1]

### 3. GCP always-free (fix what's already there)

The existing `gcp3-backend` is already on Cloud Run. Cloud Run gives 2M requests + \~180K vCPU-seconds/mo free; **Cloud Scheduler's first 3 jobs are free**; Cloud Run *Jobs* have their own free vCPU-seconds allowance. Scheduler → Cloud Run Job (pipeline) → write JSON to a public Cloud Storage bucket (5 GB free). Cheapest path of all: repair the digest endpoint instead of rebuilding. [^2]

### 4. AWS always-free

**EventBridge Scheduler: 14M invocations/mo free, permanently** (not the 6-month new-account credit) → Lambda (1M requests + 400K GB-s/mo always free) → S3/CloudFront for the JSON. Note AWS moved *new accounts* to a $200-credit/6-month model in 2025, but Lambda/EventBridge/DynamoDB always-free allowances remain for everyone. [^3]

### 5. Azure free tier

Timer-triggered **Azure Function** (1M executions/mo free) → Azure Blob static site or **Azure Static Web Apps (free tier)** for the frontend + briefing JSON. Azure's consumption plan needs a storage account (\~pennies, effectively the only cost). GitHub-integrated deploys make the Monday refresh-PR flow natural here too.

### 6. Cloudflare Workers (edge-native)

**Cron Triggers are free** (3 per Worker on the free plan, 100K requests/day, 10 ms CPU — enough since the heavy lifting is `fetch` calls to Finnhub/LLM APIs, which don't count against CPU time). Store the briefing in **Workers KV or D1** (both have free tiers), serve it from the same Worker with CORS, host the page on Cloudflare Pages (free). No servers anywhere. [^4]

### 7. Supabase + pg_cron

Free Postgres project with **pg_cron** scheduling an **Edge Function** (500K invocations/mo free). Signals land in a real table instead of JSON files — which finally makes the performance-tracker leg trivial (a SQL query instead of Google Sheets). Auto-generated REST API replaces `/api/nuwrrrld-briefing`. Caveat: free projects pause after 1 week of inactivity, but a daily cron counts as activity.

### 8. Vercel / Netlify (frontend-first)

`financial.nuwrrrld.com` on Vercel Hobby (free), with a **Vercel Cron** (Hobby allows daily crons) hitting a serverless function that builds the briefing and writes it to Vercel Blob/Edge Config. One repo, one deploy, site + pipeline together. Caveat: Hobby cron timing is loose (fires within an hour window) and function timeout is 10–60 s, so the LLM step needs to be a single fast call.

### 9. Oracle Cloud Always Free (a real VM, forever)

The most generous always-free compute anywhere: up to **4 ARM OCPUs + 24 GB RAM**, permanently. It's just a Linux box — run the *actual* `file homebase/locrun.py` pipeline the Skills were written for, on a plain crontab, with no serverless rewrites at all. Caveats: ARM capacity in popular regions can be scarce at signup, and idle instances can be reclaimed on free accounts.

### 10. Val Town / Deno Deploy (smallest possible footprint)

Val Town free tier gives scheduled vals (cron) + HTTP vals + built-in blob storage — the entire pipeline is \~200 lines of TypeScript in a browser, no repo, no deploy step. Deno Deploy free tier (1M requests/mo + `Deno.cron`) is the same idea with a git workflow. Best for proving the loop before graduating to #1–#3.

### Honorable mentions

- **Render / Koyeb / Fly.io** free-ish tiers can host the backend, but all three have tightened free plans (spin-down, credit caps) — fine for the API, weak for scheduling.
- **PythonAnywhere free** has a daily scheduled task built in — genuinely enough for one run/day, though outbound internet is whitelist-restricted on free.
- **Self-host**: a Raspberry Pi + crontab + Cloudflare Tunnel (free) serves the JSON publicly with zero cloud dependency.

### Which one, honestly

The pipeline's needs are tiny: one run/day, a few dozen HTTP calls, one JSON artifact, three delivery channels. **#1 (GitHub Actions)** wins on simplicity, **#3 (GCP)** wins on not rebuilding what exists, and **#6 (Cloudflare)** wins on serving speed. What none of them replace for free is the part Zo currently does: the agentic research layer (web + X search, image generation, judgment calls when the data source dies). The free rebuilds all assume deterministic code + a free LLM API — which is also exactly what would have made the last month's silent-fallback problem impossible, because deterministic pipelines fail loudly.

[^1]: https://www.beam.cloud/blog/modal-pricing-explained
[^2]: https://www.economize.cloud/resources/gcp/pricing/cloud-run
[^3]: https://cloudburn.io/blog/amazon-eventbridge-pricing
[^4]: https://developers.cloudflare.com/workers/platform/limits