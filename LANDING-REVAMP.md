# Landing Page Revamp — sell the product, not the architecture

Scope: `app/page.tsx` + `app/landing.css` (the **signed-out** landing only; signed-in
users `redirect("/dashboard")` on line 59). Goal: make a stranger want an account
in 8 seconds, and make the page shareable enough to spread on its own.

Everything below was verified against the live code and the live backend on
2026-07-24 — the diagnoses are not guesses.

---

## 0. Findings (what's actually wrong, verified)

### 0.1 The landing page is on a different design system than the app
`app/landing.css` declares its **own `:root`** and never consumes the app's tokens:

| | Landing (`landing.css`) | App (`globals.css`) |
|---|---|---|
| Background | `#08090c` → warm gradient to `#12100e` | `#06070d` (cold) |
| Text | `--ink: #f7f3ea` (warm cream) | `--text: #e8ecf4` (cool) |
| Accent | **`--green: #35d07f`**, `--amber` | `--neon-blue: #2fd8ff`, `--neon-red` |
| Glow | none | `--glow-blue`, `--glow-red` |

The new theme **has no green at all**. The landing's primary CTA is
`background: linear-gradient(135deg, var(--green), var(--amber))` (landing.css:68)
and `.nav-action` is solid `--green` (line 97/226). So the first thing a visitor
sees is off-brand relative to every screen behind the login.

**Fix:** delete the landing's local palette; consume `globals.css` tokens. Green
becomes `--neon-blue` (bull) / `--neon-red` (bear). One source of truth.

### 0.2 Market data: the endpoint is LIVE — our parser reads the wrong path
`curl /market-overview` → **200 in 1.8s**, real data (`SPY 738.93`). The panel still
says "Market data loading…" because of a **shape mismatch**:

```js
// app/page.tsx:121,125-126,134  — what we read
market?.indices?.SPY
market.indices[sym]           // sym = "QQQ" | "DIA" | "IWM"
```
```jsonc
// what the API actually returns
{ "brief": { "indices": {
    "S&P 500":     { "symbol": "SPY",  "price": 738.93, "change_pct": 0.1 },
    "Nasdaq 100":  { "symbol": "QQQ",  ... },
    "Russell 2000":{ "symbol": "IWM",  ... },
    "Dow Jones":   { "symbol": "DIA",  ... } } } }
```
There is **no top-level `.indices`**, and the keys are display names, not tickers.
`market.brief.summary` (line 129) is correct by luck — `brief.summary` exists.

**Fix:** read `market.brief.indices`, index by `.symbol` (build a
`Record<ticker, entry>` once), and keep the graceful fallback. ~10 lines.

### 0.3 …and market data shouldn't be the hero anyway
Per the brief: it isn't an important feature. A stale index quote is not why anyone
signs up — every finance site has one. **Demote it** from the centerpiece phone to a
thin ambient ticker strip, and give the hero to the thing nobody else has: **the
six-seat council arguing with itself.**

### 0.4 The language is too advanced (biggest conversion leak)
Actual copy on the page today:

> "signal matrices with data quality scores" · "macro regime reads" ·
> "138 signal outputs normalized into scored decisions" · "380+ data points
> compressed per symbol read" · "append-only proprietary dataset" ·
> "horizon-tagged council corpus and regime archive" · "McClellan"

This is spec-sheet language written for the person who *built* it. A visitor
doesn't know what a "regime score" or "confluence" is, and "138 signal outputs
normalized" describes **plumbing**, not benefit.

**Rewrite rule:** every headline states the *user's outcome*; jargon appears only
after the benefit lands, if at all. Translation table:

| Now | Instead |
|---|---|
| "The caring command center for active investors — live market briefings, macro regime reads, signal matrices…" | **"Should I buy it, or not?"** — Six AI analysts argue it out and give you a straight answer, with the exact price that proves them wrong. |
| "Regime score +0.42" | "Market mood: risk-on" |
| "138 signal outputs normalized into scored decisions" | "We check 138 things so you don't have to" |
| "Data quality score (0–1)" | "How much to trust this call" |
| "Names its invalidation point" | "Tells you exactly when it's wrong" |
| "Advanced AI-Native Financial Tools" (eyebrow + footer) | "Six AI analysts. One straight answer." |

### 0.5 Core features are described, never demonstrated or sold
The value props are buried in `<ul class="feature-list">` bullets below three
mock phones. The **council** — the actual moat — doesn't appear until section 3
(line 357), and its live sample only renders `{council?.shortTerm?.answer && …}`,
i.e. often not at all. The **RISK seat** (an AI that argues *against* your trade)
is the single most viral-feeling idea on the page and it's one card in a grid of six.

### 0.6 Weak auth CTAs
`Sign in` is a plain text link (`.nav-keep`); `Create account` is a flat green
rectangle. No hierarchy, no motion, no reassurance ("free", "no card"), and the
hero repeats "Create your account" twice with no differentiation.

### 0.7 Zero React libraries installed
`package.json` dependencies are exactly: `@anthropic-ai/sdk`, `@clerk/nextjs`,
`@neondatabase/serverless`, `next`, `react`, `react-dom`, `stripe`, `svix`.
No animation, no parallax, no icons. Every effect on the page today is hand-rolled CSS.

---

## 1. Libraries to add (small, Next-16/React-19 safe)

