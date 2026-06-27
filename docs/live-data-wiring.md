# Live Data Wiring — Kill the "Wiring up" / stale UI

**Goal:** Replace every hardcoded "Wiring up" / mockup surface on `financial.nuwrrrld.com` with live data from the deployed backend. The backend is already serving real data — the frontend just isn't reading it on these pages.

**Created:** 2026-06-27
**Status of [homebase/fullstack-hydration.md](../../homebase/fullstack-hydration.md):** *partially* implemented. This doc is the remaining work, grounded in the actual current code.

**Backend (ground truth):** `https://gcp3-backend-cif7ppahzq-uc.a.run.app` — GET endpoints are **public** (no auth header). Verified live: `/signals` (54 symbols), `/market-overview` (live SPY/QQQ/IWM/DIA).

---

## Dashboard nav vs. pages — connection audit

The dashboard nav links to 6 destinations. Here's the full coverage map:

| Nav link | Route | Page exists? | In tool grid? | Notes |
|---|---|---|---|---|
| Signals | `/dashboard/signals` | ✅ | ✅ | stale — dead endpoint (see below) |
| Hold/Fold | `/dashboard/holdfold` | ✅ | ✅ | live — the one working surface |
| Nu AI | `/dashboard/nuai` | ✅ | ✅ | uses Anthropic SDK directly; OpenRouter not wired |
| Share | `/dashboard/share` | ✅ | ✅ | static referral link page |
| Billing | `/dashboard/billing` | ✅ | ❌ nav only | no tool card, only top nav + checkout redirect |
| Founders | `/dashboard/beta` | ✅ | ❌ nav only | no tool card, nav-only |

**Orphaned pages** (exist as routes but have zero links from the dashboard):

| Route | What it is | Problem |
|---|---|---|
| `/dashboard/upgrade` | Annual plan upsell page | no link from dashboard, nav, or tool grid — only reachable if you know the URL |
| `/signals` | Public marketing landing for signals | nav links to `/dashboard/signals` for logged-in users; the public `/signals` has no live data (static copy) |
| `/portfolio-intelligence` | Public marketing landing | **zero links anywhere in the app** — completely orphaned |
| `/ai-assistant` | Public marketing landing | **zero links anywhere in the app** — completely orphaned |
| `/launch` | One-time launch page | nav links absent; was intended as a time-boxed page; `robots: { index: false }` set |

**Dashboard tool grid gaps** — the grid shows 4 cards (Signal Digest, Nu AI, Hold/Fold, Share & Earn) but is missing:

- No **Market Briefing / macro overview** card (the `/market-overview` endpoint is unused on dashboard)
- No **Portfolio Intelligence** card (the feature page `/portfolio-intelligence` is orphaned)
- No **Billing** card (billing is nav-only; Pro users have no quick-jump from the grid)

**Recommended dashboard navigation fixes (separate from live-data wiring):**

1. Add a Billing card to the tool grid for Pro users (or at minimum a quick link below the upgrade banner).
2. Add `/dashboard/upgrade` link — currently invisible; wire it from the upgrade banner or billing page.
3. Wire `/portfolio-intelligence` and `/ai-assistant` into the main nav or landing page — they have no inbound links.
4. Decide fate of `/launch` — either add to nav or redirect to landing.

---

## What's already done (don't redo)

- ✅ **Hold/Fold** — [app/dashboard/holdfold/page.tsx](../app/dashboard/holdfold/page.tsx) + [app/api/holdfold/route.ts](../app/api/holdfold/route.ts) already fetch live `/signals` with a 15‑min `revalidate` cache and a `parseHoldFoldPayload` adapter. **This is the reference pattern — copy its shape.**
- ✅ **OpenRouter** — [lib/openrouter.ts](../lib/openrouter.ts) exists.

## What is still stale (the "Wiring up" you see)

