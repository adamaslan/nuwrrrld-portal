# TODO — Auth, Cookies, Consent, Tracking & Customer Data Profiles

Scope: `nuwrrrld-portal` (Next.js 16) with parity obligations to
`gcp3-mobile` (Expo). Written 2026-08-28 against the current tree.

**Read this first.** The privacy policy at [app/privacy-policy/page.tsx](app/privacy-policy/page.tsx)
already tells users we do things the code does not do, and this repo is
about to start doing things the policy does not cover. Every phase below is
ordered so that **consent infrastructure lands before the tracking it
gates.** Building the profile store first and bolting consent on later is
the failure mode this document exists to prevent — it is also the one that
turns a GDPR/CPRA question into a GDPR/CPRA liability.

---

## 0. Current state (verified, not assumed)

| Area | Reality today |
|---|---|
| Auth | Clerk, `clerkMiddleware` in [middleware.ts](middleware.ts). `/dashboard(.*)` + three API prefixes protected at the edge, handlers re-check (defense in depth). |
| Clerk instance | `pk_test_…` in `.env.local` — **Development instance**. Dev-mode banner is key-derived, not `NODE_ENV`-derived. |
| Cookies we set ourselves | **None.** Only Clerk's `__session` / `__client_uat`. No `Set-Cookie` anywhere in app code. |
| Analytics | **None installed.** No GA/GTM/PostHog/Segment/Plausible. `js-cookie` is present only as a transitive dep. |
| Ads / ad pixels | **None.** No Meta pixel, no Google Ads tag, no conversion tracking. |
| Behavioral data already held | Real and non-trivial: `council_sessions`, `council_messages`, `council_usage`, `nuai_usage`, `watchlist_items`, `disclaimer_acks`, `public_demo_usage`, `user_digest_cache` — all keyed by Clerk `user_id`. Plus Clerk `publicMetadata` (referral codes, `referrals_completed`) and `lib/retention.ts` streak state. |
| Consent capture | **None.** No cookie banner, no ToS/Privacy checkbox at sign-up (see [docs/todo1.md](docs/todo1.md)). |
| Policy vs. reality gaps | Policy says "analytics (if enabled)", "remember preferences and settings", and promises access/delete/portability/restrict rights with **no endpoint or runbook behind any of them**. |

The honest summary: **we hold more behavioral data than we advertise, and
we advertise more user-rights machinery than we've built.** Both directions
are wrong and both are fixed below.

---

## Phase 1 — Auth hardening (do first; everything else assumes a trustworthy identity)

### 1.1 Promote Clerk to a Production instance
- [ ] Create/activate the Production instance in the Clerk Dashboard (needs a
      verified domain + DNS for `clerk.financial.nuwrrrld.com`).
- [ ] Put `pk_live_…` / `sk_live_…` in **Vercel project env vars only**.
      Deliberately keep `pk_test_…` in local `.env.local` — dev mode locally is
      correct, dev mode in production is the bug.
- [ ] Verify: production build shows no Clerk dev badge; `__session` cookie is
      issued from the production domain, not `*.accounts.dev`.
- [ ] Confirm the dev-instance shared JWT signing key is **not** trusted by any
      production API route.

### 1.2 Session cookie posture
- [ ] Audit Clerk's session cookie attributes as actually served in prod:
      `Secure`, `HttpOnly`, `SameSite=Lax`, `Domain` scoped to the apex only if
      subdomain sharing with the mobile web view is genuinely needed.
- [ ] Set an explicit session lifetime + inactivity timeout in Clerk. This is a
      financial product; the default multi-day session is too long.
- [ ] Decide and document: does `gcp3-mobile` share a Clerk instance with the
      portal? If yes, a session revocation on one surface must revoke on the
      other — test it, don't assume it.

### 1.3 Close the authorization gaps the middleware doesn't cover
- [ ] `middleware.ts` protects only `/api/signals/digest`, `/api/portfolio/health`,
      `/api/holdfold`. Enumerate every route under [app/api/](app/api/) and
      classify each as: public / auth-required / internal-secret / webhook-signed.
      Add the auth-required ones to `isProtectedApiRoute`.
- [ ] Specifically re-check `council`, `nuai`, `analyze`, `backtest`, `brief`,
      `retention`, `referral` — these all read or write per-user rows and none
      are in the middleware matcher today.
