# Analytics event taxonomy

**Status:** spec only. `lib/analytics.ts` implements this contract with **no vendor sink attached** — `track()` validates an event against this taxonomy and drops it. Phase 3.1 (pick a vendor, sign a DPA) turns the drop into a send. Written before any `track()` call by design (Phase 3.2 of [docs/todo-auth-cookies-tracking.md](todo-auth-cookies-tracking.md)).

## Rules

1. **Naming:** `object_action`, lower_snake_case. The object is a noun, the action is a past-tense verb: `signal_viewed`, not `view_signal` or `signalView`.
2. **One owner** for this file. New events are added here first, in the table below, then in `EVENT_SCHEMA` in `lib/analytics.ts` — never ad hoc at a call site.
3. **Fixed property vocabulary.** A property name means the same thing in every event: `ticker` is always an uppercase symbol string, `plan` is always one of `free|monthly|annual`, `count` properties are always integers.
4. **Identity is the Clerk `user_id` and nothing else.** No email, no name, no IP in an event payload. Pseudonymous by construction.
5. **Never in a payload:** holdings, position sizes, dollar amounts, portfolio value, ticker-level portfolio composition, AI prompt or response text. Bucketed magnitudes only — `holdings_count_bucket: "1-5"`, never the list.
6. **Consent-gated at the sink.** `track()` is a no-op unless `nu_consent.analytics === true` (GPC/DNT already forces that off). There is no code path that emits an event pre-consent.
7. **Server-side for money.** `subscription_started` / `trial_started` fire from the Stripe webhook (`app/api/webhooks/stripe`), not the browser, so ad blockers cannot skew revenue metrics.

## Events

| Event | Trigger | Properties | Emitted from |
|-------|---------|------------|--------------|
| `signal_viewed` | A signal card or detail is rendered for the user | ticker, horizon (intraday\|short\|medium\|long), direction (optional) | client |
| `signal_shared` | User copies or opens the share card | ticker, surface (card\|link) | client |
| `verdict_requested` | User asks for a verdict on a ticker | ticker, horizon | client |
| `council_session_started` | A council deliberation begins | ticker (optional), seat_count | server /api/council* |
| `nuai_prompt_submitted` | User submits an NuAI prompt | prompt_len_bucket (0-100\|100-500\|500+) LENGTH ONLY never text | server /api/nuai |
| `watchlist_item_added` | Ticker added to the watchlist | ticker, watchlist_size_after | server /api/portfolio/watchlist |
| `portfolio_health_run` | Portfolio health computed | holdings_count_bucket (0\|1-5\|6-15\|16+) | server /api/portfolio/health* |
| `backtest_viewed` | A backtest result is shown | ticker, range | client |
| `paywall_hit` | User blocked by a plan gate | feature, plan | client |
| `trial_started` | Stripe trial begins | plan | server Stripe webhook |
| `subscription_started` | Stripe subscription becomes active | plan, value (plan list price not user-specific) | server Stripe webhook |
| `referral_code_copied` | User copies their referral code | (none) | client |
| `disclaimer_acknowledged` | User accepts the disclaimer | surface, version | server /api/disclaimer |

## Property value vocabularies

| Property | Allowed values |
|----------|----------------|
| horizon | `intraday`, `short`, `medium`, `long` |
| direction | `bullish`, `bearish`, `neutral` |
| plan | `free`, `monthly`, `annual` |
| holdings_count_bucket | `0`, `1-5`, `6-15`, `16+` |
| prompt_len_bucket | `0-100`, `100-500`, `500+` |
| surface | `card`, `link`, `web`, `mobile` |

## Not events (deliberately)

- Page views — the vendor's autocapture or a single `$pageview` covers this; don't hand-roll per-route events.
- Anything on an authenticated financial screen that would need the holdings to be useful. If the useful version of the event needs a forbidden property, the event does not exist.
