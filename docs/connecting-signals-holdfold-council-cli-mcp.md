# Connecting to Signals, Hold Em / Fold Em, and the AI Council — CLI + MCP

A single reference for driving all three NuWrrrld backends from a terminal (CLI)
or from an LLM agent (MCP). Each section covers: what the service is, where its
code lives, how to reach it over a CLI, and how to reach it over MCP.

| Service | Repo | Language | Local port | CLI surface | MCP surface |
|---|---|---|---|---|---|
| **Signals app** | `~/code/signals-app` | Python 3.12 / FastAPI | `:8000` | `scripts/analyze.py`, `scripts/scan_universe.py`, `signals-analyze` entrypoint | none yet — wrap the HTTP API (§1.4) |
| **Hold Em / Fold Em** | `~/code/holdemfoldemapp` | Python / FastAPI | `:8001` (dev) / `:8080` (Cloud Run) | `python -m cli` (`holdfold`) | `python -m mcp_server` (stdio) |
| **AI Council** | `~/code/nuwrrrld-portal` (`app/api/council/*`) | TypeScript / Next.js 16 | `:3000` | `curl` the routes, or `scripts/*.mjs` | none yet — wrap the HTTP routes (§3.4) |

> The Council is not a standalone service — it lives inside this portal. The
> other two are separate repos the portal proxies to (`app/api/holdfold`,
> `app/api/signals`, `app/api/analyze`).

---

## 0. One-time setup

### Python envs (mamba)

Never run `pip` outside a mamba env. Each Python service pins its own:

```bash
# Signals app
mamba run -n signals-app python -c "import signals_app; print('ok')"

# Hold Em / Fold Em — in-process engine needs the finance env + sibling repo
mamba activate fin-ai1        # per holdemfoldemapp/README.md
```

If `fin-ai1` (or the sibling `gcp-app-w-mcp1/mcp-finance1` checkout) is missing,
the Hold Em / Fold Em CLI automatically falls back to HTTP — see §2.2.

### Node (Council / portal)

```bash
cd ~/code/nuwrrrld-portal
npm install
cp .env.example .env.local   # fill OPENROUTER_API_KEY, DATABASE_URL, Clerk keys
npm run dev                   # portal on :3000
```

---

## 1. Signals app

### 1.1 What it is

L1–L5 financial signal pipeline: fetch OHLCV (yfinance / Finnhub) → compute
indicators → detect signals → confluence score → optional LLM synthesis
(Gemini). Persists to Supabase / SQLite.

### 1.2 CLI — single ticker

```bash
cd ~/code/signals-app

# Full pipeline incl. LLM synthesis, pretty JSON to stdout
mamba run -n signals-app python scripts/analyze.py AAPL

# Score only, no LLM call
mamba run -n signals-app python scripts/analyze.py AAPL --timeframe 1d --no-llm

# Longer lookback, write result to a file
mamba run -n signals-app python scripts/analyze.py AAPL \
  --period 6mo --no-llm --output ./output/aapl.json
```

Flags: `--timeframe` (default `1d`), `--period` (must be in `VALID_PERIODS` —
`1mo 3mo 6mo 1y 2y 5y ytd max` …), `--no-llm`, `--output PATH`.

### 1.3 CLI — universe scans

```bash
# Whole configured universe
mamba run -n signals-app python scripts/scan_universe.py

# Themed / windowed scans
mamba run -n signals-app python scripts/scan_bullish_2wk.py
mamba run -n signals-app python scripts/scan_optimal_monthly.py
mamba run -n signals-app python scripts/scan_21_day_ds.py

# Human-readable report from the last scan
mamba run -n signals-app python scripts/generate_signal_report.py
```

### 1.4 HTTP API (and the MCP path)

There is **no MCP server for signals-app yet**. The API is the integration
point:

```bash
# Start it
bash ~/code/signals-app/scripts/run_local.sh          # uvicorn on :8000
# Docs: http://localhost:8000/docs

# Or via the installed entrypoint (reads PORT env)
mamba run -n signals-app signals-analyze
```

```bash
curl -s http://localhost:8000/analyze \
  -H 'content-type: application/json' \
  -d '{"symbol":"AAPL","timeframe":"1d","period":"3mo","use_llm":false}' | jq
```