| Package | Why | Notes |
|---|---|---|
| `framer-motion` | scroll reveals, staggered council seats, spring CTAs | the workhorse; `"use client"` islands only |
| `lenis` | smooth scroll that makes parallax feel expensive | ~3 KB, no React dep |
| `react-intersection-observer` | fire counters/reveals on enter | tiny |
| `lucide-react` | consistent icon set (tree-shaken) | replaces ad-hoc glyphs |
| `motion-number` *(or hand-rolled)* | odometer roll on stat counters | optional |

Keep the page a **Server Component**; add `"use client"` only to the animated
islands (`<Hero3D/>`, `<CouncilDebate/>`, `<StatCounter/>`) so data fetching and
SEO stay server-rendered.

---

## 2. Parallax & motion plan

1. **Hero depth stack** (3 layers, mouse + scroll): neon haze blob (slowest) →
   council cards (mid) → headline + CTA (fastest, `y: 0`). Drives the "expensive" feel.
2. **Sticky scroll-through council**: pin the hero; as the user scrolls, each of
   the six seats slides in and speaks in turn (T1 → T2 → RISK → MACRO → QUANT →
   CHAIR verdict). This *demonstrates* the product instead of describing it.
3. **Ticker strip** drifting horizontally behind the fold at low opacity — where
   the demoted market data goes (§0.3).
4. **Counter reveals** for `6 seats / 138 checks / 380+ inputs` on enter.
5. **Magnetic CTA**: button nudges toward the cursor; subtle `--glow-blue` pulse.
6. `prefers-reduced-motion` → all of the above collapse to static. Non-negotiable;
   `globals.css:94` already establishes this guardrail for the neon theme.

---

## 3. Auth CTA redesign

- **Primary** "Start free →": `--neon-blue` fill, `--glow-blue` shadow, magnetic
  hover, spring press. Subtext under it: *"Free to start · no card required."*
- **Secondary** "Sign in": bordered ghost button (not a bare link), `--neon-blue`
  border on hover.
- Sticky mini-CTA appears in the navbar after the hero scrolls past.
- Social proof adjacent: "Join N investors" / "Last verdict: 3 min ago" (live).

---

## 4. Virality hooks (the "why would anyone share this" layer)

1. **"Ask the council anything" — no login.** One free public question on the
   landing page. Streams six seats arguing live. This is the demo *and* the hook.
2. **Shareable verdict card.** Every public answer renders an OG image
   (`/api/og/verdict/[ticker]`) — dark, neon, "6 AI analysts on $NVDA: BULLISH,
   invalidation < $462". Built for a screenshot in a group chat.
3. **Lead with the RISK seat.** "The only AI that tries to talk you *out* of your
   trade." That's the sentence people repeat.
4. **Public track record.** The verdict ledger already exists — surface a rolling
   hit-rate. Receipts beat adjectives.
5. **`/verdict/[ticker]` public pages** — SEO surface for "should I buy NVDA",
   each with the share card + a sign-up wall for history.

---

## 5. New page structure

```
1  Nav          logo · Product · Council · Pricing · [Sign in] [Start free →]
2  HERO         "Should I buy it, or not?"  + live council demo + parallax
3  Ticker strip demoted market data (§0.3), ambient
4  PROOF        6 seats · 138 checks · rolling hit-rate (counters on enter)
5  THE COUNCIL  sticky scroll-through: six seats debate one ticker → verdict
6  RISK SEAT    dedicated section — the contrarian hook
7  HOW          3 steps, plain language, one line each
8  RECEIPTS     public track record + shareable verdict card
9  PRICING      free tier framed first
10 CTA          "Ask the council a question — free" (no-login demo repeat)
11 Footer
```

---

## 6. Phases

**Phase 1 — Truth & brand (highest ROI, no new deps)**
- [ ] Fix the market-data path bug (§0.2) — read `brief.indices`, key by `.symbol`.
- [ ] Delete `landing.css`'s local `:root`; adopt `globals.css` tokens; green → neon-blue (§0.1).
- [ ] Rewrite hero + eyebrow + footer copy per the §0.4 table.
- [ ] Upgrade both auth CTAs (§3), add "free · no card".

**Phase 2 — Motion**
- [ ] Add `framer-motion`, `lenis`, `react-intersection-observer`, `lucide-react`.
- [ ] `<Hero3D/>` parallax stack + magnetic CTA + reduced-motion fallbacks.
- [ ] Scroll-reveal sections; stat counters.

**Phase 3 — Sell the core features**
- [ ] Sticky scroll-through council debate (replaces the three static phones).
- [ ] Dedicated RISK-seat section.
- [ ] "How it works" in 3 plain-language steps.

**Phase 4 — Viral loop**
- [ ] Public no-login "ask the council" demo (rate-limited, cached, 1/day/IP).
- [ ] `/api/og/verdict/[ticker]` share cards + `/verdict/[ticker]` public pages.
- [ ] Public rolling track record from the verdict ledger.

---

## 7. Guardrails
- Page stays a Server Component; client islands only where motion needs them.
- `prefers-reduced-motion` fully honored (`globals.css:94`).
- No secrets/hostnames in copy; keep the existing graceful fallbacks — a dead
  backend must degrade, never blank the page (`concept-cache-then-degrade`).
- The public demo must be rate-limited and cached, or it becomes a free LLM faucet.
- Lighthouse: don't regress LCP — parallax layers must be CSS-transform only.
