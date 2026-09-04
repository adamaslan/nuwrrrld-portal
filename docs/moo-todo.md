# MOO Council Simulation — TODO (verified 2026-09-04)

Supersedes the open items in
[`moo-council-simulation-todo.md`](moo-council-simulation-todo.md) (PR #97,
2026-09-02) — that doc's §1 (the real scan/simulation/council run) is kept as
historical reference; its §2/§3 checklists are current here after re-verifying
every claim against `main` post-#97/#101/#105/#108.

## What changed since PR #97 landed

Four PRs merged on top of #97: **#101** (signal-engine: `isCryptoShaped`,
real `dataQuality`, hydration constants), **#105** (SQLite schema generator +
DB-parity suite), **#108** (demoted the landing page's live market-snapshot
fetch to static sample data), plus doc-only #104/#106/#107/#109. None of them
touch `lib/openrouter.ts`, `app/api/council/*`, or the MOO simulation code —
verified by `git log --oneline -- lib/openrouter.ts` (last touch is #97) and
by reading `app/api/council/sample/route.ts` / `app/page.tsx`'s council
section directly. **§3.1's implementation is intact and shipped.**

## Re-verified today, live

| Claim (from the old doc) | Still true? | How checked |
|---|---|---|
| Portal's `OPENROUTER_API_KEY` (`.env.local`) is expired | ✅ still true | `curl .../v1/key` → `401 "API key expired"` |
| GCP3 backend `/signals/MOO` is down | ✅ still true (503) | `curl .../signals/MOO` → `503` |
| `SEAT_MODELS` / `FREE_MODEL_CHAIN` health | ✅ all 6 seats OK, chain current | `node scripts/refresh-free-models.mjs --dry-run` (live key) — no rot, no change needed |
| `/api/council/sample` still MOO-framed, ticker/fundName/simulatedCapitalUsd in response | ✅ intact | read `app/api/council/sample/route.ts` directly |
| `app/page.tsx` council panel still renders the MOO framing | ✅ intact, survived PR #108's market-snapshot rewrite | grep confirms `council?.ticker`, `simulatedCapitalUsd` still wired |
| §2.1 empty-completion fix (`runSeat`) | ✅ present | unchanged since #97, no follow-up touched it |
| §2.2 `SEAT_MODELS.QUANT` fix | ✅ present, still correct | matches live audit above |

**New finding, not in the old doc: MOO isn't in the tracked universe at
all**, and never can be via the existing ETF-seeding path:

- `SELECT * FROM ticker_universe WHERE ticker = 'MOO'` → **zero rows**, and
  `ticker_cards` for MOO → **zero rows**. The portal-native hydration
  pipeline (PR #101's real `dataQuality`, the whole point of §3.2's "don't
  compute a backtest inside a request handler") has never seen this ticker.
- `scripts/seed-etf-cards.mjs`'s docstring: *"card the 54 ETFs gcp3 already
  computes"* — it reads GCP3's `/signals` (the same endpoint that's 503
  right now) and that list is a fixed 54 **sector/industry** ETFs. MOO
  (VanEck Agribusiness, a commodity-sector fund) was never going to be in
  it, GCP3 outage or not.
- **The actual unblocked path**: `scripts/hydrate-local.mjs` fetches Alpaca
  bars directly and doesn't care about GCP3's ETF list — it already accepts
  `--symbols=` for arbitrary tickers. `node scripts/hydrate-local.mjs
  --symbols=MOO --universe=etf` (against a dev server + a dev-safe
  `DATABASE_URL`) would card MOO for real, computing genuine RSI/MACD/ADX/
  volatility/`dataQuality` — independent of GCP3 being up, and giving
  `/api/council/sample` a portal-native `ticker_cards` row to read instead
  of the currently-503 GCP3 fetch.

This changes the recommended order of §3.2 below: don't wait on GCP3 or
build a parallel `etf_simulation` document — **register MOO in the existing
pipeline first**, then point the route at `ticker_cards` instead of GCP3.

---

## Updated checklist

### P0 — do these before touching anything else

- [ ] **Verify the Vercel production `OPENROUTER_API_KEY` separately.** Still
      unverified — this session has no Vercel env access. If prod shares the
      expired local key, `#council` is failing live right now. Highest
      priority; everything below assumes this gets checked.
- [ ] **Register MOO in `ticker_universe`** via `hydrate-local.mjs
      --symbols=MOO --universe=etf` (new finding above) — the concrete,
      unblocked first step of the old doc's §3.2, now that GCP3's ETF path is
      confirmed to never cover this ticker.

### Carried forward, unchanged status (re-read, not re-run)

- [ ] §2.1 remainder — strip/prevent visible reasoning-as-content from
      leaking past the four required fields (T2's 1,777-char chain-of-thought
      case). Still open; no code touched this area since #97.
- [ ] §2.2 remainder — a scheduled CI job running
      `refresh-free-models.mjs --dry-run`'s seat audit and failing on `DEAD`.
      Still just a manual command; not wired into `.github/workflows/`.
- [ ] §2.4 — make the no-live-data fallback prompt structurally prevent
      invented figures (T1 fabricated a CAGR quote and price levels when
      GCP3 was down). Still open, and GCP3 is *still* down as of today's
      recheck, so this path is still live, not theoretical.
- [ ] §2.5 — `FREE_MODEL_CHAIN` latency vs. the live test suite's 20s SLA.
      Not re-run today (would burn real API calls for a check whose inputs —
      the chain itself — didn't change per the audit above); assume still
      open until re-verified.
- [ ] §3.1's remaining not-done items — full §1.1+§1.2 brief (only
      live-`/signals` confluence score today), `generatedAt` staleness badge,
      end-to-end verification against a live dev server + live `/signals/MOO`
      response (impossible right now — GCP3 is 503; test against the new
      `ticker_cards` path instead once MOO is registered).
- [ ] §3.3 — the `BREADTH`/look-through seat. Unblocked by MOO registration:
      once `hydrate-local.mjs` cards MOO's underlying holdings too (same
      command, `--symbols=CTVA,DE,NTR,ZTS,ADM,CF,TSN,BG`), the look-through
      scan can read real `ticker_cards` rows instead of the one-off
      `docs/moo-council-run/scan_moo.py` script.
