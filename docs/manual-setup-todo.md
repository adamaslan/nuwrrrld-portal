# Manual setup TODO — things only a human with dashboard access can do

Everything in this file is blocked on a login, a signature, a value that does
not exist yet, or a decision only the owner can make. None of it is a code
change. It is the complete set of external tasks standing between the current
branch and a production-ready deploy, gathered 2026-08-29 while finishing
[docs/todo-auth-cookies-tracking.md](todo-auth-cookies-tracking.md).

**Updated 2026-08-30** with the blocked items from
[docs/ship-to-clients-top-25.md](ship-to-clients-top-25.md) — that document
ranks *all* remaining work by revenue impact; this one holds only the subset a
human has to unblock. Where they overlap, this file is the checklist and that
one is the reasoning. New here: the expanded Stripe section (§4), CI/test
infrastructure (§5b), observability (§5c), and the explain-quality product
decision (§6b).

**Updated 2026-09-03** with §0a — the nightly universe hydration has been dead
for 15 days on three missing secrets. This is now the top item in the file. The
`gh secret list` caveat below has also been **resolved**: the command was
re-run successfully and its output is recorded in §2.

Ordered by what unblocks the most.

**Updated 2026-09-14** — a full verification pass ran every check in this file
against live state (`gh secret list`, `gh run list`, the production
`/api/health` and `?meta=freshness` endpoints, and the Neon database directly).
Large parts of this file were **already done and never marked**. The
authoritative current state is §-1 below; sections further down retain their
original reasoning but their status lines may be stale where §-1 contradicts
them.

---

## -1. Verified state as of 2026-09-14

### ✅ Closed — verified, not assumed

| Item | Evidence |
|---|---|
| §0a the 15-day hydration outage | **Over.** All three secrets present in GHA (set 2026-09-13). `ticker_cards` newest `bar_date` = **2026-09-13**, 1,864 rows, `staleTradingDays: 0`. `Signal freshness check` green 2026-09-14. |
| §0a repo labels | `hydration-failure`, `stale-signals`, `pipeline-failure` all exist. |
| §1 `CRON_SECRET` | Present in `.env.local` **and** GHA (2026-09-13). |
| §1 `NEON_API_KEY` / `NEON_PROJECT_ID` / `PORTAL_URL` | Present. |
| §2 absent-secret list | **Drained this session** — `STRIPE_WEBHOOK_SECRET` and `STRIPE_PRICE_ANNUAL` are now real values locally (no longer placeholder/empty) and were pushed to GHA 2026-09-14. |
| §2 `OPENROUTER_API_KEY` staleness in CI | **Fixed.** The local key was validated live (`GET /api/v1/key` → 200) and re-pushed to GHA 2026-09-14, replacing the 2026-08-18 copy. This is the cause of the `OpenRouter 401: council T1 — all models failed` seen in the e2e `[frontend]` shard. |
| §5 the four GDPR tables | All present: `consent_records`, `legal_consent_events`, `privacy_requests`, `user_attribution`. |
| §5b `E2E_CLERK_PUBLISHABLE_KEY` / `E2E_CLERK_SECRET_KEY` | Set 2026-09-11; the `auth` job passes on PR #135. |
| §5b `shared-drift-check` | **Passing** on PR #135. |
| §5b Cloudflare Pages | The `Cloudflare Pages` check no longer appears on PR #135's check list at all. Confirm once in the dashboard, then delete the item. |
| §5c `/api/health` | All five dependencies `ok` (mcp, neon, stripe, openrouter, clerk) — the `MCP_BACKEND_URL` 503 recorded 2026-09-10 is resolved. |
| §5d `afternoon-pipeline` notify noise | The last four runs are **green**. It is no longer filing `pipeline-failure` issues. |
| §0b Phase 2.4 crypto rows | Already done — `SELECT count(*) FROM ticker_universe WHERE ticker ~ '-USD$' AND active` = **0**. |
| §8 PRs #97 / #101 | Both **merged** 2026-09-04. Section 8's first two items are historical. |

### 🗑 Obsolete — do NOT do these

- [x] ~~`GCP_WIF_PROVIDER` / `GCP_SERVICE_ACCOUNT` (§1 and §5b)~~ — **the
      requirement was deliberately removed.**
      `.github/workflows/e2e-resiliency.yml:210–222` now carries an explicit
      comment: the GCP auth step "never had a consumer … nothing downstream
      runs gcloud/gsutil, the app pulls in no `@google-cloud` client library,
      and … gcp3-backend … answers unauthenticated." Provisioning the pool now
      would create IAM nobody consumes. Re-add it only alongside a step that
      actually needs it.

### 🔴 Newly found 2026-09-14

- [ ] **`.env.local`'s `DATABASE_URL` points at production, and §9's
      `PRODUCTION_DB_HOST` guard cannot be armed until that changes.**
      - **From**: the 2026-09-14 verification pass
      - **Evidence**: the Neon project has exactly **one** live branch —
        `main`, flagged `primary: true, default: true`. Every other branch
        (`preview/*`) is `archived`. So there is no dev branch for
        `DATABASE_URL` to point at, and §9's first checkbox ("confirm it
        points at a dev branch") is currently **false**.
      - **Why it can't be code**: creating a dev branch and repointing local
        config is an owner decision about where local `--no-dry-run` runs and
        the paper-portfolio seed are allowed to write.
      - **Why it matters**: setting `PRODUCTION_DB_HOST` today would refuse
        *every* local live run, because local and production are the same
        host. The guard shipped (`lib/pipeline-db-guard.ts`) and is inert.
      - **Unblocks**: §9 entirely, and makes the Phase 3 paper-portfolio seed
        (below) safe to run.
      - **Added**: 2026-09-14
      - **Step 1 — capture the production host first**, while `DATABASE_URL`
        still points at it (this must happen *before* Step 2 repoints
        `DATABASE_URL` at the new dev branch). Extracts the hostname the same
        way `resolveDbHost()` does, writes only that hostname to
        `PRODUCTION_DB_HOST`, and never prints the connection string itself:
        ```bash
        grep -c '^DATABASE_URL=' .env.local   # confirm it's set — prints a count, never the value
        node -e "
        const fs = require('fs');
        const content = fs.readFileSync('.env.local', 'utf8');
        const line = content.split('\n').find(l => l.startsWith('DATABASE_URL='));
        if (!line) { console.error('DATABASE_URL not found'); process.exit(1); }
        const host = new URL(line.slice('DATABASE_URL='.length).replace(/^\"|\"\$/g, '')).hostname.toLowerCase();
        const updated = /^PRODUCTION_DB_HOST=/m.test(content)
          ? content.replace(/^PRODUCTION_DB_HOST=.*/m, 'PRODUCTION_DB_HOST=' + host)
          : content.trimEnd() + '\nPRODUCTION_DB_HOST=' + host + '\n';
        fs.writeFileSync('.env.local', updated);
        console.log('PRODUCTION_DB_HOST written (value not shown)');
        "
        grep -c '^PRODUCTION_DB_HOST=' .env.local   # expect 1
        ```
      - **Step 2 — create the dev branch, then repoint `DATABASE_URL` at it:**
        ```bash
        # 🖱 Dashboard: https://console.neon.tech → project neon1 → Branches → New branch (from main)
        # then copy its pooled connection string into .env.local's DATABASE_URL
        # (replace the existing line — do not append a second one):
        grep -c '^DATABASE_URL=' .env.local   # confirm exactly one row before and after editing
        ```
      - Verify the guard actually refuses:
        ```bash
        node scripts/local-trigger.mjs C track-followed-tickers --local --no-dry-run --yes
        ```
        Expect a non-zero exit and "refused", with no request sent, when
        `PRODUCTION_DB_HOST` matches the `DATABASE_URL` host.

- [ ] **The paper-portfolio seed still has not run** — `paper_accounts` and
      `paper_watchlists` both hold **0 rows** (verified 2026-09-14). The
      Phase 3 item at the bottom of this file is unchanged and now has a
      measured confirmation. Do it **after** the dev-branch item above, not
      before.

- [x] ~~**The stale-watchlist e2e failure is still live**~~ — **fixed and
      merged as PR #134** (`fix(e2e): scope portfolio-liveness watchlist
      assertion to added ticker`), merged to `main` 2026-09-14T23:01 UTC —
      *before* this verification pass ran, which is why the pass above wrongly
      called it still-live. The locator now scopes to `hasText: "AAPL"`
      instead of the bare `.port-watch-item` class, so pre-existing seeded
      watchlist rows (MSFT, NVDA) no longer trip a strict-mode violation.
      PR #135 (still open) has not rebased onto this fix yet — its
      `fix/portfolio-health-freshness` branch predates PR #134's merge, so its
      own e2e run will still show the old failure until it rebases:
      ```bash
      git fetch origin main
      git worktree add /tmp/wt-pr135-reb fix/portfolio-health-freshness
      cd /tmp/wt-pr135-reb && git rebase origin/main && git push --force-with-lease
      cd - && git worktree remove /tmp/wt-pr135-reb
      ```
      **Note on retriggering CI without new content**: GitHub does not fire
      `pull_request.synchronize` for a commit with an empty diff (verified
      2026-09-14 — an `--allow-empty` push here produced zero new workflow
      runs). A rebase is a real diff-bearing push and will trigger it; an
      empty commit will not.

- [ ] **`signals-app`'s `OPENROUTER_API_KEY` could not be pushed from here.**
      That repo has **no `.env.local`**, and a cross-repo `gh secret set` was
      declined by this session's permission policy. The portal's key is valid
      (verified 200 today), so the value to use is the portal's:
      ```bash
      cd ~/code/nuwrrrld-portal
      awk -F= '/^OPENROUTER_API_KEY=/{sub(/^[^=]*=/,""); gsub(/^"|"$/,""); print; exit}' .env.local \
        | tr -d '\n' | gh secret set OPENROUTER_API_KEY --repo adamaslan/signals-app
      gh secret list --repo adamaslan/signals-app | grep OPENROUTER_API_KEY
      ```
      Expect one row. (`.github/workflows/signals-scan.yml` is the consumer.)

- [ ] **`modal` CLI is not installed on this machine**, so §5e's "confirm
      whether `nuwrrrld-precompute-ai` is deployed" is unanswerable here.
      ```bash
      pipx install modal || pip install modal
      modal app list
      ```
      Expect either no `nuwrrrld-precompute-ai` row (§5e is moot) or one row
      (then `modal deploy deploy/precompute-ai/modal_app.py` once).

### Still blocking, unchanged

`STRIPE_SECRET_KEY` rotation (§4 — the value is live `sk_live_` and recorded as
exposed), a **test-mode** Stripe key for the sweep, the Clerk Production
instance (§3), admin MFA, `MCP_ANALYZE_URL`, `NULOGDASH_SESSION_COOKIE`,
`SIGNALS_ENGINE_URL` (empty in `.env.local`), `PAPER_CRON_SECRET`, the four
missing `afternoon-pipeline` routes (still absent from `app/api/pipeline/`,
though the workflow is green), the §6 legal/DPA items, and the §6b
explain-quality decision. Nothing in the 2026-09-14 pass moved any of those.



**Format:** every actionable item is either a ```bash copy-paste block
(runnable as written, no placeholders to hand-edit) or an explicit
🖱 **Dashboard:** line with a direct URL when no CLI equivalent exists. See
`~/.claude/rules/terminal-ready-todos.md`.

