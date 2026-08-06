# /friction — Log a Bottleneck the Moment You Hit It

Appends one `friction` line to the wiki log (`docs/wiki-portal/log.md`) recording
a manual step you had to repeat, a rebase you had to hand-do, a config drift that
bit you, or any place the build slowed down. **This is the fuel for
`/suggest-commands`** — the bottleneck miner can only propose automation for
friction that was actually written down.

One line, logged in the moment, is the whole point. Don't wait for a
retrospective; the loop in [[concept-bottleneck-command-suggestion]] starts here.

## When to run

- You just did something manual **you've done before** (hand-rebased stacked PRs,
  re-refreshed a chain, re-typed the same env fix).
- A config/contract mismatch cost you rework (the two incident classes in the
  build dossier: env/secret drift, backend-contract drift).
- Anything made the stack or the admin local app slower than it should be.
- Rule of thumb: **if you thought "ugh, again," log it.**

## Log format (SCHEMA `log.md`)

```
## [{YYYY-MM-DD}] friction | {what slowed you down, one line} | cost: {rework|time|incident-risk|manual-step}
```

`cost:` classifies the leak so the miner can weight it — an `incident` cost
counts even at a single occurrence; `rework`/`manual-step` need repetition to
cross the threshold.

## Execute

```bash
cd /Users/adamaslan/code/nuwrrrld-portal/docs/wiki-portal

# Append the friction line (never rewrite existing log history — append only).
printf '\n## [%s] friction | %s | cost: %s\n' \
  "$(date +%F)" "<one-line description>" "<rework|time|incident-risk|manual-step>" \
  >> log.md

tail -3 log.md   # confirm it landed
```

That's it — no PR, no build, no ingest. `/friction` is deliberately the cheapest
command in the suite so there's zero reason not to log. The miner
(`/suggest-commands`) does the heavy reading later.

## See also

- `/suggest-commands` — the miner that reads these lines and proposes automation
- `docs/wiki-portal/concept-bottleneck-command-suggestion.md` — the loop this feeds
- `docs/wiki-portal/entity-dev-command-suite.md` — where a proposed command lands if you adopt it
