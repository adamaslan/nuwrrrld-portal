---
date: 2026-08-11
type: entity
tags: [disclaimer, compliance, legal, neon, clerk, hash]
sources: [../../lib/disclaimer.ts, ../../lib/disclaimer-db.ts, ../../app/api/disclaimer/route.ts, ../../components/DisclaimerModal.tsx, ../../components/DisclaimerFooter.tsx]
---

# Entity — Disclaimer & Acknowledgement System

## What it is

Gates every trade-shaped output surface (Hold/Fold verdicts, signals, portfolio
suggestions, live per-ticker analysis) behind an acknowledged legal disclaimer,
ported from `holdemfoldemapp/frontend/src/lib/disclaimer.ts` with one structural
change: portal has Clerk accounts, so acknowledgement is durable, not
localStorage-only.

**The load-bearing trick, kept from the source:** `DISCLAIMER_HASH` is `djb2(text
+ version)` — derived from the text itself, not a hand-maintained version int.
Editing a single word in `DISCLAIMER_TEXT` changes the hash, which automatically
invalidates every prior acknowledgement on next check. No migration step, no
"bump the version" checklist to forget.

**Persistence, two tiers:**
- Signed-out: `localStorage` only (`lib/disclaimer.ts` `hasAcknowledgedLocally` /
  `markAcknowledgedLocally`) — same as holdfold's original.
- Signed-in: `disclaimer_acks` in Neon (`lib/disclaimer-db.ts`), keyed on
  `(user_id, disclaimer_hash)`, append-only. `localStorage` is read first as an L1
  to skip the round-trip; the Neon row is what makes the acknowledgement durable
  and auditable across devices.

**Failure policy is deliberately asymmetric** — the one place in this repo where
a "cache" doesn't follow [[concept-cache-then-degrade]]'s usual binary:
- `hasAcknowledged()` fails **closed** — a DB error returns `false`, so the modal
  re-shows. An outage must never silently ungate advice-shaped output.
- `recordAck()` fails **open** — a write error is swallowed. Losing one ack write
  just means the modal shows again next visit; not worth 503-ing the user over.

`DisclaimerFooter`'s "View full disclaimer" opens the modal in a `forceOpen`
read-only mode rather than clearing the stored ack and reloading (which is what
holdfold's original footer does) — clearing an ack that's now backed by an audit
row for a paying user would be destructive of that record just to re-display text.

## Where used

- `app/verdict/[ticker]` (public, no-auth, the OG-card share destination)
- `app/signals`
- `app/portfolio-intelligence`
- `app/dashboard/holdfold/[ticker]` (also gates [[entity-holdfold-cache]]'s new
  live-analysis panel, see below)

Each passes a `surface` prop (`"verdict" | "signals" | "portfolio" | "analyze"`)
recorded alongside the ack for audit purposes.

## Known failures

- No re-prompt on `DISCLAIMER_VERSION` bump alone if `DISCLAIMER_TEXT` is
  unchanged — intentional, since the hash is the source of truth, but worth
  flagging: bumping the version string without changing the text does nothing.
- Signed-out → signed-up transition doesn't migrate a `localStorage` ack into
  Neon; a brand-new account re-prompts once even if the same browser already
  acknowledged as a guest. Acceptable for now (one extra click), not fixed.

## Open questions

- ❓ Should `disclaimer_acks` also record ack on paid actions specifically (e.g.
  Stripe checkout), separate from page-view gating? Currently one ack per hash
  covers all surfaces once recorded anywhere.
- ❓ No admin visibility into ack rate/version drift yet — would need a query
  against `disclaimer_acks` grouped by `disclaimer_hash`.

## See also

- [[concept-cache-then-degrade]] — the general cache-vs-user-data failure-policy
  split this entity's asymmetric read/write policy is a variant of
- [[entity-holdfold-cache]] — sibling Neon store, and where the new
  `analyze_cache` table (same session) lives
- [[decision-second-analyze-backend]] — the live-analysis feature this entity
  now also gates
- `holdemfoldemapp/frontend/src/lib/disclaimer.ts` — source implementation this
  was ported from (cross-repo, link by path per [[SCHEMA]])
