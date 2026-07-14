# Wiki Log

Append-only. One entry per ingest/query/lint pass. Format:
`## [YYYY-MM-DD] type | short description` so `grep "^## \[" log.md` stays useful.

---

## [2026-07-02] init | Wiki created, mirrored from gcp3-mobile pattern | pages created: 11

Instantiated the Karpathy LLM Wiki pattern (`docs/karpathywiki.md`) for this
repo, deliberately mirroring `gcp3-mobile/docs/wiki-mobile/`'s schema (entity/
concept/decision/incident page types) since the two apps are explicit web/
mobile counterparts of the same product (per `docs/todo1.md`: "this is the web
version of code/gcp3-mobile the expo app... maintain strong sync").

Sources ingested: `package.json`, `app/` route tree, `lib/*.ts` (digest,
subscription, stripe, db, nuai, openrouter, watchlist-store, digest-cache,
digest-cache-db), `middleware.ts`, `app/api/webhooks/{clerk,stripe}/route.ts`,
`app/api/nuai/route.ts`, `docs/live-data-wiring.md`, `docs/todo1.md`, git log
(last ~20 commits).

Pages created: `SCHEMA.md`, `ORIGIN.md`, `overview.md`, `entity-clerk-nextjs.md`,
`entity-stripe-billing.md`, `entity-subscription.md`, `entity-neon-db.md`,
`entity-signals-digest.md`, `entity-nuai.md`, `entity-holdfold.md`,
`concept-shared-lib-with-mobile.md`, `known-issues.md`, `index.md`.

**Key finding this session**: cross-checked `lib/digest.ts`'s `adaptLiveSignals`
against `gcp3-mobile`'s copy — confirmed byte-for-byte contract match, which
corrected a false "divergence" implied by this repo's own stale planning doc
(`docs/live-data-wiring.md`, 2026-06-27). Also resolved one of `gcp3-mobile`'s
open questions in return: Nu AI's daily token budget is enforced server-side
in `app/api/nuai/route.ts`, via an in-memory (cold-start-resetting) map.

**Open items surfaced for future ingests** (see [[known-issues]] for full list):
- Sign-up consent checkbox parity with mobile — unconfirmed
- Deploy target (Vercel vs. Cloudflare Pages) — churned twice in git history
- `docs/live-data-wiring.md` P1/P2 items — unverified as shipped or not
- `lib/subscription.ts` / `lib/retention.ts` mobile-parity — not diffed this sync
- `FREE_MODEL_CHAIN` comment vs. PR #19 title naming discrepancy (Llama vs. Cohere)

**Schema compliance check:**
- All entity pages have required sections (What it is, Where used, Known
  failures, Open questions, See also): ✅
- All pages cataloged in `index.md`: ✅
- No secrets in any page (no Stripe keys, no Clerk keys, no Neon connection
  string, no Cloud Run URLs): ✅
- All pages have ≥3 cross-links: ✅
- log.md entry present: ✅ (this entry)

## [2026-07-14] ingest | PR #28 chore: deploy free-model chain refresh to GCP, Zo, Modal | pages touched: 1