**To expose it over MCP**, copy the low-level `mcp.server.Server` (stdio)
pattern from Hold Em / Fold Em's [`backend/mcp_server/server.py`](../../holdemfoldemapp/backend/mcp_server/server.py)
— one `Tool` (`analyze_security`) whose handler `httpx.post`s to
`http://localhost:8000/analyze`. Keep the scoring logic in the API process;
the MCP server is a thin wrapper. See §2.4 for the shape to mirror.

### 1.5 From the portal

`app/api/signals/*` and `app/api/analyze/route.ts` proxy to the deployed MCP
finance backend (`MCP_BACKEND_URL`, default
`https://gcp3-backend-...-uc.a.run.app`), **not** to a local signals-app. To
point the portal at your local run, set `MCP_BACKEND_URL=http://localhost:8000`
in `.env.local` (field names differ — check the route).

---

## 2. Hold Em / Fold Em

### 2.1 What it is

Instant **HOLD EM / FOLD EM / NEUTRAL** verdict for any US stock, ETF, or
options position. `_build_verdict()` in
[`backend/main.py`](../../holdemfoldemapp/backend/main.py) is the ~300-line core
— 150+ technical signals, suppressions, multi-lot P&L, Fibonacci confluence,
options payoff math. **The CLI and MCP server both call it; neither
reimplements it.** Full design rationale:
[`holdemfoldemapp/docs/cli-and-mcp-guide.md`](../../holdemfoldemapp/docs/cli-and-mcp-guide.md).

### 2.2 CLI

Hybrid transport: tries the in-process engine (`core.compute_verdict`) first,
falls back to a running backend's HTTP API when `core.py` can't import (missing
`fin-ai1` env / sibling `mcp-finance1` repo) or when `--remote` is passed.

```bash
cd ~/code/holdemfoldemapp/backend

# Simplest — verdict for a ticker
python -m cli AAPL

# The installed name is `holdfold`
holdfold SPY --period 6mo --risk-profile aggressive

# Force the HTTP path against a running backend
HOLDFOLD_BACKEND_URL=http://localhost:8001 python -m cli AAPL --remote

# Multi-lot P&L:  --lot qty@cost[@YYYY-MM-DD]  (repeatable)
python -m cli AAPL --lot 100@85.50@2024-03-01 --lot 50@110.00

# Options:  --leg role:strike[:expiry]  (repeatable)
python -m cli SPY --strategy call_credit_spread \
  --leg sell_call:460 --leg buy_call:470 --dte 30 --net-premium 1.85
```

**Exit codes** (scriptable): `0` HOLD EM · `1` FOLD EM · `2` NEUTRAL ·
`3` error.

```bash
if holdfold AAPL >/dev/null; then echo "hold"; else echo "not a hold ($?)"; fi
```

Key flags: `--period` (`VALID_PERIODS`), `--asset-type` (`stock`|`etf`|`option`),
`--risk-profile` (`conservative`|`moderate`|`aggressive`), `--strategy`,
`--dte`, `--net-premium` (**+ = credit, − = debit**),
`--cost-basis-method` (`fifo`|`lifo`|`average`|`specific`), `--json`,
`--remote`.

### 2.3 Run the backend (needed for `--remote` and for MCP)

```bash
# Local dev — port 8001
cd ~/code/holdemfoldemapp
mamba activate fin-ai1
python backend/main.py            # or: uvicorn backend.main:app --port 8001

curl -s http://localhost:8001/health | jq
curl -s http://localhost:8001/api/analyze \
  -H 'content-type: application/json' \
  -d '{"symbol":"AAPL","period":"3mo","risk_profile":"moderate"}' | jq
```

### 2.4 MCP server

Stdio MCP server wrapping `POST /api/analyze` over HTTP (so the verdict logic
stays in one process — it does **not** import `core.py`, which would duplicate
the Firestore client and an `os.chdir()` import-time side effect).

```bash
cd ~/code/holdemfoldemapp/backend
export HOLDFOLD_BACKEND_URL=http://localhost:8001   # default; set to Cloud Run URL for prod
python -m mcp_server
```

**Tools exposed:**

