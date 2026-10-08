# Alpaca-first wiring: status and what is left (2026-10-07)

Policy: `~/.claude/rules/market-data-fallback.md`. Alpaca is the primary market-data source on every host. yfinance and Finnhub are fallbacks only, and yfinance is never called from a cloud host.

Start here: the stale signals digest was fixed by hand, and the scripts were then moved to Alpaca in four repos. Three repos have a committed branch with **no PR yet**. One repo (mcp-finance1) is not started.

## 1. What is done

| Repo | Worktree | Branch | Commit | State |
|---|---|---|---|---|
| homebase | `~/code/homebase-alpaca` | `feat/alpaca-primary` (base `master`) | `8f9753f` | Committed, not pushed. `locrun.py` and `refresh-signals.py` use Alpaca first through `market_data.py`. Dry-run tested. |
| signals-app | `~/code/signals-app-alpaca` | `feat/alpaca-primary` | `e15a605` | Committed, not pushed. `DataFetcher` is Alpaca-first and fails closed on datacenter hosts. 297 tests pass. |
| gcp3 | `~/code/gcp3-alpaca` | `feat/alpaca-primary` | `0a98995` | Committed, not pushed. Quote chain is Alpaca, then Finnhub (1 req/s), then yfinance (local only). Finnhub candles removed. 16 new tests pass. |
| mcp-finance1 | `~/code/mcp-finance1-alpaca` | `feat/alpaca-primary` | none | **Not started.** The worktree is clean. |
| nuwrrrld-portal | `~/code/nuwrrrld-portal-digest` | `fix/digest-stale-durable-fallback` | uncommitted | Digest now falls back to the newest Neon row (marked degraded) after a cold start. 2 new tests pass. |

The digest itself was refreshed by hand: 53 of 54 symbols (PBS had no Alpaca bars), source `alpaca-sip-local`, pushed to the live `/api/signals/refresh`.

## 2. What is left, in priority order

### 2.1 Push the secrets the new code needs (blocks the cloud paths)

Cloud paths now fail closed without Alpaca keys: GitHub Actions in signals-app, and gcp3's `tracker-feed` workflow.

**Step 1 — preflight.**

```bash
cd ~/code/nuwrrrld-portal
gh auth status
grep -cE '^(ALPACA_API_KEY|ALPACA_API_SECRET)=.+' .env.local
```

Expect `gh` logged in, and `2` from the last line.

**Step 2 — push to the repos' GitHub secrets (values are piped, never printed).**

```bash
cd ~/code/nuwrrrld-portal
for repo in adamaslan/signals-app adamaslan/gcp3; do
  for k in ALPACA_API_KEY ALPACA_API_SECRET; do
    awk -F= -v k="$k" '$1==k{sub(/^[^=]*=/,""); gsub(/^"|"$/,""); print; exit}' .env.local \
      | tr -d '\n' | gh secret set "$k" --repo "$repo" && echo "set $k on $repo"
  done
done
```

**Step 3 — verify.**

```bash
for repo in adamaslan/signals-app adamaslan/gcp3; do gh secret list --repo "$repo" | grep -E 'ALPACA'; done
```

Expect 4 rows in total (2 per repo).

**Step 4 — Cloud Run (gcp3). No ALPACA secret exists in the GCP project yet.** `backend/cloudbuild.yaml` was deliberately **not** edited, because naming a missing secret in `--set-secrets` fails the deploy. Create the secrets first, then add them to the `--set-secrets` list.

```bash
cd ~/code/nuwrrrld-portal
for k in ALPACA_API_KEY ALPACA_API_SECRET; do
  awk -F= -v k="$k" '$1==k{sub(/^[^=]*=/,""); gsub(/^"|"$/,""); print; exit}' .env.local \
    | tr -d '\n' | gcloud secrets create "$k" --project ttb-lang1 --data-file=- && echo "created $k"
done
gcloud secrets list --project ttb-lang1 --format='value(name)' | grep -i alpaca
```

Expect 2 rows. Then add `ALPACA_API_KEY=ALPACA_API_KEY:latest,ALPACA_API_SECRET=ALPACA_API_SECRET:latest` to the `--set-secrets=` line in `~/code/gcp3-alpaca/backend/cloudbuild.yaml`. The Cloud Run service account also needs `roles/secretmanager.secretAccessor` on both secrets.

🖱 **Dashboard:** Modal secret `gcp3-tracker-feed` needs `ALPACA_API_KEY` and `ALPACA_API_SECRET` added. https://modal.com/secrets

### 2.2 Open the PRs (the owner said to update the PR when finished)

Do the portal PR first. It is the smallest, and the wiki-on-PR rule applies there. Per `multi-branch-optimization`, a repo has at most 3 open PRs; the portal already has #233 open, so this makes 2.

```bash
cd ~/code/nuwrrrld-portal-digest
git add lib/digest-cache-db.ts lib/digest-cache.ts __tests__/digest-cache-fallback.test.ts docs/alpaca-wiring-status-2026-10-07.md
git commit -m "fix(digest): serve newest Neon row as degraded fallback after a cold start"
git push -u origin fix/digest-stale-durable-fallback
gh pr create --title "fix(digest): durable stale fallback when live backend is down" --body-file docs/alpaca-wiring-status-2026-10-07.md
```

Then the three other repos (push, then open each PR):

