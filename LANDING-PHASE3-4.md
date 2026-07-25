# Landing Phase 3 + 4 — sell the core features, build the viral loop

Continues `LANDING-REVAMP.md` (Phase 1 + 2 shipped in PR #42). Scope: `app/page.tsx`,
new landing components, and new backend for the public council demo + share cards.

One deliberate deviation from `LANDING-REVAMP.md` §5/§6: Phase 3's "sticky
scroll-through council debate" is **added above** the existing six-seat
reference grid rather than **replacing** it. The grid already carries
real-data-adjacent, tested copy; the scrollytelling adds a demonstration layer
on top instead of throwing that away. Noted here so the deviation is visible,
not silently made.

## Phase 3 — sell the core features — done
- [x] `components/landing/CouncilScrollDebate.tsx` — sticky-pinned scrollytelling:
      a tall container where scroll progress steps through T1 → T2 → RISK →
      MACRO → QUANT → CHAIR, each seat's line appearing in sequence, ending on
      the same structured verdict already shown in the static grid. Framer
      Motion `useScroll` + `useMotionValueEvent` over a ref'd container; static
      fallback (all lines fully revealed, no pinning) under `prefers-reduced-motion`.
- [x] Dedicated RISK-seat section (`components/landing/RiskSpotlight.tsx`) —
      full-width, high-contrast section built around the single sentence
      "The only AI whose job is to argue against your trade," with a short
      scripted exchange (T1 proposes → RISK pushes back) for texture.
- [x] "How it works" 3-step section — Ask → They argue → You get one call,
      plain language, `lucide-react` icons, `Reveal`-wrapped.

## Phase 4 — the viral loop — done
Real backend, not just UI — grounded in the existing free-tier council
infra (`lib/openrouter.ts` `callCouncilSeat`, $0/call) and Neon (`lib/db.ts`).

- [x] Schema: `public_demo_usage` (per-IP-hash daily quota) and
      `public_demo_cache` (per-ticker cached answer — a repeat visitor asking
      about a ticker someone already asked about today costs nothing).
- [x] `lib/public-demo.ts` + `lib/shared/public-demo-policy.ts` — pure `hashIp`
      (sha256, never store raw IPs) + guarded quota/cache read-writes, same
      try/catch-degrades-gracefully convention as every other cache in this
      repo. Quota fails **closed** (unlike the authenticated `council_usage`
      quota, which fails open) — documented rationale in code: an anonymous
      endpoint failing open on a DB hiccup means unlimited free LLM calls.
      A failed downstream model call releases the consumed quota slot
      (`releaseDemoQuota`), matching the rollback pattern already used by
      `lib/council-db.ts`'s authenticated quota.
- [x] `POST /api/council/public` — ticker-only input (reuses
      `normalizeTicker`, never accepts free-text prompts from anonymous users
      — the fixed prompt template is built server-side, closing the prompt-
      injection door). Cache hit → free, unlimited. Cache miss → 1 fresh
      RISK-seat call per IP-hash per day, then cached for everyone.
- [x] `components/landing/PublicCouncilDemo.tsx` — the ticker input + result
      card, placed in the closing CTA section (page-structure item 10).
- [x] `GET /api/og/verdict/[ticker]` — `next/og` `ImageResponse` share card:
      ticker, direction, confidence, invalidation, "6 AI analysts" branding.
      Sources the latest row from `council_verdicts`; falls back to a generic
      "Ask the council about $TICKER" card when no verdict exists yet — never
      a broken image.
- [x] `app/verdict/[ticker]/page.tsx` — public page: renders the verdict +
      `openGraph.images` pointing at the OG route + a sign-up CTA for full
      history. No auth required to view.
- [x] Public rolling track record — aggregate `backtest_hit_rates` into one
      number for the landing page; graceful "building our track record" copy
      when the table is empty (dev/staging).

### Bugs found and fixed during manual testing
- Satori (the `next/og` renderer) requires an explicit `display: flex` on any
  multi-child `<div>` — two divs used JSX text+expression pairs (e.g.
  `${ticker}`, `Invalidation: {latest.invalidation}`) that Satori counts as
  2 children each. Fixed by collapsing each into one template-string
  expression (single child) and adding `display: "flex"` defensively.
- A second Satori issue: two sibling divs (`BULLISH` / `Invalidation: …`)
  wrapped in a bare `<>` fragment rendered side-by-side instead of stacked —
  Satori/Yoga doesn't flatten fragments the way React DOM does for layout
  purposes. Fixed by wrapping them in an explicit `display:flex;flexDirection:column` div.
- Verified end-to-end against a live Neon branch: quota consume → 503 → quota
  release (confirmed `count` back to 0), cache-hit path (confirmed `cached:true`
  bypasses the model entirely), and the 429 daily-limit path — all via direct
  SQL + curl, not just code review.

## Guardrails (unchanged from LANDING-REVAMP.md §7)
- No secrets in copy or committed code.
- Every new cache/quota read-write is try/catch-guarded — a DB hiccup
  degrades to "demo temporarily unavailable," never a 500 page.
- IP addresses are hashed before storage; never logged or persisted raw.
- Motion primitives reuse `Reveal`/`useReducedMotion` — no new unguarded animation.