---

## 0a. ✅ RESOLVED 2026-09-13 — the nightly universe hydration outage

> **Closed.** The three secrets were pushed 2026-09-13 and a manual dispatch
> went green the same day. Verified 2026-09-14: newest `bar_date` = 2026-09-13,
> `staleTradingDays: 0`, `Signal freshness check` green. Everything below is the
> historical record of the outage and the runbook that fixed it — steps 1–8 are
> done, and remain here because they are the correct procedure if it recurs.

### (historical) The nightly universe hydration had been dead since 2026-08-19

**Verified 2026-09-03**, and this outranks everything else in this file:
`ticker_cards` holds 1,864 rows whose newest `bar_date` is **2026-08-19**.
Today is 2026-09-03. The universe has not been carded in 15 days.

Eleven consecutive scheduled runs have failed, each in ~25 seconds, before
touching Alpaca:

```
$ gh run list --workflow=hydrate-universe.yml --limit 12
completed  failure  Nightly universe hydration  schedule  2026-09-03T00:30:33Z  27s
completed  failure  Nightly universe hydration  schedule  2026-09-02T00:24:45Z  30s
… unbroken back to 2026-08-19 …

$ gh run view 33699802622 --log-failed
##[error]PORTAL_PUSH_SECRET is not set — the portal will reject every POST.
```

Cause: **`PORTAL_PUSH_SECRET`, `ALPACA_API_KEY` and `ALPACA_API_SECRET` do not
exist as repository secrets.** Seventeen others do (§2). All three exist in
`.env.local` — this is purely the §2 sync that was never run.