- [ ] `PORTAL_PUSH_SECRET` bearer comparison at [middleware.ts:34](middleware.ts#L34)
      is a plain `===` on a header. Move to a timing-safe compare.
- [ ] Verify `/api/webhooks` validates provider signatures (Clerk + Stripe) and
      is *excluded* from `auth.protect()` for the right reason, not by accident.

### 1.4 Express consent at sign-up (already requested in [docs/todo1.md](docs/todo1.md))
- [ ] Add a **required, unticked** checkbox to the Clerk sign-up flow:
      "I agree to the Terms of Service and Privacy Policy," each linked.
- [ ] Persist the consent event — not just the boolean. Record
      `{ user_id, doc: 'tos'|'privacy', version, accepted_at, ip, user_agent }`.
      A bare `true` is not evidence; a versioned timestamped record is.
- [ ] Re-prompt on material policy version bump. The policy's own §12
      ("continued use constitutes acceptance") is weak for GDPR purposes —
      re-consent on material change instead of relying on it.
- [ ] Mirror the identical flow in `gcp3-mobile`. Consent captured on one
      surface should satisfy both; consent captured on *neither* is the current
      state.

---

## Phase 2 — Consent infrastructure (must land before ANY tracking in Phase 3+)

### 2.1 Consent model
- [ ] Define four categories, and treat them as genuinely separate switches:
      | Category | Example | Default |
      |---|---|---|
      | `strictly_necessary` | Clerk `__session`, CSRF | on, not refusable |
      | `preferences` | theme, watchlist view mode, digest frequency | **off** until chosen |
      | `analytics` | product usage events, funnels | **off** until chosen |
      | `marketing` | ad pixels, retargeting, conversion tags | **off** until chosen |
- [ ] Non-necessary categories default to **denied**. Pre-ticked boxes and
      "by continuing you agree" banners are not valid consent under GDPR and are
      explicitly enumerated as dark patterns under CPRA.
- [ ] "Reject all" must be **as easy and as prominent as "Accept all."** One
      click, same visual weight. This is the single most-enforced banner rule
      in the EU and the cheapest to get right on day one.

### 2.2 Consent storage & propagation
- [ ] Store consent in a first-party cookie `nu_consent` (JSON: version +
      per-category booleans + timestamp), `SameSite=Lax`, `Secure`, ~12 month
      max-age, **not** `HttpOnly` (client tag-gating must read it).
- [ ] For signed-in users, ALSO persist to a `consent_records` table so consent
      survives cookie clears and follows the account across devices and to
      `gcp3-mobile`. Cookie is the cache; the DB row is the record.
- [ ] Log every consent *change* append-only (grant, withdraw, version bump).
      Regulators ask for the history, not the current value.
- [ ] Server-side read helper `getConsent()` usable in RSC/route handlers, so
      server code can refuse to emit an event the user declined — client-side
      gating alone is bypassable and unauditable.

### 2.3 Consent UI
- [ ] Banner component (first visit, no `nu_consent` cookie): Accept all /
      Reject all / Manage.
- [ ] Preferences modal with per-category toggles and a plain-language
      description of *what each category actually does here*, naming vendors.
- [ ] Persistent "Cookie preferences" link in the footer next to the existing
      [DisclaimerFooter.tsx](components/DisclaimerFooter.tsx) — withdrawal must
      be as easy as granting.
- [ ] Honor `navigator.globalPrivacyControl` (GPC) as an automatic opt-out of
      `analytics` + `marketing`. California treats GPC as a legally binding
      opt-out signal; ignoring it is an enforcement item, and honoring it is ~5
      lines of code.
- [ ] Respect `Do Not Track` too, even though it's unenforced. Cheap goodwill.

### 2.4 Regional gating
- [ ] Geo-detect at the edge (Vercel `x-vercel-ip-country`). EU/EEA/UK/CH → hard
      opt-in banner. California → notice + "Do Not Sell or Share My Personal
      Information" link. Elsewhere → notice + opt-out.
- [ ] Decide the simpler alternative and write down the choice: **apply the
      strictest regime globally.** Fewer code paths, fewer bugs, no geo-IP
      accuracy problem. Recommended unless it measurably hurts conversion.

---

## Phase 3 — First-party analytics (gated on Phase 2 shipping)

### 3.1 Pick one vendor, deliberately
- [ ] Evaluate against a financial-product bar: data residency, DPA
      availability, cookieless mode, self-host option, and whether the vendor
      claims any right to use our data.
      - **PostHog (EU cloud or self-hosted)** — recommended. Product analytics
        + session replay + flags in one, EU residency, signed DPA.
      - **Plausible / Fathom** — cookieless, no consent banner needed for
        analytics category, but no user-level funnels. Good if we want to stay
        deliberately shallow.
      - **GA4** — free, but a repeated target of EU DPA decisions over US
        transfers. Not recommended for an EU-facing finance product.
- [ ] Sign a DPA. Record the vendor, purpose, and data categories in a
      processor register (Phase 6).

### 3.2 Instrumentation discipline
- [ ] Write the event taxonomy **before** writing any `track()` call:
      `object_action` naming, a fixed property vocabulary, one owner. Retrofit
      is far worse than upfront.
- [ ] Candidate events, grounded in what this app actually does: `signal_viewed`,
      `signal_shared`, `verdict_requested`, `council_session_started`,
      `nuai_prompt_submitted`, `watchlist_item_added`, `portfolio_health_run`,
      `backtest_viewed`, `paywall_hit`, `trial_started`, `subscription_started`,
      `referral_code_copied`, `disclaimer_acknowledged`.
- [ ] **Never** put in an event payload: holdings, position sizes, dollar
      amounts, AI prompt text, ticker-level portfolio composition. Send
      `holdings_count` bucketed, never the holdings. This is the line between
      "product analytics" and "we shipped our users' portfolios to a vendor."
- [ ] Analytics identity: use the Clerk `user_id` — never email, never a name.
      Pseudonymous by construction.
- [ ] All client tags load **only** when `nu_consent.analytics === true`. No
      script tag in [app/layout.tsx](app/layout.tsx) that fires pre-consent.
- [ ] Add a server-side event path for things that must be accurate regardless
      of ad-blockers (`subscription_started` from the Stripe webhook, not the
      browser).

### 3.3 Session replay — decide explicitly, default to off
- [ ] If enabled at all: mask **all** input fields by default, block the
      portfolio, holdings, dashboard, and AI chat surfaces entirely, and put
      replay behind its own consent sub-toggle.
- [ ] Recommended: **do not enable replay** on authenticated financial screens.
      The recording risk exceeds the debugging value.

---

## Phase 4 — Advertising, attribution & conversion tracking

This is the phase with the sharpest legal edges. Ad pixels are third-party
data sharing, and under CPRA sharing for cross-context behavioral advertising
triggers the "Do Not Sell or Share" obligation whether or not money changes
hands.

### 4.1 Inbound attribution (safe, do this first)
- [ ] Capture `utm_source/medium/campaign/term/content`, `gclid`, `fbclid`,
      referrer, and landing page on first touch into a first-party
      `nu_attrib` cookie (90 days). This is **first-party** and belongs to the
      `analytics` category, not `marketing`.
- [ ] Persist first-touch + last-touch attribution to the user record at sign-up
      so CAC can be computed per channel without any third-party pixel at all.
- [ ] Extend the existing referral system ([app/api/referral/route.ts](app/api/referral/route.ts))
      into the same attribution model — referral is already our cleanest,
      fully-first-party acquisition channel.

### 4.2 Ad platform pixels (only behind `marketing` consent)
- [ ] Meta Pixel / Google Ads tag / X pixel / Reddit pixel — each one added
      individually, each named in the privacy policy and consent modal, each
      firing **only** on `nu_consent.marketing === true`.
- [ ] Prefer **server-side conversion APIs** (Meta CAPI, Google Enhanced
      Conversions) over browser pixels: better accuracy under ad-blockers, and
      we control exactly which fields leave our servers instead of letting a
      third-party script read the whole page.
- [ ] Hash all PII (email → SHA-256, normalized lowercase/trimmed) before it
      leaves our infrastructure. Never send a raw email to an ad platform.
- [ ] **Never** transmit a conversion event containing financial detail. A
      conversion is `subscription_started` + plan tier + value. It is not
      "user bought Pro after viewing an NVDA bearish verdict."
- [ ] Implement Google Consent Mode v2 (`ad_storage`, `ad_user_data`,
      `ad_personalization`, `analytics_storage`) driven from `nu_consent`, if
      any Google tag ships. Required for EEA ad serving.

### 4.3 Financial-advertising compliance (specific to this product)
- [ ] Every ad creative and landing page must carry the same disclaimer posture
      the app already enforces via [components/DisclaimerModal.tsx](components/DisclaimerModal.tsx) —
      "not investment advice," no performance claims without the methodology,
      no implied guaranteed returns.
- [ ] Do **not** build ad audiences on inferred financial vulnerability
      (loss-chasing behavior, distressed portfolios, drawdown magnitude). Beyond
      the regulatory exposure, targeting people on financial distress signals is
      a line this product should not cross.
- [ ] Meta and Google both restrict financial-services advertising: review
      their special-category rules and whether the account needs verification
      before spend.
- [ ] No lookalike audiences seeded from portfolio-derived segments.

### 4.4 "Do Not Sell or Share" (CPRA)
- [ ] The moment any ad pixel ships, add a footer link: **"Do Not Sell or Share
      My Personal Information."** It must work without an account.
- [ ] Wire it to flip `marketing` consent off and propagate the opt-out to every
      ad platform's own opt-out API.
- [ ] GPC (2.3) must already satisfy this automatically.

---

## Phase 5 — Customer data & profiles (the actual product asset)

The profile is worth building. It is also the thing that makes a breach or a
subpoena expensive. Build it deliberately.

### 5.1 Unified customer profile
- [ ] Define a `customer_profile` view/table keyed by Clerk `user_id`, composed
      from data we **already** hold rather than newly collected data:
      - Identity: `user_id`, signup date, plan tier, trial state (Clerk + Stripe)
      - Engagement: streak state ([lib/retention.ts](lib/retention.ts)),
        `council_usage`, `nuai_usage`, digest open rate
      - Interest graph: `watchlist_items` → sector/market-cap/volatility profile
      - Behavior: verdict requests, backtest views, share actions
      - Attribution: first/last touch, referral chain
      - Consent: current per-category state + version
- [ ] Classify **every** field: `identifier` / `behavioral` / `financial` /
      `derived`. `financial` fields (holdings, position sizes, portfolio value)
      are the crown jewels — they must never leave the primary DB, never enter
      analytics, never enter an ad payload, and never be logged.
- [ ] Store profiles in the existing Postgres, not in a third-party CDP. A CDP
      would mean routing financial behavioral data through another processor for
      convenience we don't yet need.

### 5.2 Segmentation & derived attributes
- [ ] Derive segments for product use (onboarding nudges, digest tuning,
      churn-risk outreach): `power_user`, `at_risk_churn`, `trial_stalled`,
      `signal_only`, `portfolio_active`, `ai_heavy`.
- [ ] Document the derivation for each segment. Under GDPR Art. 22 / Art. 15,
      users can ask how an automated inference about them was produced. An
      undocumented ML segment is unanswerable.
- [ ] **Do not** derive inferences about net worth, income, creditworthiness,
      employment, or financial distress. These are special-category-adjacent in
      several jurisdictions and out of proportion to the product's needs.
- [ ] Segments used for *product* decisions live under `analytics` consent;
      segments used for *ad targeting* require `marketing` consent — they are
      not the same permission and must not share a code path.

### 5.3 Retention & minimization
- [ ] Set an explicit TTL per data class, then actually enforce it with a job:
      | Class | Retention |
      |---|---|
      | Raw analytics events | 14 months |
      | Session/auth logs | 90 days |
      | AI prompts & council messages | 12 months, then delete or anonymize |
      | Aggregated profile attributes | life of account + 30 days |
      | Consent records | life of account + 6 years (evidentiary) |
      | Billing records | 7 years (tax/legal) |
- [ ] The policy's §6 "reasonable period" is unenforceable hand-waving. Replace
      it with the table above once the job exists — not before.
- [ ] Audit what gets written to application logs. A `user_id` in a log line is
      fine; a prompt body or a holdings array is a data breach waiting for a
      log aggregator misconfiguration.

### 5.4 Third-party processor inventory
- [ ] Maintain a register: Clerk (auth), Neon/Postgres (storage), Vercel
      (hosting/logs), Stripe (billing), OpenRouter + Anthropic (LLM inference),
      Finnhub/yfinance (market data), plus whatever Phases 3–4 add.
- [ ] For each: purpose, data categories, region, DPA status, sub-processors,
      retention. The privacy policy §4 currently names these loosely — make the
      register the source of truth and generate the policy section from it.
- [ ] **LLM providers are the underrated one.** [app/api/council](app/api/council)
      and [app/api/nuai](app/api/nuai) transmit user prompts and portfolio context
      to third parties. Verify zero-retention / no-training terms are actually
      contracted, not merely assumed, and state the answer plainly in the policy.

---

## Phase 6 — Data-subject rights (the policy already promises these)

[app/privacy-policy/page.tsx](app/privacy-policy/page.tsx) §8 promises access,
correction, deletion, restriction, portability, and marketing opt-out. **None
of these have an implementation.** A promised right with no mechanism is worse
than an unpromised one.

- [ ] `GET /api/privacy/export` — authenticated. Assembles every row keyed to
      the caller's `user_id` across all tables + Clerk metadata, returns JSON
      (machine-readable, per the portability promise). Rate-limited.
- [ ] `POST /api/privacy/delete` — authenticated, with a confirmation step and a
      grace period. Must cascade across every table in
      [lib/db/schema.sql](lib/db/schema.sql), Clerk, Stripe (subject to the
      7-year billing carve-out), and every analytics/ad processor's deletion API.
- [ ] `GET /api/privacy/profile` — show the user their own derived segments and
      inferences. Transparency here is cheap and disproportionately trust-building.
- [ ] `POST /api/privacy/rectify` — correction requests.
- [ ] Deletion runbook covering processors without an API (manual steps,
      named owner, SLA).
- [ ] Meet the statutory clocks: GDPR 30 days, CCPA 45 days. Track request
      receipt timestamps so the clock is provable.
- [ ] Verify identity before fulfilling — an unauthenticated export endpoint is
      an account-takeover primitive, not a privacy feature.

---

## Phase 7 — Policy/reality reconciliation & governance

- [ ] Rewrite [app/privacy-policy/page.tsx](app/privacy-policy/page.tsx) to match
      what the code actually does at ship time. Remove every "(if enabled)"
      hedge — say what is enabled.
- [ ] Add the missing sections the current policy lacks: named cookie table
      (name, purpose, category, duration, first/third-party), named processor
      list, retention table, legal basis per purpose (GDPR Art. 6), and the
      automated-decision-making disclosure for AI-derived segments.
- [ ] §11 international transfers currently relies on bare "consent" — that is
      a weak Art. 49 derogation. Move to SCCs via the processors' DPAs and say so.
- [ ] Version the policy. `policy_version` in the consent record must reference it.
- [ ] Keep the mobile and web policies identical in substance; a divergence is
      a compliance bug, not a copy nit. Per
      `~/.claude/rules/mobile-web-wiki-sync.md`, any PR from this TODO updates
      the parity pages in **both** wikis.
- [ ] Add a `docs/wiki-portal/concept-privacy-data-flows.md` page mapping every
      data flow out of the system, and ingest each phase's PR into the wiki.
- [ ] Pre-launch review by someone qualified. This document is engineering
      scaffolding and an ordering argument — it is not legal advice, and a
      financial product touching EU/CA users should not ship Phases 4–5 on an
      engineer's read of the regulations alone.

---

## Recommended ordering

1. **Phase 1** — auth hardening. Independent of everything, fixes a live prod bug.
2. **Phase 2** — consent infrastructure. The hard prerequisite.
3. **Phase 6** — data-subject rights. Closes the gap where the policy already
   over-promises; also forces the data inventory that Phase 5 needs anyway.
4. **Phase 3** — analytics, first real tracking, now legitimately gated.
5. **Phase 5** — profiles, built on data we already hold.
6. **Phase 4** — ads. Last, deliberately: it carries the most legal exposure and
   depends on every prior phase.
7. **Phase 7** — reconcile the policy to what actually shipped.

The one non-negotiable in that list: **Phase 2 before Phase 3 or 4.**
Retrofitting consent onto live tracking means either a period of
non-compliant collection or discarding the data collected during it.