| Tool | Purpose | Required args |
|---|---|---|
| `get_verdict` | HOLD/FOLD/NEUTRAL for a stock or ETF, with 150+ signals + trade plan; optional held tax lots for P&L / aging | `symbol` |
| `evaluate_options_strategy` | Multi-leg payoff curve, max P/L, breakevens, PoP, Greeks | `symbol`, `options_strategy` |
| `check_health` | Backend + Firestore cache reachability | — |

`get_verdict` optional args: `period` (default `3mo`), `risk_profile`
(`moderate`), `position_lots` (`[{qty, cost_basis, acquired_at?, side?}]`),
`cost_basis_method` (`average`).

**Register with Claude Code / Claude Desktop** (`claude_desktop_config.json` or
`.mcp.json`):

```jsonc
{
  "mcpServers": {
    "holdfold": {
      "command": "python",
      "args": ["-m", "mcp_server"],
      "cwd": "/Users/adamaslan/code/holdemfoldemapp/backend",
      "env": {
        "HOLDFOLD_BACKEND_URL": "http://localhost:8001",
        "MAMBA_ROOT_PREFIX": "/opt/homebrew/Caskroom/miniforge/base"
      }
    }
  }
}
```

If `python` on `PATH` isn't the `fin-ai1` interpreter, use an absolute path:
`/opt/homebrew/Caskroom/miniforge/base/envs/fin-ai1/bin/python`.

Quick smoke test without a client:

```bash
cd ~/code/holdemfoldemapp/backend
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | python -m mcp_server
```

### 2.5 From the portal

`app/api/holdfold/route.ts` maps the deployed MCP finance signals
(`MCP_BACKEND_URL/signals`) into a `HoldFoldPayload` via
`lib/shared/holdfold-map.ts`, with an L1 in-process cache + a durable Neon
cache. It does **not** call the Hold Em / Fold Em Python backend directly.

---

## 3. AI Council

### 3.1 What it is

A multi-seat LLM debate (not a single-shot answer), running on **free-tier
OpenRouter models only**. Lives entirely in the portal:

| Route | Auth | What it does |
|---|---|---|
| `POST /api/council/deliberate` | Clerk + entitlement + daily quota | Full 5-stage debate: ground → round 1 (parallel seats) → round 2 (diff-shaped critique of who disagrees) → synthesis (CHAIR prose + 3× majority-vote verdict) → persist to Neon |
| `POST /api/council/public` | none (ticker-only input) | One RISK-seat take, 1/day/IP quota, cache-hit is free. Prompt built entirely server-side (no free-text from anon callers) |
| `GET /api/council/sample` | none | Cached SPY short-term + long-term pair for the landing page; refreshes every 6 h |

Core libs: `lib/openrouter.ts` (`DEBATE_SEATS`, `runSeat`, `callCouncilSeat`),
`lib/council-grounding.ts`, `lib/council-critique.ts`, `lib/council-verdict.ts`,
`lib/council-db.ts`. Design notes: `docs/council-prompting-small-models.md`.

### 3.2 CLI (via `curl` against a running portal)

```bash
cd ~/code/nuwrrrld-portal && npm run dev    # :3000

# Public demo — no auth, ticker only
curl -s http://localhost:3000/api/council/public \
  -H 'content-type: application/json' \
  -d '{"ticker":"AAPL"}' | jq

# Landing-page sample — no auth
curl -s http://localhost:3000/api/council/sample | jq

# Full deliberation — needs a Clerk session cookie + entitlement
curl -s http://localhost:3000/api/council/deliberate \
  -H 'content-type: application/json' \
  -H "cookie: __session=<clerk_session_jwt>" \
  -d '{"ticker":"AAPL"}' | jq
```

Get a `__session` JWT from browser DevTools (Application → Cookies on
`localhost:3000`) while signed in, or use the Clerk CLI
(`clerk` — see the `clerk-cli` skill) to mint a testing token.

### 3.3 Helper scripts

```bash
cd ~/code/nuwrrrld-portal
node scripts/refresh-free-models.mjs     # refresh the $0 OpenRouter model chain
node scripts/nulogdash.mjs               # feature-level end-to-end sweep (incl. council)
```

### 3.4 MCP

