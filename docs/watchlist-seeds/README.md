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