> ## ✅ RESOLVED 2026-09-15 — the outage is over, no action left in §0a
>
> The scheduled run at **`2026-09-15T00:47:52Z`** (run `34914657199`) was the
> first full hydration since the secrets landed, and it completed cleanly:
>
> ```
> [hydrate] run=… stock=762 etf=171 chunk=35
> … 22 chunks, written=70 each, failed=0 …
> [done] written=1866 calc-errors=0 post-failures=0 total=933
> ```
>
> `ticker_cards` now holds **1,866 rows, all at `bar_date=2026-09-15`** — the
> 1,734-row `2026-08-19` bucket is gone. Steps 1–8 below are **all satisfied**;
> nothing in this section needs a human any more. Kept for the incident record
> and because **§0a-bis (the freshness guard's blind spot) is still open** — it
> was luck, not the alarm, that surfaced the partial state.
>
> <details><summary>Prior status (2026-09-14) — secrets fixed, universe still 93% stale</summary>
>
> **Steps 1–6 below are DONE** (verified 2026-09-14):
> - All three secrets were pushed **2026-09-13 ~02:01–02:03Z** — `gh secret list`
>   shows all three present.
> - The smoke test ran green the same minute (run `34732129131`,
>   `workflow_dispatch`, `limit=25`): `written=100 calc-errors=0
>   post-failures=0 total=50`.
>
> **But the universe was never fully re-hydrated.** Actual row counts:
>
> | `bar_date` | rows | |
> |---|---|---|
> | 2026-09-13 | **100** | the smoke test's 50 symbols × 2 lanes |
> | 2026-09-05 | 2 | |
> | **2026-08-19** | **1,734** | ← the original outage, still unfixed |
> | 2026-08-18 | 28 | |
>
> **And `scripts/check-card-freshness.mjs` reports green anyway** —
> `latest bar_date=2026-09-13 staleTradingDays=0`. It reads **`max(bar_date)`**,
> which those 100 smoke-test rows fully satisfy. The independent guard built in
> Phase 1 specifically to catch this outage **cannot distinguish "all 1,864 rows
> fresh" from "100 fresh, 1,734 rotting."** See the new §0a-bis below — that
> blind spot is now the more dangerous of the two problems, because it makes
> the dashboard lie in the reassuring direction.
>
> **Remaining action: one full (unlimited) hydration run — step 6b below.**
>
> </details>
>
> *(That remaining action was carried out by the next scheduled run on its own —
> see the RESOLVED banner above. Step 6b is retained below only as the manual
> recipe for forcing a full run.)*

The full paste-by-paste fix is in **"Still blocking"** below — steps 1–8, run
them in order from the repo root. **Steps 1–5 are already satisfied**; start at
step 6b.

**The workflow's own guard worked perfectly** — it named the missing secret and
failed red rather than writing zero cards and reporting green. What is missing
is anything that tells a human the red exists. Two follow-ups, both code, both
in Phase 1 of
[docs/signal-engine-three-phase-plan.md](signal-engine-three-phase-plan.md):

- [x] An `if: failure()` notification step on the workflow. **Done on
      `feat/signal-engine-phases-1-3`** — opens/updates a `hydration-failure`
      tracking issue on every red run (`issues: write` added to the workflow).
- [x] A **freshness check independent of the writer**. **Done** —
      `scripts/check-card-freshness.mjs` + `.github/workflows/signal-freshness-check.yml`
      (weekday 13:00 UTC) read `GET ?meta=freshness` and go red when
      `max(bar_date)` is more than `MAX_STALE_TRADING_DAYS` (default 3) old.
      Test the alert with `MAX_STALE_TRADING_DAYS=0`, not by waiting.

Also verified while here: `hydrate-universe.yml` reads `${{ vars.PORTAL_URL }}`,
but `PORTAL_URL` is registered as a **secret**, not a variable. The lookup
misses and falls through to the hardcoded `https://financial.nuwrrrld.com`.
That default is correct, so nothing is broken — but the reference reads as
configurable and is not.

- [x] Changed the workflow to `secrets.PORTAL_URL` on
      `feat/signal-engine-phases-1-3`. Registering `PORTAL_URL` as a *variable*
      instead is still fine if you prefer that; either way the misleading
      `vars.` lookup is gone.

### Still blocking — only a human can do these (unchanged by the code PR)

Run these in order, from the repo root (`cd ~/code/nuwrrrld-portal`). Paste one
block at a time and read its output before moving on. Nothing here passes a
secret value through your screen — every value goes `.env.local` → stdin →
`gh secret set`.

---

**Step 1 — preflight: confirm you're authenticated and the values are present.**

```bash
cd ~/code/nuwrrrld-portal
gh auth status
test -f .env.local && echo "✓ .env.local present" || echo "✗ .env.local MISSING — stop here"
grep -cE '^(ALPACA_API_KEY|ALPACA_API_SECRET|PORTAL_PUSH_SECRET)=.+' .env.local
```

Expect: `gh` logged in, `✓ .env.local present`, and `3` from the last line.
If that count is less than 3, one of the values is missing or empty locally —
see `scripts/gen-portal-push-secret.sh` for `PORTAL_PUSH_SECRET`, and the
Alpaca dashboard (🖱 https://app.alpaca.markets/paper/dashboard/overview →
**API Keys**) for the pair.

---

**Step 2 — confirm what's actually missing from GitHub right now.**

```bash
gh secret list | grep -E 'PORTAL_PUSH_SECRET|ALPACA' || echo "none of the three are set"
```

Expect (today): `none of the three are set`. **If any already appear, stop
here** — `sync-hydration-secrets.sh` overwrites unconditionally with whatever
is in `.env.local`, with no comparison against the existing value and no
confirmation prompt. Before proceeding, confirm the local value is the one
you actually intend to push (e.g. after a deliberate rotation), not a stale
copy that would silently replace a currently-correct deployed secret.

---

**Step 3 — dry run the sync (prints names only, pushes nothing).**

```bash
bash scripts/sync-hydration-secrets.sh --dry-run
```

Expect three names listed: `ALPACA_API_KEY`, `ALPACA_API_SECRET`,
`PORTAL_PUSH_SECRET`. No values are printed.

---

**Step 4 — push the three secrets for real.**

```bash
bash scripts/sync-hydration-secrets.sh
```

> **If step 3 or 4 errors with `Missing ~/.claude/scripts/sync-secrets.sh`**,
> use this equivalent — same effect, no wrapper, still never prints a value:
>
> ```bash
> for k in ALPACA_API_KEY ALPACA_API_SECRET PORTAL_PUSH_SECRET; do
>   awk -F= -v k="$k" '$1==k{sub(/^[^=]*=/,""); gsub(/^"|"$/,""); print; exit}' .env.local \
>     | tr -d '\n' | gh secret set "$k" && echo "set $k"
> done
> ```

---

**Step 5 — verify all three landed.**

```bash
gh secret list | grep -E 'PORTAL_PUSH_SECRET|ALPACA'
```

Expect **3 rows**. This is the check that closes the outage's root cause.

---

**Step 6 — smoke test the workflow** (Phase 1.2).

```bash
gh workflow run hydrate-universe.yml -f limit=25
sleep 5
gh run watch "$(gh run list --workflow=hydrate-universe.yml --limit 1 --json databaseId -q '.[0].databaseId')"
```

Expect: green, `written=50`, `calc-errors=0` in the log. If it still fails in
~25 seconds, re-read the guard message — it names the specific missing value:

```bash
gh run view "$(gh run list --workflow=hydrate-universe.yml --limit 1 --json databaseId -q '.[0].databaseId')" --log-failed
```

---

**Step 6b — full universe hydration.** ✅ *Done automatically by the
2026-09-15T00:47Z scheduled run — kept here as the recipe for forcing a full
run on demand.*

A limited run (`-f limit=N`) only writes N symbols per lane. Omit the limit to
hydrate everything (~933 symbols → ~1,866 rows). Takes ~30s of runner time.

```bash
cd ~/code/nuwrrrld-portal
gh workflow run hydrate-universe.yml          # no -f limit → all lanes, all symbols
sleep 5
gh run watch "$(gh run list --workflow=hydrate-universe.yml --limit 1 --json databaseId -q '.[0].databaseId')"
```

Expect the header to name the full lane sizes (`stock=762 etf=171 chunk=35`),
22 chunks, and `[done] written=1866 calc-errors=0 post-failures=0 total=933` —
**not** a 50-symbol smoke-test shape. A run that finishes in <40s with
`total=50` was limited and did not cover the universe.

If it fails partway, read the guard message — it names the specific cause:

```bash
gh run view "$(gh run list --workflow=hydrate-universe.yml --limit 1 --json databaseId -q '.[0].databaseId')" --log-failed
```

---

**Step 7 — confirm the data actually advanced.**

> **Do not trust `check-card-freshness.mjs` alone for this step** — it reads
> `max(bar_date)`, so a *partial* hydration makes it report green (this is
> exactly what happened on 2026-09-13). Use the per-date row counts below as
> the real check; see §0a-bis.

Easiest — run the freshness checker itself (it reads the endpoint with the
right bearer token; the value is pulled from `.env.local` into the child
process, never printed):

```bash
PORTAL_URL="https://financial.nuwrrrld.com" \
PORTAL_PUSH_SECRET="$(awk -F= '/^PORTAL_PUSH_SECRET=/{sub(/^[^=]*=/,""); gsub(/^"|"$/,""); print; exit}' .env.local)" \
node scripts/check-card-freshness.mjs
```

Exit 0 = fresh. Exit 1 = stale past `MAX_STALE_TRADING_DAYS` (default 3).
Exit 2 = config/HTTP problem.

Raw endpoint, if you want the JSON. Uses `curl --config -` so the secret is
read over stdin rather than passed as a process argument another local user
could read via `ps`:

```bash
PORTAL_PUSH_SECRET="$(awk -F= '/^PORTAL_PUSH_SECRET=/{sub(/^[^=]*=/,""); gsub(/^"|"$/,""); print; exit}' .env.local)" \
curl -s --config - "https://financial.nuwrrrld.com/api/pipeline/hydrate-universe?meta=freshness" <<EOF | jq
header = "Authorization: Bearer ${PORTAL_PUSH_SECRET}"
EOF
```

Expect `latestBarDate` = the last trading day, and a small `staleTradingDays`.

**The real check — per-date row counts** (a single `max()` hides a partial run).
Uses `PGSERVICEFILE`/`PGSERVICE` so the connection string never appears as a
`psql` argument:

```bash
mkdir -p ~/.config/nuwrrrld && chmod 700 ~/.config/nuwrrrld
awk -F= '/^DATABASE_URL=/{sub(/^[^=]*=/,""); gsub(/^"|"$/,""); print; exit}' .env.local \
  | node -e "const u=new URL(require('fs').readFileSync(0,'utf8').trim());console.log(\`[nuwrrrld]\nhost=\${u.hostname}\nport=\${u.port||5432}\ndbname=\${u.pathname.slice(1)}\nuser=\${decodeURIComponent(u.username)}\npassword=\${decodeURIComponent(u.password)}\nsslmode=require\`)" \
  > ~/.config/nuwrrrld/pg_service.conf
chmod 600 ~/.config/nuwrrrld/pg_service.conf
PGSERVICEFILE=~/.config/nuwrrrld/pg_service.conf PGSERVICE=nuwrrrld \
  psql -c "SELECT bar_date, count(*) AS rows FROM ticker_cards GROUP BY bar_date ORDER BY bar_date DESC LIMIT 6;"
```

Expect **one dominant recent row count** (~1,800+ on the last trading day) and
no large cluster on an old date. A tall old bucket (e.g. `2026-08-19 | 1734`)
means the hydration was partial — re-run step 6b without a limit.

> **`psql` not installed?** (`command not found: psql` — confirmed on this Mac
> 2026-09-14.) Install it, or use the Neon SQL editor:
> ```bash
> brew install libpq && brew link --force libpq
> ```
> 🖱 Or run the same query in the Neon console → **SQL Editor**:
> https://console.neon.tech

Expect `newest` = the last trading day (not 2026-08-19), and the
`signal-freshness-check` workflow green on its next weekday 13:00 UTC run.

---

**Step 8 — create the two repo labels** the failure-notification jobs
reference (`github-script` 422s without pre-existing labels on some repo
configs; safest to create them once).

```bash
gh label create hydration-failure --color B60205 --description "Nightly universe hydration failed" 2>/dev/null || echo "hydration-failure already exists"
gh label create stale-signals     --color D93F0B --description "Signal cards are stale past the freshness threshold" 2>/dev/null || echo "stale-signals already exists"
gh label list | grep -E 'hydration-failure|stale-signals'
```

Expect both rows listed.

---

- [ ] **(signals-app, Phase 1.6)** `OPENROUTER_API_KEY` is missing from that
      repo's secrets and blocks its production run — structurally identical to
      this outage. Do it in the same session:
      ```bash
      cd ~/code/signals-app
      gh secret list | grep OPENROUTER_API_KEY || echo "absent — push it"
      awk -F= '/^OPENROUTER_API_KEY=/{sub(/^[^=]*=/,""); gsub(/^"|"$/,""); print; exit}' .env.local \
        | tr -d '\n' | gh secret set OPENROUTER_API_KEY
      gh secret list | grep OPENROUTER_API_KEY
      cd ~/code/nuwrrrld-portal
      ```

Full analysis: [docs/signal-engine-parity-across-hosts.md](signal-engine-parity-across-hosts.md) §0.1.

---

## 0a-bis. 🔴 The freshness guard reports green on a partially-hydrated universe

**Found 2026-09-14**, while verifying §0a's fix. This is a code bug, filed here
because it silently invalidates the one alarm §0a installed.

`scripts/check-card-freshness.mjs` (and the `?meta=freshness` endpoint it
reads) answer with **`max(bar_date)`** and a `staleTradingDays` derived from
it. On 2026-09-14 the real table was:

| `bar_date` | rows |
|---|---|
| 2026-09-13 | 100 |
| 2026-08-19 | **1,734** |

and the checker printed `ranked universe is fresh — latest bar_date=2026-09-13
staleTradingDays=0`, exit 0. **100 fresh rows out of 1,864 is indistinguishable
from full coverage**, because a maximum cannot see the distribution underneath
it. Any smoke test — or any partial run that dies after one chunk — re-arms the
green light for `MAX_STALE_TRADING_DAYS` more days while the universe rots.

This is the same failure shape as the original outage: the *writer* failed
loudly, and the thing that was supposed to notice stayed quiet. Phase 1 added
an independent reader precisely so a writer bug couldn't hide — but the reader
was given a metric that a partial write satisfies.

- [ ] **Make the freshness check coverage-aware, not max-aware.** The check
      should compare *how many distinct active symbols* have a card on the
      latest trading day against `ticker_universe`'s active count, and go red
      below a ratio (~0.9), independently of `max(bar_date)`. **Must be
      computed per lane (`stock`/`etf`), not as one aggregate ratio** —
      `ticker_cards` holds one row per `(ticker, horizon)`, two horizons per
      ticker, so a naive `count(*)` isn't a symbol count, and an aggregate
      ratio across both lanes can pass at ≥0.9 while one lane is fully stale
      and the other is fresh. Sketch:
      ```sql
      SELECT
        u.universe,
        count(DISTINCT u.ticker) AS expected,
        count(DISTINCT c.ticker) FILTER (WHERE c.bar_date = (SELECT max(bar_date) FROM ticker_cards)) AS fresh
      FROM ticker_universe u
      LEFT JOIN ticker_cards c ON c.ticker = u.ticker
      WHERE u.active
      GROUP BY u.universe;
      ```
      Have `check-card-freshness.mjs` exit 1 when **either** lane's
      `fresh / expected` is below the threshold, and surface all four numbers
      in the `?meta=freshness` payload (`stock: {expected, fresh}`,
      `etf: {expected, fresh}`) so the endpoint can't report a reassuring
      aggregate that hides one stale lane.
- [ ] **Test it the way the existing threshold is tested** — by forcing the
      condition, not by waiting:
      ```bash
      PORTAL_URL="https://financial.nuwrrrld.com" \
      MIN_FRESH_COVERAGE_RATIO=0.99 \
      PORTAL_PUSH_SECRET="$(awk -F= '/^PORTAL_PUSH_SECRET=/{sub(/^[^=]*=/,""); gsub(/^"|"$/,""); print; exit}' .env.local)" \
      node scripts/check-card-freshness.mjs
      ```
      Expect exit 1 while coverage is partial, exit 0 after step 6b's full run.

---

## 0b. Signal-engine three-phase plan — what `feat/signal-engine-phases-1-3` did, and what it deliberately did not

That branch implements the **code-only** parts of Phases 1–3 of
[docs/signal-engine-three-phase-plan.md](signal-engine-three-phase-plan.md):

**Landed (code + tests):**

- Phase 1.3/1.4/1.5 — workflow `secrets.PORTAL_URL` fix, failure→issue alert,
  independent freshness check (see §0a).
- Phase 2.1 — Alpaca `next_page_token` pagination in `scripts/hydrate-local.mjs`
  with a per-chunk `pages= symbols=X/Y bars=` log line and a `pages>1` warning.
- Phase 2.2 — `lib/shared/hydration-constants.json` as the single source
  (`LOOKBACK_DAYS=365`, `CHUNK_SIZE=35`, `feed=iex`, `adjustment=split`,
  `MIN_BARS=40`, `MIN_COVERAGE_RATIO=0.95`), re-exported by `.ts` and `.mjs`,
  drift-pinned by a test. **Modal (`deploy/universe-hydration/modal_app.py`) is
  NOT wired to the JSON twin yet** — it lives in this repo but Modal reads its
  own constants. Porting that is the remaining half of 2.2.
- Phase 2.3 — `normalizeToAlpaca()` in `seed-signals-universe.mjs` rewrites
  `BRK-B`→`BRK.B` at ingest. **`BRK-B`/`BF-B` are still deactivated in
  `ticker_universe`** — re-run the seeder and `prune-universe.mjs --dry-run` to
  reactivate them (Phase 2.5), and verify `SCHW-PD` separately.
- Phase 2.4 — `isCryptoShaped()` rejects `*-USD`-style pairs at the `PUT`
  registration route. Existing crypto rows already in `ticker_universe` are not
  retroactively removed — deactivate them once (`UPDATE ticker_universe SET
  active=false WHERE ticker ~ '-USD$'`).
- Phase 3.2 — real `dataQuality`: `completeness(input) × barQuality(frameStats)`
  where `frameStats` (`barCount`, `nanRatio`, `staleTradingDays`) is measured by
  the compute host and threaded through the ingest route. Backward compatible —
  a host that omits `frameStats` gets the old completeness-only number.

**Deferred — needs a decision, a migration, or a full-universe run first:**

- [ ] **Phase 3.2 `reasons` persistence.** `qualityReport()` returns
      human-readable reasons but there is **no `ticker_cards` column** to store
      them. Adding one is a schema migration (`migrations/`) — do it deliberately,
      not as a drive-by. Until then reasons are compute-time only.
- [ ] **Phase 3.1 — one confluence implementation.** Not started. The plan wants
      confluence computed once in `lib/shared/card-policy.ts` with Modal and
      `hydrate-local.mjs` deleting their copies. The interim drift-pinning test
      (JS `confluence` vs captured Python `_confluence`) also needs **reference
      values captured by running `modal_app.py`'s `_confluence`** — do that
      capture before writing the test, or it pins nothing.
- [ ] **Phase 3.3 — relative strength / sector rank.** Not started. Needs the
      full ~950-symbol run to exist (Phase 2.6) and a server-side or
      second-pass computation — it cannot run inside a 35-symbol chunk. The CSV's
      `sector_group` column is parsed and discarded today.
- [ ] **Phase 3.4–3.6 — remaining detector families, MTF composite.** Not
      started; gated on 3.1 landing so detectors aren't ported twice.

---

## 0. What was broken (historical — see the 2026-09-03 resolution note below)

**`NEON_API_KEY`/`NEON_PROJECT_ID` now exist (set 2026-08-30) — the diagnosis
below is preserved for context, not the current cause of any remaining
failure.** If `integration` is still red, re-run it and read the fresh log
rather than assuming this is why.

The `integration` CI job originally failed on **every** branch —
`feat/consent-cookies-tracking` (PR #77) and `feat/auth-cookies-phase-1-3-6`
(PR #78) alike. It predated both.

```
env:
  NEON_API_KEY:                       <- empty
ERROR: Cannot run interactive auth in CI
```

`.github/workflows/integration-tests.yml` creates an ephemeral Neon branch per
run. With no API key, `neonctl` falls back to interactive auth and dies.

> **The earlier caution about `gh secret list` is resolved.** That command was
> flaky during the 2026-08-30 session (14 secrets, then 0 rows), so every
> "missing from GitHub" claim was marked unverified. It was re-run cleanly on
> **2026-09-03** and returned 17 secrets; the resulting present/absent split is
> recorded in §2 and is now fact, not assumption. Note that `NEON_API_KEY` and
> `NEON_PROJECT_ID` **do now exist** (set 2026-08-30) — so §1's first two rows
> are done, and the integration job's failure, if it persists, has a different
> cause than the one recorded above. Re-run it and re-read the log.

**Also broken (verified 2026-09-03 by live probe):** the `afternoon-pipeline.yml`
scheduler has no routes to call — `/api/pipeline/{signals-refresh,theses-score,
council-run,council-validate-distribution}` are absent from the repo and 404 in
production. `CRON_SECRET` is absent from `.env.local`; unless it is exported into
the environment another way (`scripts/local-trigger.mjs` layers `process.env`
over `.env.local`), local triggering has no token either. The GitHub Actions
secret state is unverified here — see the caution above. The `followed-tickers*`
routes are deployed but 503 unauthenticated. Full breakdown + probe table:
[docs/pipeline-route-status-issues.md](pipeline-route-status-issues.md).

---

## 1. Values that do not exist yet — you must create or fetch them

These are not in `.env.local`, so there is nothing to copy. Each has to be
generated or retrieved from a dashboard.

| Secret | Where to get it | Needed by | Status 2026-09-03 |
|---|---|---|---|
| `NEON_API_KEY` | Neon console → Account settings → API keys → Generate | `integration-tests.yml` | ✅ **set 2026-08-30** |
| `NEON_PROJECT_ID` | Neon console → Project settings → General. Looks like `wispy-forest-12345678` | `integration-tests.yml` | ✅ **set 2026-08-30** |
| `PORTAL_URL` | Just the deployed origin, e.g. `https://financial.nuwrrrld.com`. Also add to `.env.local` — `scripts/local-trigger.mjs` Path C reads it there. | `afternoon-pipeline.yml` + the other scheduled callers | ✅ set — but as a *secret*, see §0a |
| ~~`CRON_SECRET`~~ ✅ **set 2026-09-13** (`.env.local` + GHA; Vercel still unverified) | Generate one: `openssl rand -hex 32`. Must match what the cron caller sends. Set it in **three** places: `.env.local` (for local `curl` / `scripts/local-trigger.mjs`), Vercel project env, and `gh secret set`. It is **not** interchangeable with `PORTAL_PUSH_SECRET`. | `afternoon-pipeline.yml`, `track/select/judge-followed-tickers.yml`, `precompute-ai.yml`, `hydrate-universe.yml`, `/api/retention/*` | ✅ **present in `.env.local` + GHA** (2026-09-13) — ⚠️ Vercel unverified |
| ~~`GCP_WIF_PROVIDER`~~ | — | ~~`e2e-resiliency.yml`~~ | 🗑 **obsolete 2026-09-14** — the GCP auth step was deliberately removed; see §-1 |
| ~~`GCP_SERVICE_ACCOUNT`~~ | — | ~~`e2e-resiliency.yml`~~ | 🗑 **obsolete 2026-09-14** — same |

Three of the six are now done. **If the `integration` job is still red, its
cause has changed** — re-run it and read the current log:

```bash
gh workflow run integration-tests.yml
sleep 5
gh run watch "$(gh run list --workflow=integration-tests.yml --limit 1 --json databaseId -q '.[0].databaseId')"
```

### Paste-ready: `CRON_SECRET` (present in `.env.local` + GHA since 2026-09-13 — this block only backfills Vercel; steps 1–2 self-skip if already done)

It must be the **same value** in all three, and it is **not** interchangeable
with `PORTAL_PUSH_SECRET`. Step 1 checks first and skips if a value is
already in `.env.local`; step 3 (Vercel) is the one still unverified. **Step 2
re-pushes to GHA unconditionally** — `gh secret set` has no comparison or
confirmation of its own — so only run it if `.env.local`'s value is the one
you intend GHA to have; if GHA was already confirmed correct (per §-1) and
you only need to backfill Vercel, skip straight to step 3. The value is
never echoed to your screen.

```bash
cd ~/code/nuwrrrld-portal

# 1. generate and append to .env.local (aborts if one is already there)
grep -q '^CRON_SECRET=' .env.local \
  && echo "CRON_SECRET already in .env.local — skip to step 2" \
  || { printf 'CRON_SECRET=%s\n' "$(openssl rand -hex 32)" >> .env.local && echo "✓ generated + written to .env.local"; }

# 2. push the same value to GitHub Actions — SKIP if GHA is already confirmed
#    correct (§-1) and you only need step 3 (Vercel); this always overwrites.
awk -F= '/^CRON_SECRET=/{sub(/^[^=]*=/,""); gsub(/^"|"$/,""); print; exit}' .env.local \
  | tr -d '\n' | gh secret set CRON_SECRET

# 3. push the same value to Vercel (paste it when prompted — pbcopy first)
awk -F= '/^CRON_SECRET=/{sub(/^[^=]*=/,""); gsub(/^"|"$/,""); print; exit}' .env.local | tr -d '\n' | pbcopy
echo "value copied to clipboard — paste at the Vercel prompt"
vercel env add CRON_SECRET production

# 4. verify (names only, no values)
gh secret list | grep CRON_SECRET
vercel env ls production | grep CRON_SECRET
```

Then clear the clipboard: `pbcopy </dev/null`

### Paste-ready: the two GCP values (keyless WIF — no JSON key file)

Requires `gcloud` authenticated with IAM permissions on the target project.

```bash
cd ~/code/nuwrrrld-portal
gcloud auth list                       # confirm the right account is active
bash scripts/sync-e2e-secrets.sh --provision-wif
```

That prints a service-account address. Grant it **only** `roles/run.invoker`
on `gcp3-backend` — resist broader roles to make it work faster; a CI service
account with excess IAM is a finding on any client security review:

```bash
# find the service and its region (don't guess the region — it isn't pinned anywhere in this repo)
gcloud run services list --format='table(metadata.name, metadata.labels."cloud.googleapis.com/location")'
```

```bash
# the ONE value you must paste by hand — the address the --provision-wif step printed
SA="paste-the-service-account@project.iam.gserviceaccount.com"
REGION="paste-the-region-from-the-list-above"

gcloud run services add-iam-policy-binding gcp3-backend \
  --member="serviceAccount:${SA}" --role="roles/run.invoker" --region="${REGION}"
```

Verify both secrets landed:

```bash
gh secret list | grep -E 'GCP_WIF_PROVIDER|GCP_SERVICE_ACCOUNT'
```

Expect 2 rows. (The `secrets-sync` skill wraps this same flow if you'd rather
not run it by hand.)

---

## 2. Values that exist locally — push them to GitHub Actions

These are all in `.env.local` already. **`gh secret list` was re-run cleanly on
2026-09-03** — the split below is verified, not assumed. Push only the absent
column.

**Absent from GitHub Actions — push these:**

| Secret | Consequence today |
|---|---|
| `PORTAL_PUSH_SECRET` | 🔴 **nightly hydration dead 15 days** (§0a) |
| `ALPACA_API_KEY` | 🔴 same job, second guard |
| `ALPACA_API_SECRET` | 🔴 same job, third guard |
| ~~`STRIPE_WEBHOOK_SECRET`~~ | ✅ **pushed to GHA 2026-09-14** — a real `whsec_` value is now in `.env.local` and in GitHub Actions |
| ~~`STRIPE_PRICE_ANNUAL`~~ | ✅ **pushed to GHA 2026-09-14** — a real `price_` id is now in `.env.local` and in GitHub Actions |

The last two are **not** simple pushes — both are placeholder/empty locally, so
§4 must create real values first. Only the three Alpaca/portal secrets are a
straight file-to-CLI copy, and they are the highest-value three in this file.

**Already present (verified 2026-09-03) — do not re-push blindly:**

```
CLERK_SECRET_KEY  CLOUDFLARE_ACCOUNT_ID  CLOUDFLARE_API_TOKEN  DATABASE_URL
E2E_CLERK_TEST_EMAIL  E2E_CLERK_TEST_PASSWORD  IP_HASH_SECRET  MCP_BACKEND_URL
NEON_API_KEY  NEON_PROJECT_ID  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY  NULOGDASH_ADMIN_EMAILS  OPENROUTER_API_KEY
PORTAL_URL  STRIPE_PRICE_MONTHLY  STRIPE_SECRET_KEY
```

Two notes on that list. `NEON_API_KEY` / `NEON_PROJECT_ID` were set 2026-08-30,
which closes §1's first two rows. And `PORTAL_URL` is present as a **secret**,
which is why `hydrate-universe.yml`'s `vars.PORTAL_URL` lookup silently misses
(§0a).

Still absent and still blocking, per §1: `CRON_SECRET`, `GCP_WIF_PROVIDER`,
`GCP_SERVICE_ACCOUNT`.

Do it locally so no value passes through a chat session:

```bash
# from the repo root, with .env.local present
while IFS='=' read -r k v; do
  case "$k" in
    ALPACA_API_KEY|ALPACA_API_SECRET|CLERK_SECRET_KEY|DATABASE_URL|\
    IP_HASH_SECRET|MCP_BACKEND_URL|NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY|\
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY|NULOGDASH_ADMIN_EMAILS|\
    OPENROUTER_API_KEY|PORTAL_PUSH_SECRET|STRIPE_PRICE_ANNUAL|\
    STRIPE_PRICE_MONTHLY|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET)
      printf '%s' "${v%\"}" | sed 's/^"//' | gh secret set "$k"
      echo "set $k" ;;
  esac
done < .env.local
```

**Caveat worth pausing on:** `DATABASE_URL` in `.env.local` points at your real
Neon database. CI should get a *branch* connection string, not production —
that's exactly what `NEON_API_KEY` + `NEON_PROJECT_ID` exist to provide. Don't
push production `DATABASE_URL` as the CI secret if the workflow can mint its own.

---

## 3. Clerk — Phase 1.1 / 1.2 of the tracking plan

Currently running a **Development** instance (`pk_test_…`). Dev mode locally is
correct; dev mode in production is the bug.

- [ ] 🖱 **Dashboard:** create/activate the **Production** instance (needs a
      verified domain + DNS for `clerk.financial.nuwrrrld.com` first) —
      https://dashboard.clerk.com/apps → your app → **Instances** →
      **Production**
- [ ] Once you have the live keys, push them to Vercel (keep `pk_test_…` in
      local `.env.local` deliberately — do not overwrite it):
      ```bash
      vercel env add NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY production
      vercel env add CLERK_SECRET_KEY production
      ```
- [ ] Verify the production build:
      ```bash
      curl -sI https://financial.nuwrrrld.com | grep -i set-cookie
      # __session should come from the production domain, not *.accounts.dev
      # and the page should render with no Clerk dev badge
      ```
- [ ] 🖱 **Dashboard:** confirm the dev-instance shared JWT signing key is
      **not** trusted by any production API route —
      https://dashboard.clerk.com/apps → your app → **Production instance** →
      **API keys** → **JWT templates**
- [ ] 🖱 **Dashboard:** set an explicit session lifetime + inactivity timeout
      (this is a financial product; the default multi-day session is too
      long) — https://dashboard.clerk.com/apps → your app → **Production
      instance** → **Sessions**
- [ ] Audit the served session cookie attributes in production:
      ```bash
      curl -sI https://financial.nuwrrrld.com/api/health | grep -i set-cookie
      # expect: Secure; HttpOnly; SameSite=Lax; Domain scoped to the apex
      # only if subdomain sharing with mobile is genuinely needed
      ```
- [ ] Decide and write down whether `gcp3-mobile` shares this Clerk instance.
      If it does, a session revocation on one surface must revoke on the
      other — **test it, don't assume it**: revoke a session from one
      surface's UI, then confirm the other surface's next authenticated
      request 401s.

---

## 4. Stripe — **this section is where money is actually lost**

Ranked by revenue consequence, not effort. The first two items are the reason
this app cannot currently take a paying customer end-to-end. Full reasoning and
retrieval steps: [docs/stripe-todo.md](stripe-todo.md); business framing:
[docs/ship-to-clients-top-25.md](ship-to-clients-top-25.md) items 1–6.

- [x] ~~**`STRIPE_WEBHOOK_SECRET` — a real `whsec_…` for the production endpoint.**~~
      — **Resolved**: a real `whsec_` value was pushed to GHA 2026-09-14 (see
      §-1); `.env.local` no longer holds `whsec_placeholder_*`. Kept below for
      the rotation procedure, still relevant if this value is ever rotated.
      Previously: until it was real, `app/api/webhooks/stripe/route.ts` logged
      a `CONFIG_ERROR` and **rejected every event Stripe sends** — a customer
      would complete checkout, Stripe would charge their card, the portal
      would never learn about it, and they'd stay on the free tier, paid and
      got nothing, with no error visible to them.
      Stripe reveals the endpoint signing secret in **Workbench → Webhooks**
      (view it any time, not only at creation). Rotation offers two expiry
      modes: **expire immediately** (old secret invalid at once) or **keep the
      previous secret valid for up to 24 h** (Stripe signs with both during the
      window). Pick the 24 h delay unless you can update `.env.local`, Vercel,
      and GHA secrets in one window; document which mode you chose, and verify
      every deployed copy holds the new value before the old one expires.
      `app/api/health` surfaces the current state; check it rather than trusting
      the env file.
- [ ] **`STRIPE_PRICE_ANNUAL` — confirm it's a live-mode price, not create it.**
      A real `price_` id is now in `.env.local` and GHA (pushed 2026-09-14, see
      §-1) — `lib/stripe.ts`'s `PRICES.annual` no longer resolves to `''`.
      What's still open: confirming the id is **live-mode**, not test-mode —
      also confirm `STRIPE_PRICE_MONTHLY` is live-mode while you're there. If
      either turns out to be test-mode, decide the amount before creating a
      replacement: Stripe price objects are immutable, so changing one later
      means archive-and-recreate, and archiving only affects new
      subscriptions — you would be grandfathering the wrong number.
      This blocker is closed alongside `STRIPE_WEBHOOK_SECRET` (also real
      as of 2026-09-14, see §-1) — the remaining live-mode confirmation above
      is what still gates re-enabling the `preflight-billing` Playwright tier;
      do that only after `/api/health` reports Stripe healthy.
- [ ] **Rotate `STRIPE_SECRET_KEY` — before §2 pushes secrets, or re-push
      after.** Recorded as already exposed in
      [docs/env-rotation.md](env-rotation.md), separate from the unset values
      above. This is a create-charges-and-issue-refunds credential. Ordering
      matters: §2's sync copies `STRIPE_SECRET_KEY` from `.env.local` to GitHub
      Actions, so rotating *after* that leaves CI on the old key. Either rotate
      first, or add an explicit re-sync of this one value after rotation. After
      rotating, confirm the old key is **revoked**, not merely superseded — a
      rotated-but-still-valid key is not rotated.
- [ ] Point the production webhook endpoint at `/api/webhooks/stripe` and verify
      a test event is accepted (signature verification is already implemented).
      Confirm the endpoint's selected event list actually includes what the
      route's switch handles — check the file, don't select "all events".
- [ ] **Verify one real paid signup end to end**, not a unit test: checkout →
      webhook received → Clerk `publicMetadata.subscription_status` → the three
      entitlement-gated routes (`/dashboard/nuai`, `/dashboard/signals`,
      `/dashboard/portfolio`) render instead of redirecting to `/pricing`.
      **The trap:** `subscription_status` has no `'pro'` value. Valid values are
      `free | trialing | active | past_due | canceled | paused`, and the Stripe
      webhook writes `sub.status` (`app/api/webhooks/stripe/route.ts`), never
      `'pro'`. A manual `'pro'` metadata write *does* store, but
      `tierFromStatus()` and `parseSubscriptionMetadata()`
      (`lib/subscription.ts`) both read it as `'free'` — `isSubscriptionStatus()`
      guards *reads*, not the write. Result: a paying customer with no access and
      no error anywhere. Assert on the **rendered gated page**, never on the
      metadata write succeeding.
- [ ] **Verify cancellation and downgrade**, the path nobody tests until a
      chargeback arrives. Confirm `customer.subscription.deleted` and
      `invoice.payment_failed` are both in the endpoint's event list and handled.
      A canceled subscriber should lose access at period end — not immediately
      (charging through the 28th and cutting off on the 3rd is a refund request)
      and not never.
      Decide `past_due` explicitly: `tierFromStatus()` currently maps it to
      `pro`, so a failed payment keeps full access. That is a defensible grace
      period, but make it a bounded *choice* rather than an accident.
- [x] ~~**Decide `PORTAL_PUSH_SECRET` — generate it or delete the dependency.**~~
      **Answered 2026-09-03, by evidence rather than by decision: the caller is
      real.** This item framed it as possibly-dead config, weighing
      `refresh-signals.py` and `/api/signals/digest`. It missed the actual
      consumer — **`.github/workflows/hydrate-universe.yml`**, a live scheduled
      job that has been failing nightly on this exact secret since 2026-08-19.
      The value already exists in `.env.local`; it was never pushed. See §0a —
      it is now the top item in this file.
      The lesson worth keeping: "is this dependency real?" was answerable the
      whole time by grepping the workflows for the secret name, and deferring it
      as a *decision* cost 15 days of universe coverage. A secret referenced by
      a scheduled workflow is never dead config.

---

## 5. Neon

- [x] ~~Generate the API key + project ID from §1~~ — done 2026-08-30.
- [x] **Verified 2026-09-14 — all four tables exist.** Query kept for re-checking:
      ```sql
      SELECT table_name FROM information_schema.tables
      WHERE table_name IN ('consent_records','legal_consent_events',
                           'privacy_requests','user_attribution');
      ```
      Expect 4 rows.
- [ ] Decide a retention/backup posture for `privacy_requests` — it is
      deliberately excluded from the erasure cascade and is the evidentiary
      record that a deletion request happened.

---

## 5b. CI and test-infrastructure blockers

These keep a 34-test Playwright suite and two CI checks permanently red. A suite
that always fails for an environmental reason is worse than no suite: people
learn to ignore it, which also masks the real failures underneath.

- [x] ~~**Set `E2E_CLERK_PUBLISHABLE_KEY` / `E2E_CLERK_SECRET_KEY` GitHub
      secrets to the Clerk dev instance's values.** Root cause of 4
      consecutive `auth`-job failures (PRs #106–#110, 2026-09-04) — see
      `docs/known-bugs.md` item 16 and `docs/clerk-dev-to-prod.md` §5/§6 for
      the full writeup. The 2026-09-02 prod cutover pushed `pk_live_`/
      `sk_live_` keys into the `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`/
      `CLERK_SECRET_KEY` secret names that `e2e-resiliency.yml` was reading;
      a production key is domain-locked and can't load against the
      workflow's `localhost` `next dev`, so the sign-in page's email field
      never rendered. `.github/workflows/e2e-resiliency.yml` now reads a
      separate secret pair instead, but those two secrets don't exist yet and
      need real values — the same dev-instance keys already in `.env.local`
      (confirmed still `pk_test_`/`sk_test_` locally, unaffected by the prod
      cutover per that doc's §4 "recommended" split). Use the `secrets-sync`
      skill (never paste the values into chat):
      ```bash
      awk -F= '/^NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=/{print $2}' .env.local | gh secret set E2E_CLERK_PUBLISHABLE_KEY
      awk -F= '/^CLERK_SECRET_KEY=/{print $2}' .env.local | gh secret set E2E_CLERK_SECRET_KEY
      ```
      A preflight test (`e2e/preflight/credentials.spec.ts`) now fails fast
      and legibly if these are ever pointed at production again.
- [x] 🗑 **OBSOLETE 2026-09-14 — do not provision. See §-1.** ~~Provision the GCP Workload Identity Federation pool.~~ All four `e2e`
      shards fail immediately at "Authenticate to GCP (keyless)" because
      `GCP_WIF_PROVIDER` is empty (§1 above).
      **Full paste-ready sequence is in §1 above** ("Paste-ready: the two GCP
      values"). Short form:
      ```bash
      cd ~/code/nuwrrrld-portal
      gcloud auth list                                    # right account active?
      bash scripts/sync-e2e-secrets.sh --provision-wif
      gh secret list | grep -E 'GCP_WIF_PROVIDER|GCP_SERVICE_ACCOUNT'   # expect 2 rows
      ```
      Then grant the printed service account **only** `roles/run.invoker` on
      `gcp3-backend` (§1 has the exact binding command). Resist broader roles
      to make it work faster — a CI service account with excess IAM is a
      finding on any client security review. Needs `gcloud` auth with IAM
      permissions on the target project.
- [ ] **Re-run the `frontend` Playwright tier and confirm two known bugs are
      actually closed.** The E2E user's Pro entitlement was patched
      (`known-bugs.md` item 1) but the tier was **never re-run to verify**. Item
      3 (portfolio-suggestions failure) is explicitly suspected to be the same
      redirect-to-`/pricing` cause. You may be one command from closing both,
      and right now you don't know which recorded failures are still real.
- [x] ~~**Resolve `shared-drift-check`.**~~ — **passing** on PR #135 as of 2026-09-14. `lib/subscription.ts` has drifted from
      its `gcp3-mobile` counterpart. This is a genuine cross-repo decision —
      which repo owns the canonical tier logic — not a lint failure to suppress.
      Note it guards exactly the file whose `subscription_status` semantics the
      §4 trap lives in: drift here means the two surfaces can disagree about who
      is a paying customer.
- [x] **Likely already done** — the `Cloudflare Pages` check no longer appears on PR #135 (2026-09-14). No Cloudflare token exists locally to confirm via API; verify once in the dashboard. Original instructions: 
      [docs/cloudflare-pages-assessment.md](cloudflare-pages-assessment.md).

---

## 5c. Observability — you currently cannot detect an outage

Not dashboard-blocked in the same way as the sections above, but both need an
account and a decision, so they belong on a human's list.

- [ ] **Wire error monitoring.** There is none, by behavior not just by grep:
      `app/error.tsx` and `app/global-error.tsx` only `console.error`,
      `lib/analytics.ts` drops validated events, and `package.json`,
      `next.config.ts`, and `middleware.ts` carry no monitoring integration.
      Today the detection mechanism for a broken paid feature is a customer
      emailing you, so mean-time-to-detect equals customer patience.
      Sentry's Next.js SDK is the shortest path:
      ```bash
      npx @sentry/wizard@latest -i nextjs
      ```
      Then set the DSN as a secret and confirm delivery:
      ```bash
      awk -F= '/^SENTRY_DSN=/{print $2}' .env.local | gh secret set SENTRY_DSN
      vercel env add SENTRY_DSN production
      curl -s https://financial.nuwrrrld.com/api/debug-sentry  # or trigger one deliberate error
      ```
      Confirm the event lands: 🖱 https://sentry.io → your project → **Issues**.
      (Pairs with the analytics DPA decision in §6: if PostHog is chosen there,
      it can cover part of this.)
- [ ] **Point an external uptime monitor at `/api/health`.** The route already
      exists and reports per-dependency status — it is what surfaces the Stripe
      misconfiguration in §4. This is the cheapest item in this file and covers
      the half Sentry cannot: out-of-process death, not in-process exceptions.
      Verify the route responds correctly first:
      ```bash
      curl -s https://financial.nuwrrrld.com/api/health | jq
      ```
      Then wire a monitor — 🖱 e.g. Better Uptime, UptimeRobot, or Vercel's own
      Checks (https://vercel.com/dashboard → project → **Monitoring**) — at
      `https://financial.nuwrrrld.com/api/health`, alerting on non-200 or a
      `"status": "unhealthy"` body field.

---

## 5d. Scheduled-pipeline routes — the afternoon pipeline calls nothing

Verified 2026-09-03 by probing every `/api/pipeline/*` route on production.
Full table + reasoning: [docs/pipeline-route-status-issues.md](pipeline-route-status-issues.md).

- [ ] **Land the 4 `afternoon-pipeline` routes** — `signals-refresh`,
      `theses-score`, `council-run`, `council-validate-distribution`. Absent from
      the repo, 404 in production; the workflow has been non-functional since PR
      #59 (2026-08-14). This is code, not a login — tracked here only because it
      blocks the same scheduler the secret items above do. `precompute-ai` and
      `hydrate-universe` (which shipped in PR #66) are the working template.
- [ ] **Or disable the workflow** meanwhile:
      `gh workflow disable afternoon-pipeline.yml` — it currently files a
      `pipeline-failure` issue on every gate-clearing run.
- [x] ~~**Create the `pipeline-failure` label**~~ — **exists** (verified 2026-09-14), along with `hydration-failure` and `stale-signals`.
- [ ] **Investigate the `followed-tickers*` 503s** — `followed-tickers`,
      `followed-tickers-select`, `followed-tickers-judge` are deployed but return
      503 to an unauthenticated request (before the 401 the auth layer should
      give). Something in each handler throws on a missing dependency. Needs a
      code + Vercel-log read, not a dashboard click.

---

## 5e. precompute-ai / Modal double-schedule — make the code change take effect

The branch `feat/pipeline-full-runs-nulogdash` removed `schedule=modal.Cron(...)`
from `deploy/precompute-ai/modal_app.py` so GitHub Actions
(`precompute-ai.yml`) is the sole scheduler
(incident-2026-09-04-precompute-ai-double-schedule). That change is inert until
someone runs Modal against the real account:

- [ ] **Confirm whether `nuwrrrld-precompute-ai` is currently deployed** —
      `modal app list`. Per incident-2026-08-18 it never has been, but that was
      not re-verified.
- [ ] **If it is deployed:** `modal deploy deploy/precompute-ai/modal_app.py`
      once (picks up the removed schedule), or `modal app stop nuwrrrld-precompute-ai`.
      Until then, if it was ever deployed with the old schedule, both runners
      still fire nightly at 00:10 UTC and double-spend the OpenRouter quota.
- [ ] **Create the `pipeline-failure` label** (also listed in §5d) —
      `gh label create pipeline-failure --color B60205 --description "Scheduled pipeline run failed"`.
      The new `notify` jobs on `precompute-ai.yml`, `refresh-free-models.yml`,
      `compile-grounding-pack.yml`, and `backup-to-sqlite.yml` all reference it.

## 5f. nulogdash sweep — local env + remaining inventory drift

- [ ] **`NULOGDASH_BASE_URL` set to `http://localhost:3000` 2026-09-14; `NULOGDASH_SESSION_COOKIE` still empty and still blocking 28 auth features.** Original note:
      Both currently ship as empty `KEY=` lines. `NULOGDASH_BASE_URL=` empty no
      longer breaks the sweep (the `??` → trim-and-`||` fix in
      `scripts/nulogdash.mjs`), but it still needs a real value —
      `http://localhost:3000` — to point anywhere. `NULOGDASH_SESSION_COOKIE`
      needs a live `__session` cookie for a dedicated test user or 28 auth
      features stay `blocked`.
- [x] ~~**Set a local `CRON_SECRET`**~~ — present in `.env.local` as of 2026-09-13. if you want to
      exercise the `followed-tickers*` pipeline routes locally — any random
      value, matched by the `Authorization: Bearer` header you pass.
- [x] ~~**13 inventory drift warnings remain** after this PR (was 21): the
      GDPR/consent endpoints (`/api/consent`, `/api/disclaimer`,
      `/api/legal-consent`, `/api/privacy/{delete,export,profile,rectify}`) plus
      `/api/analyze`, `/api/attribution`, `/api/signals/top`. Each needs a
      `FEATURE_META` entry (or an `excluded:` reason) in
      `scripts/nulogdash-inventory.mjs` — deciding auth/body/deps per route is a
      judgement call, tracked here as a follow-up batch.~~ — **done 2026-09-10,
      PR #118.** All 13 described; drift is now 0. Two were resolved by
      *excluding* rather than describing: `POST /api/privacy/delete` (deletes the
      test user's Clerk account and every row they own — never safe on a sweep)
      and `POST /api/launch/remind` (bearer-secret only, no user-facing form).
      The six that appeared to 404 were never broken — they sit behind
      `proxy.ts`'s matcher and Clerk answers an unauthenticated request to a
      protected API route with `404`, not `401`.

### Added 2026-09-10 (PR #118)

- [ ] **Enrol MFA on the admin account** to unlock the nulogdash trigger buttons.
      - **From**: PR #118 — e2e run against the live console
      - **Blocked on**: a second factor on the allowlisted admin's Clerk account
      - **Why it can't be code**: `canPerformAdminAction` requires
        `twoFactorEnabled`, which only the account owner can set — and the free
        Clerk tier may not offer it at all (see §3 and
        `docs/wiki-portal/decision-self-implemented-totp-over-clerk-pro.md`)
      - **Unblocks**: dry-run/live-run buttons on `/dashboard/nulogdash/pipelines`;
        also the only way to e2e-test the *positive* trigger path, which is
        currently unverified in a browser
      - **Added**: 2026-09-10
- [ ] **Add the new operator address to `NULOGDASH_ADMIN_EMAILS` in Vercel**
      (production + preview), and confirm it is that Clerk account's **primary
      and verified** address.
      - **From**: PR #118 — admin gate verified locally only
      - **Blocked on**: Vercel dashboard access; Clerk email verification
      - **Why it can't be code**: `.env.local` is git-ignored and local-only;
        `isNulogdashAdmin` reads the deployed env var and requires a *verified
        primary* address, which the user must confirm in Clerk
      - **Unblocks**: admin console access in deployed environments
      - **Added**: 2026-09-10
- [ ] **Set the rotated `OPENROUTER_API_KEY` in Vercel.**
      - **From**: PR #118 session — the previous key had expired (`401 "API key
        expired"`); a working key is now in `.env.local` only
      - **Blocked on**: Vercel dashboard access
      - **Why it can't be code**: secret values must never be committed or pass
        through a session transcript
      - **Unblocks**: every AI surface in deployed environments
      - **Added**: 2026-09-10
- [ ] **Resolve the T1 council seat's `403`.**
      - **From**: PR #118 — the one remaining sweep failure (`council-sample`)
      - **Blocked on**: an OpenRouter account/model-access setting, or a decision
        to repoint the seat
      - **Why it can't be code**: PR #115 pointed T1 at a `:free` model that
        returns `403` for this account — likely a data-policy/privacy toggle only
        the account owner can enable. Note `runSeat` treats `403` as fatal and
        does **not** fall through to `FREE_MODEL_CHAIN`, so one 403 kills the
        seat and the whole deliberation; that fallback behaviour is worth its own
        issue either way.
      - **Unblocks**: `council-sample`, `council-public`, and the landing-page
        council demo
      - **Added**: 2026-09-10
- [x] ~~**Bring `gcp3-backend` back up** (`MCP_BACKEND_URL` returns a real `503`).~~
      — **Resolved**, see §-1: `/api/health` reports all five dependencies
      `ok` (mcp, neon, stripe, openrouter, clerk) as of the 2026-09-14
      verification pass. Kept below for history.
      - **From**: PR #118 — `preflight` red, blocking the whole e2e browser chain
      - **Blocked on**: ~~whoever owns the Cloud Run deployment~~ — resolved
      - **Why it wasn't code**: the service itself was not serving; a direct
        probe of `{gcp3-backend-url}/health` returned
        `503 "The service you requested is not available yet"`
      - **Unblocked**: `health`, `auth-setup` and `frontend` Playwright projects
      - **Still worth doing regardless**: split `MCP_BACKEND_URL` out of
        `preflight` into its own gate, the same way `preflight-billing` was
        carved out, so a *future* third-party outage doesn't block the whole
        auth chain again.
      - **Added**: 2026-09-10
- [ ] **Decide whether the operator email already published to `main` matters.**
      - **From**: PR #118 — CodeRabbit "Sensitive Data Exposure" (CWE-359)
      - **Blocked on**: an owner judgement call
      - **Why it can't be code**: a personal address was written into two HTML
        reports that another session committed and merged via PR #116 into this
        **public** repo. PR #118 removes every occurrence from the working tree,
        but **git history still contains them** — scrubbing history needs a
        force-push/`filter-repo` and a decision about rewriting shared history.
        Separately, `docs/Recent Docs/how-i-use-zo.md` carries a different
        personal address, pre-existing and untouched by this PR.
      - **Unblocks**: nothing technical — this is a privacy call about content
        that has been publicly reachable since PR #116 merged
      - **Added**: 2026-09-10
- [ ] **gcp3's `/api/portfolio/health` returns `502` in CI e2e.**
      - **From**: `/wait-merge1` run on PRs #119/#120 — `e2e/frontend/portfolio-liveness.spec.ts`
        fails identically on both PRs (and, by the `main` e2e-resiliency runs
        checked the same day, pre-existing on `main` too — not caused by
        either PR)
      - **Blocked on**: gcp3's deployment — the spec's own error names it
        directly: "this is the exact 'route never registered' failure mode
        from incident-2026-07-26-portfolio-health-endpoint-missing.md. Check
        gcp3's deployment, not the portal." Distinct from the `MCP_BACKEND_URL`
        503 entry above (PR #118, 2026-09-10) — that one is the whole backend
        not serving; this one is the backend serving but this one route 502'ing,
        confirmed by the same spec run's `neon: ok` / `mcp: ok` health check.
      - **Why it can't be code**: the portal-side route already exists and
        calls out correctly; the 502 originates on gcp3's Cloud Run service
      - **Unblocks**: `e2e/frontend/portfolio-liveness.spec.ts`'s two portfolio
        health checks (score + AI explain)
      - **Added**: 2026-09-11
- [x] ~~**CI's own `OPENROUTER_API_KEY` (GitHub Actions secret) may also be stale.**~~ — **resolved 2026-09-14**: it was stale (dated 2026-08-18). The local key was validated live and re-pushed. Original entry:
      - **From**: `/wait-merge1` run on PRs #119/#120 — `e2e/frontend/portfolio-liveness.spec.ts`'s
        AI-explain check fails with `OpenRouter 401: all models in chain
        failed` (`lib/openrouter.ts:372`, `app/api/portfolio/health-ai/route.ts:139`)
        during the CI job itself, not against a deployed Vercel URL
      - **Blocked on**: confirming whether `gh secret list`'s `OPENROUTER_API_KEY`
        for this repo holds the same expired value the "Set the rotated
        `OPENROUTER_API_KEY` in Vercel" item above already found — GitHub
        Actions secrets and Vercel env vars are separate stores, so rotating
        one does not rotate the other
      - **Why it can't be code**: secret values must never be committed or
        pass through a session transcript
      - **Unblocks**: `e2e/frontend/portfolio-liveness.spec.ts`'s AI-explain
        check, and any other e2e spec that calls a real OpenRouter model
      - **Added**: 2026-09-11

---

## 6. Legal / vendor — blocks Phases 3.1, 4.2–4.4, 7

These need a signature or a qualified review, not a login.

- [ ] 🖱 **Dashboard/decision:** pick an analytics vendor and sign a DPA.
      PostHog EU cloud is the recommendation in the plan —
      https://app.posthog.com/signup → org settings → **Data Pipeline** →
      DPA. `lib/analytics.ts` is built and validating already — wiring a
      vendor is filling in one function body (`deliver()`). Once you have the
      key:
      ```bash
      awk -F= '/^POSTHOG_API_KEY=/{print $2}' .env.local | gh secret set POSTHOG_API_KEY
      vercel env add NEXT_PUBLIC_POSTHOG_KEY production
      ```
- [ ] 🖱 **Decision, in writing:** confirm the LLM providers' terms.
      `app/api/council/*` and `app/api/nuai/*` send user prompt text and
      watchlist context to OpenRouter and its upstreams. Nobody has verified
      zero-retention or no-training terms, and the free-model chain changes
      on its own, which can change the answer silently. This is the largest
      outbound flow of user-authored content in the system and the most
      under-examined item in this file. Review at
      https://openrouter.ai/docs/features/privacy-and-logging and record the
      answer in `docs/privacy-register.md`.
- [ ] 🖱 **Dashboard:** confirm DPAs exist for Clerk, Neon, Vercel, Stripe,
      Resend. See [docs/privacy-register.md](privacy-register.md) §2 — every
      row marked `*verify*` is an assumption, not a fact. Each vendor's DPA
      lives under its own dashboard's **Legal/Compliance/Trust** settings.
- [ ] 🖱 **Decision:** qualified pre-launch review of the privacy policy by
      counsel. Plan §7 requires it, and `docs/privacy-register.md` is written
      to be the input. Do not publish the retention table until the
      enforcement job exists (§7 below).
- [ ] 🖱 **Decision, only if an ad platform is used later:** Meta and Google
      both restrict financial-services advertising and may require account
      verification before spend — check
      https://www.facebook.com/business/help and
      https://support.google.com/adspolicy before buying.

---

## 6b. The one product decision only you can make

- [ ] 🖱 **Decision only — no CLI/dashboard action, a product call.** Decide
      how to close the explain-quality gate — before selling the AI
      tier, not after. This is the largest open item in the whole project and
      the least visible from outside.
      The live pipeline run in
      [docs/pipeline-todo-blockers.md](pipeline-todo-blockers.md) proved the
      coverage claim is real (54 symbols, 108 cards, **0 model calls**, 100% of
      the active universe). Two facts, kept separate because the code paths are:
      **(1)** every ETF card lands at `dataQuality: 0.20` — gcp3's ETF payload
      fills only **1 of 5** taxonomy inputs (`confluenceScore`); `rsi`,
      `macdCross`, `adx`, and `volatilityPercentile` are out of scope for its
      ETF model entirely — so every ETF card fails `isExplainable()`
      (`dataQuality >= 0.8`, zero missing fields). **(2)** the scheduled
      precompute job (`deploy/precompute-ai/modal_app.py`) sends only
      `maxSubjects`, so it runs the **watchlist** path, not `topCards()`;
      `topCards()` feeds the batch only when a caller explicitly passes
      `source: "ranking"`, and on that path it currently yields no ETF subjects.
      **Plainly: the AI-explanation feature behind the paid tier has no
      explain-eligible subjects in the current universe, today, until one of
      these ships.**
      - **(a)** Extend gcp3 to compute RSI/MACD/ADX/volatility for its 54 ETFs.
        It already has `features_rsi.py` and friends; they are simply not wired
        into the ETF path. Lower ceiling, much shorter runway.
      - **(b)** Ship the Modal stock lane and accept that ETF cards stay
        coverage-only forever — real coverage, never explainable.
      Every other item in this file is recoverable after a customer complains.
      This one means the complaint is "the product does nothing."

---

## 7. Engineering work that is still open (for completeness)

Not blocked on you — listed so this file is the full picture.

- **Retention enforcement job.** `docs/privacy-register.md` §3 documents targets;
  nothing enforces them. Until it exists, the policy must not publish that table
  or it repeats the over-promise this whole effort set out to close.
- **Restriction of processing (GDPR Art. 18).** Promised by privacy policy §8,
  still the one right with no mechanism.
- **Mobile parity.** `gcp3-mobile` tracks with no consent gate and has no
  data-subject-rights path, against the same Clerk identity. Two compliance
  asymmetries on one account. See `docs/wiki-portal/concept-sync-requirements.md`
  items 6, 7 and 8.

---

## 8. Open PR queue — `/bugmerge1` pass 2026-09-04

A `/bugmerge1` run on 2026-09-04 drained the review-clean half of the queue:
**#95, #93, #98, #102 merged** (CodeRabbit comments addressed, rebased
conflict-free). Two PRs could not be finished automatically and need a human to
nudge the review bot, then re-run `/bugmerge1` (or `/bugz`) on them:

- [x] ~~**PR #97** (`feat/moo-council-simulation`)~~ — **merged 2026-09-04.** — CodeRabbit has **never
      completed a review**: the initial pass hit "Review limit reached" and a
      manual `@coderabbitai review` on 2026-09-04 01:43 UTC came back
      *"Review rate limited."* Wait out the CodeRabbit capacity window (check
      <https://app.coderabbit.ai/dashboard/review-capacity>), re-post
      `@coderabbitai review`, then triage/fix/merge. Touches real code
      (`lib/openrouter.ts`, `app/api/council/*`, `app/page.tsx`) so it should
      not be merged without a review.
- [x] ~~**PR #101** (`feat/signal-engine-phases-1-3`)~~ — **merged 2026-09-04.** — same situation
      (rate-limited 2026-09-04 01:43 UTC, no review ever completed). Also shows
      `mergeable: CONFLICTING` against `main` — it will need a `/reb` rebase
      before it can merge. Touches `lib/shared/*.ts`, pipeline route, tests.
- [x] ~~**`gh label create pipeline-failure`**~~ — exists (2026-09-14). ~~every scheduled pipeline
      workflow's `notify` job does `gh issue create --label pipeline-failure`
      against a label that doesn't exist, so the notify job itself fails. One
      command: `gh label create pipeline-failure --color B60205 --description
      "Scheduled pipeline run failed"`. Full context in
      [docs/pipeline-route-status-issues.md](pipeline-route-status-issues.md)
      (Issue 4).

---

## 9. `PRODUCTION_DB_HOST` — arm the live-pipeline-run guard

Code shipped on `feat/pipeline-local-runs-fixes` (`lib/pipeline-db-guard.ts` +
an inline mirror in `scripts/local-trigger.mjs`): a live pipeline run
(`local-trigger.mjs --no-dry-run`, or a nulogdash trigger button once §2 of
[admin-console-todo.md](admin-console-todo.md) lands) is refused when
`DATABASE_URL` resolves to the host in `PRODUCTION_DB_HOST`. **The guard is
inert until a human sets that variable** — it only warns.

- [ ] Confirm `.env.local`'s `DATABASE_URL` points at a **dev** Neon branch,
      not production (Neon console → Branches → compare the host in the string).
- [ ] Set `PRODUCTION_DB_HOST` to the **production** branch host (host only,
      e.g. `ep-...-pooler.<region>.aws.neon.tech`) in:
      - `.env.local` (guards local `--no-dry-run`)
      - the Vercel project env (guards the dashboard trigger buttons on deploy)
- [ ] Verify: with it set to the local DB's own host,
      `node scripts/local-trigger.mjs C track-followed-tickers --local --no-dry-run --yes`
      exits non-zero with "refused" and sends no request. Then set it to the
      real prod host and confirm dev `--no-dry-run` still works.

Name the variable, never paste a host value into chat or a committed file
other than `.env.local` / the Vercel dashboard.

---

- [ ] **The shared Clerk e2e test account's watchlist has accumulated stale
      rows across CI runs, and `e2e/frontend/portfolio-liveness.spec.ts`'s
      `beforeEach` doesn't account for it.**
      - **From**: `/wait-merge1` run on PR #123 — `[frontend]` shard failed with
        `locator('.port-watch-item') resolved to 2 elements` (then 3 on retry)
        when the test tries to add AAPL and assert exactly one watch item is
        visible; MSFT and NVDA were already present from earlier runs
      - **Blocked on**: this is a code fix, not a login/secret — flagged here
        rather than fixed inline because it's pre-existing test-isolation debt
        entirely untouched by PR #123's own diff (confirmed: the PR's only
        hunk in this file is inside the test body at line 37+, not the
        `beforeEach` at lines 27–35), so fixing it doesn't belong to that PR's
        scope. Either scope the locator to the specific ticker just added
        (`getByText(/AAPL/)`) instead of the generic class selector, or clear
        the test account's watchlist in `beforeEach`/`afterEach`.
      - **Why it can't be code (right now)**: it *is* code — this line exists
        to route the finding somewhere durable rather than let it evaporate
        after the run that found it, per this file's own convention for any
        finding that isn't the current task's job to fix
      - **Unblocks**: `portfolio-liveness.spec.ts`'s first test becoming
        reliably green instead of intermittently red depending on how much
        prior-run state has accumulated in the shared account
      - **Added**: 2026-09-12
- [ ] **`e2e/frontend/signal-timing.spec.ts` throws instead of skipping when
      `/api/signals/digest` returns an HTML error page.**
      - **From**: `/wait-merge1` run on PR #123 — same `[frontend]` shard,
        second failure: `SyntaxError: Unexpected token '<', "<!DOCTYPE "...
        is not valid JSON` at line 46, calling `.json()` on a response the
        preceding line's `test.skip(!digestRes || !digestRes.ok(), …)` should
        have already routed around
      - **Blocked on**: unrelated to PR #123 (file not in its diff) and to
        portfolio work generally — a test-robustness gap where `.ok()` isn't
        sufficient to guarantee a JSON body (e.g. a 200 that's actually an
        HTML error page, or a redirect Playwright's `.ok()` follows)
      - **Why it can't be code (right now)**: same reasoning as the item above
      - **Unblocks**: `signal-timing.spec.ts` degrading to a clean skip instead
        of a hard failure when the digest endpoint is unhealthy
      - **Added**: 2026-09-12

## Suggested order

**One Stripe dashboard session covers three items** — the webhook secret, the
annual price, and the key rotation (§4). Do them together rather than three
separate logins.

0. ~~**Push the three hydration secrets** (§0a)~~ — **done 2026-09-13, verified
   green 2026-09-14.** ~~5 minutes, no dashboard, no decision.~~ It is the cheapest item in this file and the only one where the
   product is currently producing nothing at all. Every signal the app shows is
   15 days stale until this runs.
1. **Stripe: webhook secret + annual price** (§4) — until these are set you
   cannot record a payment, and you are advertising a plan you cannot sell.
   Everything else assumes revenue works.
2. ~~**Neon API key + project ID** (§1)~~ — **done 2026-08-30.** Re-run the
   integration job and read the current failure, if any.
3. **Rotate `STRIPE_SECRET_KEY`** (§4) — do this *before* step 4 so the synced
   value is the rotated one; same dashboard session as step 1.
4. ~~**Push the remaining existing secrets** (§2)~~ — **done 2026-09-14**; the
   absent list is empty apart from the two obsolete GCP values.
5. **Clerk Production** (§3) — the live production bug.
6. **Decide the explain-quality path** (§6b) — the AI tier currently produces
   nothing; this gates whether the paid feature exists at all.
7. **Error monitoring + uptime check** (§5c) — cheap, and until then an outage
   is detected by customer email.
8. ~~**GCP WIF**~~ (obsolete, §-1) **+ re-run the frontend tier** (§5b) — turns the e2e suite from
   decorative back into a gate.
9. **LLM provider terms** (§6) — the biggest unexamined legal risk here.
10. Everything else.

---

## Added 2026-09-11 — surfaced by the `/nulogdash` sweep

These are the only two reasons any feature is still `blocked` after the sweep was
fixed to authenticate (see
`docs/wiki-portal/incident-2026-09-11-nulogdash-blind-sweep.md`). Neither can be
resolved in code.

### Set a **test-mode** Stripe secret key for local/sweep use

- **From**: `/nulogdash` sweep, 2026-09-11
- **Blocked on**: a `sk_test_...` key from the Stripe dashboard (test mode),
  plus the matching test-mode `STRIPE_PRICE_MONTHLY` / `STRIPE_PRICE_ANNUAL`
  price ids.
- **Why it can't be code**: only the Stripe dashboard can issue the key and the
  test-mode prices.
- **Why it matters more than it looks**: `.env.local` currently holds a
  **`sk_live_`** key, and the sweep `POST`s `/api/stripe/checkout` and
  `/api/stripe/portal`. Those create a real Checkout Session and — via the
  portal's lazy-provisioning path — a real **Customer**, on the live account,
  on every run. The sweep now refuses to run billing features against a live
  key at all (fail-closed `blocked`), so nothing is being created any more; the
  key is what turns three features back on.
- **Unblocks**: `stripe-checkout`, `stripe-portal`, `stripe-subscription` —
  3 of the 4 remaining blocked features.
- **Added**: 2026-09-11

### Set `MCP_ANALYZE_URL` (or decide the route is retired)

- **From**: `/nulogdash` sweep, 2026-09-11
- **Blocked on**: the deployed Cloud Run URL for `holdemfoldem-api`, which is
  not discoverable from this repo (the sibling repo's README carries only a
  placeholder, and the active `gcloud` project does not host the service).
- **Why it can't be code**: the value is an external deployment's hostname.
  `docs/wiki-portal/decision-second-analyze-backend.md` also records that being
  unset is *deliberate* in production — so the real decision may be "retire the
  route", not "set the var".
- **Unblocks**: `analyze` — the last remaining blocked feature. Until then it
  correctly reports `blocked` on an unmet dependency rather than failing.
- **Added**: 2026-09-11

## Added 2026-09-13 — Phase 3 of the paper-portfolio council simulation

### Run the seed script for real, and set `PAPER_CRON_SECRET`

- **From**: `docs/paper-portfolios-remaining-todo.md` Phase 3, PR (this branch).
- **Blocked on**: two independent things, both needed before
  `/api/pipeline/paper-portfolios` can be exercised end-to-end:
  1. `scripts/seed-paper-portfolios.mjs` (Phase 2, PR #127) has only ever been
     dry-run/validated in a session, never actually written against a real
     Neon branch — someone with a non-prod `DATABASE_URL` needs to run it for
     real so `paper_accounts` / `paper_watchlists` have rows.
  2. A `PAPER_CRON_SECRET` value, via the `secrets-sync` skill (never typed
     into chat) — deliberately a secret independent of `CRON_SECRET`, since
     this route writes paper-capital state across all eight accounts.
- **Why it can't be code**: seeding is a deliberate one-time manual act (the
  script refuses to double-run without `--force-reseed`, by design — §2.1's
  watchlist-versioning guarantee depends on seeding never happening silently),
  and a secret value can't be generated by an agent that isn't supposed to
  print or invent one.
- **Unblocks**: any real (non-dry-run, non-unit-test) exercise of the Phase 3
  engine — `POST /api/pipeline/paper-portfolios?slot=preopen` today 401s with
  no `PAPER_CRON_SECRET` set, and even authenticated would find zero
  `paper_accounts` rows until seeding actually runs.
- **Added**: 2026-09-13

## Added 2026-09-14 — Phase 4 of the paper-portfolio council simulation

### Push `PAPER_CRON_SECRET` to GitHub Actions once it exists

- **From**: `docs/paper-portfolios-remaining-todo.md` Phase 4,
  `feat/paper-portfolios-phase-4-cron` (this branch).
- **Blocked on**: the `PAPER_CRON_SECRET` value from the 2026-09-13 entry
  above existing at all — this is a third, independent step, not a
  duplicate. Once it's generated and in `.env.local`/Vercel:
  `gh secret set PAPER_CRON_SECRET` (pipe from the file, never paste the
  value into a command or chat).
- **Why it can't be code**: `.github/workflows/paper-portfolios.yml`'s
  "Verify required secrets exist" step calls `gh secret list` against the
  live repo — nothing in this branch's diff can populate a GitHub Actions
  secret store.
- **Unblocks**: every one of the 4 daily scheduled slots
  (`preopen`/`midday`/`preclose`/`settle`) — until this is set, every
  scheduled run fails at the secret-check step before ever calling the
  route, and files a `pipeline-failure` issue.
- **Added**: 2026-09-14

## Added 2026-09-15 — `e2e-resiliency.yml`'s `signals-liveness` shard has been red on `main` since 2026-09-13

- **From**: `/wait-merge1` triage of PR #137's `e2e (4)` failure —
  `e2e/frontend/signals-liveness.spec.ts:53`'s `POST /api/signals/{ticker}/chat`
  liveness check times out (`TimeoutError: apiRequestContext.post: Timeout
  25000ms exceeded`) against several tickers.
- **Blocked on**: whichever upstream this route's proxy calls through
  (gcp3-backend and/or the OpenRouter chain) — `gh run list --branch main
  --workflow e2e-resiliency.yml --limit 5` shows **failure on all 5 of the
  last 5 runs on `main` itself**, going back to 2026-09-13, before PR #137
  existed. Not this PR's regression.
- **Why it can't be code (right now)**: nobody has yet identified which
  upstream call times out or why — this entry only confirms the failure
  predates and is independent of the PRs it's currently blocking, so the
  next session doesn't re-diagnose "is this my PR's fault" from scratch. The
  actual root cause is still open work.
- **Unblocks**: knowing to merge past this specific `e2e (4)` failure on any
  PR that doesn't touch `/api/signals/*` or its proxy chain, without
  re-verifying it's pre-existing each time.
- **Added**: 2026-09-15

## Added 2026-09-15 — Phases 5 and 6 of the paper-portfolio council simulation

### Confirm `OPENROUTER_API_KEY` is set wherever the paper-portfolios route runs

- **From**: `docs/paper-portfolios-remaining-todo.md` Phase 5,
  `feat/paper-portfolios-phase-5-6-arbitration-firestore`.
- **Blocked on**: nothing new to generate — this key already exists and backs
  every other council seat call (`app/api/council/route.ts` reads the same
  var). The action here is confirming it's present in whichever environment
  actually runs the cron (production Vercel env, or GitHub Actions if the
  workflow ever calls the route with it directly rather than relying on the
  deployed environment).
- **Why it can't be code**: a missing key degrades silently by design —
  `runAccountSlot` treats `options.apiKey` being empty as "skip arbitration
  entirely," per guardrail #4 ("a run that would exceed its cap degrades to
  deterministic-only rather than failing"), extended here to "missing
  entirely" as the same class of degrade. Nothing will error or page; every
  order will simply read `decided_by: 'rule'` forever.
  Confirming the key's presence is a one-line environment check, not a code
  change — but it can't be verified from this session (the key must never be
  printed, and this session cannot read the deployed environment).
- **Unblocks**: seats behaving distinctly from QUANT — the actual point of
  Phase 5 (`docs/council-paper-portfolios.md` §10, Phase 5 row: "the seats
  become distinct from QUANT"). Without it, Phase 5's code ships but the
  eight accounts trade identically to how Phase 3 left them.
- **Added**: 2026-09-15

### Provision `FIRESTORE_SERVICE_ACCOUNT_JSON`

- **From**: `docs/paper-portfolios-remaining-todo.md` Phase 6, same branch.
- **Blocked on**: a Firebase service-account JSON key for the `gcp3` Firebase
  project (the one `gcp3-mobile` already reads), via the `secrets-sync` skill
  — never typed into chat, never committed. Firebase console → Project
  settings → Service accounts → Generate new private key.
- **Why it can't be code**: it's a credential this session cannot generate or
  fetch. `lib/firestore-admin.ts` reads it from
  `process.env.FIRESTORE_SERVICE_ACCOUNT_JSON` as a JSON string (the whole
  key file's contents, not a path) and warns once (not per call) when absent.
- **Unblocks**: `lib/paper-firestore-mirror.ts` and `lib/paper-reconcile.ts`
  — until this is set, every mirror/reconcile call returns
  `{ ok: false, error: "not_configured" }` (recorded into
  `paper_runs.detail.mirror_error` / `.reconcile`, never failing the run
  itself), and the mobile app has nothing to read from `paper/*` in
  Firestore regardless of how many runs execute against Neon.
- **Added**: 2026-09-15
