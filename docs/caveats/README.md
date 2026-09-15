# Session Caveats

One file per session that shipped (or investigated) something worth
distrusting later. Not a TODO list and not a handoff — see
`docs/manual-setup-todo.md` for human-owned action items and
`docs/session-handoff.md` for where to pick up next session.

Each entry is point-in-time and append-only at the file level: a later
session never edits an earlier entry, it adds a new one.

## Secret policy

No API keys, tokens, passwords, cookies, connection strings, Stripe
price/customer IDs, GCP project IDs, Cloud Run hostnames, or email addresses
(including the user's own) ever appear in these files. Name the variable or
the file that holds it instead.

## Index

| Date | Entry | Repos | Summary |
|---|---|---|---|
| 2026-09-15 | [portfolio-liveness-watchlist-fix](2026-09-15-portfolio-liveness-watchlist-fix.md) | nuwrrrld-portal | Fixed a strict-mode-violating e2e assertion and merged PR #134 past two pre-existing, already-tracked CI secret failures |