| Surface | Current code | Problem |
|---|---|---|
| `/dashboard/signals` | [app/dashboard/signals/page.tsx:31-32](../app/dashboard/signals/page.tsx#L31-L32) | hits dead `/api/signals/digest` + `/digest/v2` → `null` → "No signals available yet" |
| `/api/signals/digest` route | [app/api/signals/digest/route.ts:52-53](../app/api/signals/digest/route.ts#L52-L53) | same dead endpoints |
| `lib/digest.ts` | — | no `adaptLiveSignals` adapter (`/signals` is a `symbols{}` map, `normaliseDigest` wants a `signals[]` array) |
| Landing Market Briefing | [app/page.tsx:67-96](../app/page.tsx#L67-L96) | hardcoded `5,943.21`, `NVDA 91%`, fake council bubbles |
| Landing `#council` | [app/page.tsx:79-95](../app/page.tsx#L79-L95) | static `council-bubble` divs |
| `/dashboard` overview | [app/dashboard/page.tsx:63-90](../app/dashboard/page.tsx#L63-L90) | "Live" pills but no `/market-overview` fetch |
| `/api/retention/digest-email` | [app/api/retention/digest-email/route.ts:49](../app/api/retention/digest-email/route.ts#L49) | dead `/api/signals/digest` |

---

## Live `/signals` shape (what the adapter bridges)

```json
{
  "date": "2026-06-27",
  "updated": "2026-06-26T13:45:01.250351+00:00",
  "total": 54,
  "symbols": {
    "HACK": {
      "symbol": "HACK", "ai_action": "BUY", "ai_score": 1.0,
      "ai_confidence": "HIGH", "confluence_score": 1.0, "confluence_label": "HIGH",
      "change_pct": 1.7, "signal_count": 4, "bull_count": 4, "bear_count": 0,
      "ai_summary": "Cybersecurity — 1d +1.70%, 1m +17.3%, 1y +10.8%",
      "ai_outlook": "Confluence score +1.00 (HIGH): 4 of 4 signals are bullish...",
      "signals": [{ "signal": "...", "detail": "...", "strength": "BULLISH" }]
    }
  }
}
```

Mismatch to bridge → [lib/digest.ts](../lib/digest.ts) `DigestPayload`:
- live `symbols{}` **map** → `signals[]` **array**
- `ai_action: BUY|SELL|HOLD` → `direction: bullish|bearish|neutral`
- `ai_confidence: HIGH|MEDIUM|LOW` (uppercase) → `confidence: high|medium|low` (lowercase; `safeConfidence` validates)
- `ai_summary` → `title`, `ai_outlook` → `explanation`, `signals[].signal` → `indicators[]`

---

## Step 1 — [P0] Signals adapter (this alone fixes `/dashboard/signals`)

Add to [lib/digest.ts](../lib/digest.ts):

```ts
// Adapter: live GCP3 /signals (symbols map) → DigestPayload (signals array)
export function adaptLiveSignals(raw: unknown): DigestPayload | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const symbols = (r.symbols ?? {}) as Record<string, Record<string, unknown>>;
  const entries = Object.values(symbols);
  if (entries.length === 0) return null;

  const updated = String(r.updated ?? new Date().toISOString());
  const signals: SignalPayload[] = entries.map((s, i) => {
    const action = String(s.ai_action ?? "HOLD");
    return {
      id: String(s.symbol ?? `signal-${i}`),
      ticker: String(s.symbol ?? ""),
      direction:
        action === "BUY" ? "bullish" : action === "SELL" ? "bearish" : "neutral",
      timeframe: "medium",
      confidence: safeConfidence(String(s.ai_confidence ?? "low").toLowerCase()),
      title: String(s.ai_summary ?? ""),
      explanation: String(s.ai_outlook ?? ""),
      indicators: Array.isArray(s.signals)
        ? (s.signals as Array<Record<string, unknown>>).map((x) => String(x.signal))
        : [],
      generatedAt: updated,
    };
  });

  return {
    schemaVersion: DIGEST_SCHEMA_VERSION,
    periodLabel: `Signals for ${String(r.date ?? "")}`,
    signals,
    generatedAt: updated,
    sources: ["gcp3-signals"],
  };
}
```

> Confirm `SignalPayload` field names against the current [lib/digest.ts:26](../lib/digest.ts#L26) `interface` before pasting — match its exact keys (the holdfold adapter is a good cross-check for live field names).

## Step 2 — [P0] Repoint `/dashboard/signals`

In [app/dashboard/signals/page.tsx](../app/dashboard/signals/page.tsx), replace `fetchDigest` (lines 27‑51) with a single public `/signals` fetch — **no auth header** (GET is public; keep the Clerk + entitlement gate on the *page*, which already exists at lines 54‑63):

```ts
async function fetchDigest(): Promise<DigestPayload | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${MCP_URL}/signals`, {
      signal: controller.signal,
      next: { revalidate: 900 }, // 15-min server cache (matches holdfold)
    });
    if (!res.ok) return null;
    return adaptLiveSignals(await res.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
```

- Update the import on line 7: `import { adaptLiveSignals, type DigestPayload } from "@/lib/digest";`
- Update the call site (line 65‑66): `const digest = await fetchDigest();` (drop the `token`).
- The render block (lines 83‑110) needs **no change** — it already maps `digest.signals`.

## Step 3 — [P0] Repoint the API route + retention email

- [app/api/signals/digest/route.ts:52-53](../app/api/signals/digest/route.ts#L52-L53) → same `/signals` + `adaptLiveSignals` swap. Keep the existing `globalDigestCache` logic.
- [app/api/retention/digest-email/route.ts:49](../app/api/retention/digest-email/route.ts#L49) → `/signals` + `adaptLiveSignals`.

## Step 4 — [P0] Verify

```bash
curl -s https://gcp3-backend-cif7ppahzq-uc.a.run.app/signals | python3 -m json.tool | head
cd /Users/adamaslan/code/nuwrrrld-portal && npm run dev
# visit http://localhost:3000/dashboard/signals  → expect 54 real signals, not "No signals"
```
Use the `verify` or `run` skill to launch + screenshot.

---

## Step 5 — [P1] Dashboard overview cards → `/market-overview`

In [app/dashboard/page.tsx](../app/dashboard/page.tsx), the component is already `async`. Add a fetch and render real index levels in the tool grid (replace the static framing, not the nav):

```ts
const MCP_URL = process.env.MCP_BACKEND_URL ?? "https://gcp3-backend-cif7ppahzq-uc.a.run.app";

async function fetchMarketOverview() {
  try {
    const res = await fetch(`${MCP_URL}/market-overview`, { next: { revalidate: 900 } });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}
```
`brief.summary`, `brief.avg_change_pct`, and `brief.metrics_52w` (SPY/QQQ/IWM/DIA) are live. Render those instead of the hardcoded copy. Keep "Live" pill only when the fetch succeeds; otherwise show a neutral state (no fake numbers).

## Step 6 — [P1] Landing Market Briefing + Signal Feed → live (cached, public)

[app/page.tsx:64-97](../app/page.tsx#L64-L97) hardcodes `5,943.21`, `NVDA 91%`, etc. `app/page.tsx` can be a server component fetching public endpoints at build/ISR time:

- Market Briefing card → top of `/market-overview` (`brief.summary` + index moves).
- Signal Feed card (NVDA/MSFT/TSLA/XLE) → top 4 by `ai_score` from `/signals` (`adaptLiveSignals` then sort, or read the map directly).
- Wrap in `revalidate` (e.g. 1‑6h) so landing traffic doesn't hammer the backend.

## Step 7 — [P2] Landing AI Council → real cached sample

The `#council` bubbles ([app/page.tsx:79-95](../app/page.tsx#L79-L95)) are static. Plan:

1. New route `app/api/council/sample/route.ts`: `POST /agents/swing/run` + `POST /agents/growth/run` with a fixed demo ticker (e.g. `SPY`), poll `GET /agents/{swing|growth}/{run_id}` until done. Cache the pair ~6h.
2. Server-render two real council panels (short-term + long-term) with actual reasoning + data citations.
3. Decide council home: backend `/agents/*` = source of truth for grounded runs; OpenRouter ([lib/openrouter.ts](../lib/openrouter.ts)) powers free-form Nu AI chat only. **Don't duplicate the council in two places.**

---

## Execution order

1. **[P0]** Steps 1‑4 — adapter + repoint signals. *This kills the main "Wiring up" on `/dashboard/signals`.*
2. **[P1]** Step 5 — dashboard `/market-overview` cards.
3. **[P1]** Step 6 — landing Market Briefing + Signal Feed live.
4. **[P2]** Step 7 — landing council cached sample.

Each P0/P1 item is a small PR. If the change should also land in `gcp3-mobile`, use the `nuwrrrld-fullstack` skill to keep the shared `lib` adapter in sync.

## Open decisions

- **Auth on `/signals`:** public is fine for the marketing `/signals` page (market-wide, no PII). Keep the Clerk **entitlement** gate on `/dashboard/signals` page-level only; the upstream fetch stays token-free.
- **Council home:** backend `/agents/*` vs OpenRouter (rec: backend = truth, OpenRouter = chat seat).
- **Cache durability:** in-memory `globalDigestCache` is lost on cold start; Neon-backed cache is a later P2.
```