```bash
for spec in "homebase-alpaca:master" "signals-app-alpaca:main" "gcp3-alpaca:main"; do
  d=${spec%%:*}; base=${spec##*:}
  (cd ~/code/$d && git push -u origin feat/alpaca-primary \
    && gh pr create --base "$base" --title "feat(data): Alpaca-first market data" \
         --body "Alpaca becomes the primary market-data source; yfinance is a local-only fallback. See docs/alpaca-wiring-status-2026-10-07.md in nuwrrrld-portal.")
done
```

Pace CodeRabbit per `coderabbit-pacing` (one trigger per PR, then wait). After the portal PR opens, do the wiki ingest in `docs/wiki-portal/` and the mirrored parity pages in `gcp3-mobile/docs/wiki-mobile/`, then run `node ~/.claude/scripts/wiki-guard.mjs`.

### 2.3 mcp-finance1 (not started)

Target: `src/technical_analysis_mcp/data.py`, class `FinnhubAlphaDataFetcher`. Plan:

- Put `alpaca_md.py` next to `data.py`. The canonical copy is in the session scratchpad; copy it from `~/code/homebase-alpaca/alpaca_md.py`, which is identical except for the `on_datacenter_host()` and `day_high`/`day_low` additions made later. Re-copy it from `~/code/gcp3-alpaca/backend/alpaca_md.py`.
- Replace `_fetch_finnhub` (calls `stock_candles`, a paid endpoint) with `_fetch_alpaca`. Daily bars use Alpaca directly; weekly and monthly periods (`2y`, `5y`, `10y`, `max`) are resampled from daily bars; intraday (`1d`, `5d`) go to Alpha Vantage.
- Skip yfinance when `alpaca_md.on_datacenter_host()` is true (Cloud Run).
- Other callers: `tools/industry_tracker/etf_data_fetcher.py`, `cloud-run/main.py`, `cloud-run/calculate_indicators.py`, `automation/functions/daily_analysis/` (a separate copy of `data.py`, with its own `requirements.txt`).
- Add `requests` and `boto3` to `pyproject.toml` and each `requirements.txt`.

### 2.4 Known gaps and deliberate exceptions

| Item | Why it was left | What would close it |
|---|---|---|
| gcp3 `industry.py` ETF history seed and audit | The stored series is dividend-adjusted (yfinance `auto_adjust`). Alpaca bars are split-adjusted only, so mixing them puts a step in the series. | Decide to re-seed the whole `etf_history` from Alpaca, then switch both functions together. |
| gcp3 `macro_pulse.py`, `features_cross_asset.py`, `features_vix_term.py` | VIX and DXY are index and futures symbols, which Alpaca does not carry. | Move to ETF proxies (VIXY, UUP, GLD), which changes the numbers, so it needs a decision. |
| Company names in `locrun.py` | Alpaca bars carry no name, so the report's name column is blank. | Look names up from the Alpaca assets endpoint. |
| `adj_close` | Alpaca closes are split-adjusted only. Long calibration runs in signals-app (`fetch_daily_history("10y")`) lose dividend adjustment. | Accept, or fetch dividends from `/v1/corporate-actions`. |
| Shared rate budget in the mamba envs | `boto3` is missing from `fin-ai1`, `fin-core`, `signals-app` and `auto1`, so scripts log a WARNING and pace locally instead of using `nwf_rate_budget`. | `mamba install -n fin-ai1 -c conda-forge boto3` (and the other envs), plus `NWF_AWS_PROFILE=NWF1a` locally. |
| Cloud hosts and the budget | GitHub Actions and Cloud Run have no AWS credentials, so they also pace locally. The Modal guide specifies a scoped IAM user limited to `table/nwf_rate_budget`. | Create that user and add its keys as secrets. |
| 15 minute digest TTL | `getLatestDigest` ignores rows older than 15 minutes, so the manual push is superseded by the gcp3 live fetch after 15 minutes. gcp3 `/signals` reports `price: 0.0` for all 54 symbols. | Fix the gcp3 price source, or lengthen the TTL. The portal PR above only adds the stale fallback. |
| `refresh-signals.py` and the scheduled digest | Nothing runs the Alpaca digest on a schedule. It was pushed once by hand. | Schedule `refresh-signals.py --push --universe etf_sector` or the 4th pipeline. |
| Portal `app/api/signals/live` and `lib/shared/live-price.ts` | They receive pushes from the Finnhub WebSocket tier (`homebase/modal_finnhub_ws.py`). They do not fetch data themselves. | Point the poller at Alpaca snapshots (`live_prices` feed). |
| gcp3 tests | 9 tests already fail on `origin/main` in the `fin-ai1` env (Python 3.10): 3 `test_massive_client`, plus `test_screener`. | Separate fix. |
| PBS | Alpaca returned no bars for it. | Check whether the symbol is delisted or renamed. |

## 3. Verify the whole thing once it is merged

```bash
cd ~/code/nuwrrrld-portal
node -e 'fetch("https://financial.nuwrrrld.com/api/signals/refresh").then(r=>r.json()).then(console.log)'
curl -s https://gcp3-backend-cif7ppahzq-uc.a.run.app/signals | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['date'], sum(1 for v in d['symbols'].values() if not v.get('price')), 'zero-price of', len(d['symbols']))"
```

Expect the first to report `cached: true` with 53 signals and the second to report 0 zero-price once gcp3 is on Alpaca.