- [ ] §3.4 (render) and §3.5 (generalize to more ETFs, precompute at
      build/cron time, persist to `council_verdicts`) — unchanged, not
      started.

### One item from the old doc, resolved

- [x] ~~Should the simulation be dated or evergreen?~~ — moot until MOO is
      actually registered in `ticker_cards`, which is timestamped
      (`bar_date`, `computed_at`) by construction — the pipeline already
      answers this once §P0's second item is done.

---

## Reproduce today's verification

```bash
# OpenRouter key
KEY=$(awk -F= '/^OPENROUTER_API_KEY=/{print $2}' .env.local | tr -d '"'"'"' \r')
curl -s -H "Authorization: Bearer $KEY" https://openrouter.ai/api/v1/key

# GCP3 backend
curl -s -o /dev/null -w "%{http_code}\n" https://gcp3-backend-cif7ppahzq-uc.a.run.app/signals/MOO

# Seat/chain health (needs a live key — .env.local's is expired; use ~/code/homebase/.env's)
export OPENROUTER_API_KEY=$(awk -F= '/^OPEN_ROUTER_KEY=/{print $2}' ~/code/homebase/.env | tr -d '"'"'"' \r')
node scripts/refresh-free-models.mjs --dry-run

# MOO universe status
node --env-file=.env.local -e '
  import("@neondatabase/serverless").then(async ({neon}) => {
    const sql = neon(process.env.DATABASE_URL);
    console.log(await sql`SELECT * FROM ticker_universe WHERE ticker = ${"MOO"}`);
  });'
```
