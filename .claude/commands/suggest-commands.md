# /suggest-commands — The Bottleneck Miner (proposes automation, never adopts)

Reads the wiki's accumulated pain — `log.md` friction lines, incident pages, and
open-PR review comments — tallies recurring bottlenecks against a threshold, and
**proposes new commands or automation to remove them**. It proposes only; you
still vouch for every convention before it becomes a real command.

This is the loop-closer from the build-process dossier (§03, recommendation #8)
and [[concept-bottleneck-command-suggestion]]: friction gets logged → the miner
proposes → an adopted command absorbs the friction → the next friction is one you
haven't seen yet. Focus areas: **automation and removing bottlenecks across the
full app stack and the admin local app.**

## 0. Orient (wiki-led dev — do this first)

Read `docs/wiki-portal/START-HERE.md`, then the pages this command reasons over:
[[concept-bottleneck-command-suggestion]], [[entity-dev-command-suite]] (what
already exists — don't propose a duplicate), and [[concept-global-automation-layer]].
Orienting first is what keeps proposals grounded in the wiki instead of
re-deriving the system cold.

## Guardrails

- **Propose, never adopt.** This command writes a proposal (and optionally a
  `friction`/`query` log line). It does **not** create command files, commit,
  or open PRs. Adoption is a human "yes."
- **Threshold to propose**: a friction/bottleneck must recur **≥ 3 times**, OR
  **≥ 1 time if it caused (or risks) a production incident.** Below threshold →
  note it, don't propose yet.
- **Don't duplicate the suite.** Check [[entity-dev-command-suite]] first; if an
  existing command already covers the friction, propose *extending* it, not a
  new one.
- **Secret policy**: reference env vars by name only; never surface real keys,
  tokens, URLs, or hostnames in the proposal.

## Execute

### 1. Gather the pain signals

```bash
cd /Users/adamaslan/code/nuwrrrld-portal

# a. All friction lines logged so far (the primary fuel; see /friction)
grep -n "| friction |" docs/wiki-portal/log.md

# b. Incident pages — each is a ≥1-occurrence, incident-cost signal
ls docs/wiki-portal/incident-*.md

# c. Recurring chore/fix shapes in merged history (repeated manual sequences)
git log --oneline -n 200 | grep -iE "^[0-9a-f]+ (chore|fix)" \
  | sed -E 's/^[0-9a-f]+ //' | sort | uniq -c | sort -rn | head -20

# d. Open-PR review comments (unaddressed friction that keeps recurring)
for pr in $(gh pr list --repo adamaslan/nuwrrrld-portal --state open --json number --jq '.[].number' 2>/dev/null); do
  gh api "repos/adamaslan/nuwrrrld-portal/pulls/$pr/comments" --jq '.[].body' 2>/dev/null
done
```

### 2. Tally against the threshold

Group the signals into recurring classes (config/env drift, backend-contract
mismatch, repeated manual chore, merge/rebase friction, enforcement gaps where a
convention is written but nothing checks it). For each class, count occurrences
and note the max `cost`. Keep only classes that clear the threshold above.

### 3. Propose — for each qualifying bottleneck

Write a short proposal block (to the chat, and optionally into a scratch file):

- **Bottleneck**: one line naming the recurring friction.
- **Evidence**: the specific log lines / incident / PR numbers / commit tallies
  that put it over threshold (cite real numbers, like the dossier does).
- **Proposal**: a new command *or* an extension to an existing one — name,
  one-line purpose, and which loop leak it plugs (move failure earlier / remove
  a repeated step / enforce a written-but-unchecked convention).
- **Cost to build** vs. **cost avoided** — rough, so ranking is possible.
- Rank all proposals by `cost-avoided × frequency`, highest first.

### 4. Record the run (wiki-led dev)

Append one line to `docs/wiki-portal/log.md` so the miner's own runs are traceable:

```bash
printf '\n## [%s] query | /suggest-commands: %d bottleneck(s) over threshold, %d proposal(s)\n' \
  "$(date +%F)" "<n_bottlenecks>" "<n_proposals>" >> docs/wiki-portal/log.md
```

If the user **adopts** a proposal, that's a separate act: write the new command
file, add it to [[entity-dev-command-suite]], and — if it changes the automation
story — ingest into [[concept-global-automation-layer]] with a `log.md` ingest
line. Adoption follows the normal wiki-led loop; proposing does not.

## See also

- `/friction` — logs the raw signal this command mines
- `docs/wiki-portal/concept-bottleneck-command-suggestion.md` — the loop, its threshold, and its history
- `docs/wiki-portal/entity-dev-command-suite.md` — the catalog a proposal extends or joins
- `docs/wiki-portal/concept-global-automation-layer.md` — the ~/.claude/ layer proposals plug into
