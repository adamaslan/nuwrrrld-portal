# Watchlist seed manifests

Each JSON file here records one run of `scripts/seed-watchlist-universe.mjs`:
the target Clerk user, the timestamp, and the **exact** list of tickers that
run inserted.

These are committed on purpose. The watchlist is primary user data, and a
bulk seed of ~1000 rows is not something anyone should have to unwind by
hand — nor should unwinding it be allowed to take out the tickers the user
had added themselves. The manifest is what makes the operation precisely
reversible:

```bash
node --env-file=.env.local scripts/seed-watchlist-universe.mjs \
  --undo=docs/watchlist-seeds/<file>.json
```

They double as the audit trail for which account was seeded, and when.

No secrets belong in this directory — a manifest holds ticker symbols and a
Clerk user id, nothing else.

## `paper/` — council paper-portfolio seeds

`paper/` holds manifests from `scripts/seed-paper-portfolios.mjs`
(docs/council-paper-portfolios.md §2.1/§6) — a separate, fixed 8-account seed,
**not** a user watchlist (it never touches `watchlist_items` or a Clerk user
id — see the design doc's §2.1 rule 5). Same reversibility contract: each run
writes `paper/seed-<timestamp>.json` (account, seat, label, exact ticker
list), and

```bash
node --env-file=.env.local scripts/seed-paper-portfolios.mjs \
  --undo=docs/watchlist-seeds/paper/<file>.json
```

reverses exactly that run. A `--force-reseed` over an already-seeded set of
accounts additionally writes `paper/archived-before-reseed-<timestamp>.json`
before deleting — the prior seed's accounts and watchlists in full, never
just dropped.