No MCP server exists for the Council. To build one, wrap the HTTP routes with
the same stdio pattern as §2.4:

```
council-mcp (mcp.server.Server, stdio)
  Tool: ask_council   → POST http://localhost:3000/api/council/public {ticker}
  Tool: council_sample → GET  http://localhost:3000/api/council/sample
  (deliberate needs a Clerk session — pass the JWT via an env var, or leave it
   out of the MCP surface and keep MCP to the unauthenticated routes)
```

Put it in a new `nuwrrrld-portal/mcp/` dir or a sibling `council-mcp/` repo.
Node implementation: `@modelcontextprotocol/sdk` `Server` + `StdioServerTransport`.
Keep every tool a thin `fetch` to an existing route — no LLM calls in the MCP
process itself.

---

## 4. Wiring all three into one agent

A Claude Code `.mcp.json` once the wrappers exist:

```jsonc
{
  "mcpServers": {
    "holdfold": {
      "command": "python", "args": ["-m", "mcp_server"],
      "cwd": "/Users/adamaslan/code/holdemfoldemapp/backend",
      "env": { "HOLDFOLD_BACKEND_URL": "http://localhost:8001" }
    },
    "signals": {
      "command": "python", "args": ["-m", "mcp_server"],
      "cwd": "/Users/adamaslan/code/signals-app",
      "env": { "SIGNALS_API_URL": "http://localhost:8000" }
    },
    "council": {
      "command": "node", "args": ["mcp/council-server.mjs"],
      "cwd": "/Users/adamaslan/code/nuwrrrld-portal",
      "env": { "PORTAL_URL": "http://localhost:3000" }
    }
  }
}
```

Startup order for a full local stack:

```bash
# 1. Finance signals API (feeds Hold Em / Fold Em)
bash ~/code/signals-app/scripts/run_local.sh                 # :8000

# 2. Hold Em / Fold Em backend
cd ~/code/holdemfoldemapp && mamba activate fin-ai1 && python backend/main.py   # :8001

# 3. Portal (hosts the Council)
cd ~/code/nuwrrrld-portal && npm run dev                     # :3000

# 4. MCP servers are launched by the MCP client (Claude), not by hand
```

---

## 5. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `holdfold` prints "in-process engine unavailable" then works anyway | `fin-ai1` env or `mcp-finance1` sibling missing | expected — it fell back to HTTP; start `backend/main.py` or pass `--remote` |
| `AI Council unreachable` / `ECONNREFUSED :3000` | portal not running | `npm run dev` in `nuwrrrld-portal` |
| `/api/council/deliberate` → 401 | no Clerk session cookie | sign in, copy `__session` cookie, or use a Clerk testing token |
| `/api/council/public` → 429 | 1/day/IP quota spent on a cache miss | wait, or ask about a ticker already cached today (free) |
| `/api/council/*` → 503 "Demo not configured" | `OPENROUTER_API_KEY` / `IP_HASH_SECRET` unset | fill `.env.local` |
| MCP server: `ModuleNotFoundError: mcp` | wrong Python | point the MCP config `command` at the env's absolute `python` |
| signals `python scripts/analyze.py` → import errors | ran outside mamba | prefix with `mamba run -n signals-app` |

---

## 6. Source map

- Hold Em / Fold Em CLI: `holdemfoldemapp/backend/cli/{app,client,render}.py`
- Hold Em / Fold Em MCP: `holdemfoldemapp/backend/mcp_server/server.py`
- Hold Em / Fold Em design doc: `holdemfoldemapp/docs/cli-and-mcp-guide.md`
- Council ↔ Hold Em / Fold Em integration precedent:
  `holdemfoldemapp/docs/ai-council-integration.md`
- Signals CLI: `signals-app/scripts/{analyze,scan_universe,generate_signal_report}.py`
- Signals API: `signals-app/src/signals_app/api/main.py`
- Council routes: `nuwrrrld-portal/app/api/council/{deliberate,public,sample}/route.ts`
- Council libs: `nuwrrrld-portal/lib/council-*.ts`, `lib/openrouter.ts`
- Portal proxies: `nuwrrrld-portal/app/api/{holdfold,signals,analyze}/route.ts`
