---
date: 2026-09-03
type: incident
tags: [database, neon, security, pii, schema]
sources: [../../scripts/backup-to-sqlite.mjs, ../local-sqlite-backup-and-offline-dev.md, PR#98]
---

# Incident: Undeclared Tables — Possibly a Different App's Customer Data — in This Repo's Neon Database

## Date & severity

**Found 2026-09-03**, while building and testing [[entity-sqlite-backup]] (PR
#98) against the real production database. **Severity: unresolved, likely
low-to-moderate** — nothing in this repo reads or writes the affected tables,
so there's no code-path risk, but the data's presence and scope of access are
unconfirmed.

## What happened

`scripts/backup-to-sqlite.mjs` introspects `information_schema.tables` live
against `DATABASE_URL` rather than reading `lib/db/schema.sql`'s table list —
a deliberate choice so the backup can't silently drift from the schema file.
Run for real, it found **4 tables in the live database that `lib/db/schema.sql`
never declared**, and that a full repo `grep` across `lib/`, `app/`, `scripts/`
found **zero references to**:

| Table | Rows | Columns |
|---|---|---|
| `comments` | 9 | `comment: text` |
| `invoices` | 26 | `invoice_id`, `invoice_url`, `price_amount`, `price_currency`, `customer_email`, `customer_name`, `address_line1/2`, `city`, `state`, `postal_code`, `country`, `pay_currency`, `order_description`, `item_url`, `webhook_received`, `status`, timestamps |
| `processed_webhook_events` | 0 | `invoice_id`, `payment_status`, `processed_at` |
| `rate_limit_counters` | 2 | `bucket`, `identifier`, `window_start`, `count` |

`invoices`' shape is the concerning one. This app bills through Stripe
([[entity-billing]]) — `lib/subscription.ts`, `lib/stripe.ts`,
`STRIPE_PRICE_MONTHLY`/`STRIPE_PRICE_ANNUAL`. Nothing in that model has a
`pay_currency` field distinct from `price_currency`, an `item_url`, or a full
shipping address per invoice. Those columns read like a **crypto payment
processor's** invoice schema (the kind NOWPayments/CoinPayments-style
integrations use), not a Stripe subscription. 26 rows of what looks like real
customer PII (email, name, mailing address) currently live in the same Neon
project as this portal's own data.

## Root cause

Unconfirmed — this is a discovery, not a diagnosed incident. The leading
hypothesis: this Neon *project* (not just this repo) is shared with another,
unrelated application, and that application's tables happen to be reachable
from the same `DATABASE_URL` / connection pool this repo's `.env.local` and
Vercel project env vars hold. Nothing rules out a more mundane explanation
(an old prototype, a manually-created table for a one-off script that was
never cleaned up), but the specificity of the `invoices` schema argues against
"leftover scratch table."

## Resolution

**Not resolved.** The backup tool's default behavior already contains the
immediate risk: `scripts/backup-to-sqlite.mjs` only backs up tables present
in `lib/db/schema.sqlite.sql`, so it skipped all four with a loud
`⚠ skipping "invoices" — not present in lib/db/schema.sqlite.sql yet` rather
than silently copying customer PII into a file this repo's `.gitignore`
governs. No data from these tables was read beyond column names, types, and
row counts (via `information_schema.columns` and `SELECT count(*)`) — no
actual row contents were fetched or displayed.

## Impact on design

- [[entity-sqlite-backup]]'s allowlist-by-schema approach (only mirror what's
  declared) is now validated as the correct default for exactly this failure
  mode — an opt-in `--tables=` flag exists for scoping down, but there is
  deliberately no equivalent "back up everything Postgres reports, declared
  or not" flag.
- Anyone with this repo's `DATABASE_URL` (every contributor with `.env.local`,
  every Vercel deploy) currently has read/write access to another
  application's customer data, if the shared-project hypothesis is correct.
  That's a broader access-scoping question than this repo's schema.

## Open items

- ❓ Confirm what `invoices`/`comments`/`processed_webhook_events`/
  `rate_limit_counters` actually are and who owns that data — this needs a
  conversation with whoever else holds a connection string to this Neon
  project, not a code change.
- ❓ If confirmed as another app's data: does this Neon project need to be
  split so this repo's credentials can't reach it at all? If it's actually
  this app's own (unlikely given the schema mismatch, but unconfirmed): does
  it need onboarding into `lib/db/schema.sql`?
- ❓ Should [[entity-sqlite-backup]] eventually warn (not just skip) when it
  finds undeclared tables, so this doesn't require someone happening to run
  a full unfiltered backup to notice again?

## See also

- [[entity-sqlite-backup]] — the tool that surfaced this
- [[entity-billing]] — this repo's actual (Stripe-based) invoicing model, for contrast with the undeclared `invoices` table's schema
- `../local-sqlite-backup-and-offline-dev.md` §1.4 — where this is also documented for anyone reading the backup guide directly
