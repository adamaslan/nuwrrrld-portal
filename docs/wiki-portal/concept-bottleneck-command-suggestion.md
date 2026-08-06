---
date: 2026-08-06
type: concept
tags: [automation, self-improving, bottleneck, cli-commands, wiki-led]
sources: [../../.claude/commands/friction.md, ../../.claude/commands/suggest-commands.md, ./log.md, ./concept-wiki-led-development.md]
---

# Concept: Bottleneck Command-Suggestion Loop

A self-improving loop that turns recurring friction into new automation. You log
friction as you hit it; a miner reads the log and proposes commands; adopted
commands absorb the friction; the next friction you hit is one you haven't seen
before. It gets cheaper over time and is fed entirely from this wiki.

## The pattern

```
  /friction                 /suggest-commands            you (curate)
  log a bottleneck  ──────►  mine log + incidents  ─────► adopt? write the
  line to log.md             + PR comments; tally         command, add to
  in the moment              vs. threshold; PROPOSE       entity-dev-command-suite
        ▲                          only                        │
        └──────────────────────────────────────────────────────┘
             the absorbed friction never recurs; the next one is new
```

- **Signal** — `/friction` appends one line to `log.md`:
  `## [date] friction | {what slowed you down} | cost: {rework|time|incident-risk|manual-step}`.
  Deliberately the cheapest command in the suite so there's no reason not to log.
- **Mine + propose** — `/suggest-commands` reads the friction lines, the incident
  pages, recurring chore/fix shapes in git history, and open-PR review comments;
  groups them into recurring classes; and proposes a command (or an extension)
  for each class over threshold.
- **Threshold** — propose when a class recurs **≥ 3 times**, OR **≥ 1 time if it
  caused or risks a production incident**. Incident-cost friction jumps the queue.
- **Curate** — the miner *proposes only*. A human vouches for the convention
  before it becomes a real command; adoption then follows the normal
  [[concept-wiki-led-development]] loop (write the file, add it to
  [[entity-dev-command-suite]], ingest, log).

The governing rule matches the rest of the automation layer: **move failure
earlier, or remove a step you keep repeating.** Config drift → validate at build.
Contract mismatch → pin a fixture. Repeated chore → schedule it. Repeated friction
→ mine it into a command.

## Where it appears

- `/friction` and `/suggest-commands` in [[entity-dev-command-suite]].
- The `friction` and `query` line types in [[log|log.md]] — the loop's durable
  memory; the miner's runs are logged as `query` lines.
- Evidenced by the build-process dossier (PRs #6–#47, 2026-06-19 → 2026-08-05):
  every existing command was born from repeated pain caught by memory — e.g. the
  `FREE_MODEL_CHAIN` refresh recurring across six chore PRs (#27, #28, #29, #38,
  #44, #47), and the two config/contract incidents
  ([[incident-2026-07-26-portfolio-health-endpoint-missing]],
  [[incident-2026-07-27-stripe-checkout-invalid-header]]). This loop makes that
  memory-to-command path explicit instead of ad hoc.

## Contradictions / tensions

> The loop only works if friction is **actually logged**. `/friction` is cheap by
> design to fight this, but nothing forces a log at the moment of pain — an
> unlogged bottleneck is invisible to the miner. Same reader-assumption shape as
> [[concept-wiki-led-development]]'s orient gap.

> ❓ Open question: the threshold (≥3, or ≥1 for incidents) is a heuristic, not
> tuned against data. Too low → proposal noise; too high → real bottlenecks sit
> below the line. No telemetry yet says which way it errs.

## See also

- [[concept-wiki-led-development]] — the broader loop this self-improvement rides on
- [[entity-dev-command-suite]] — where an adopted proposal lands
- [[concept-global-automation-layer]] — the `~/.claude/` layer proposals plug into
- [[incident-2026-07-26-portfolio-health-endpoint-missing]] — an incident-cost friction source
- [[incident-2026-07-27-stripe-checkout-invalid-header]] — the config-drift class the dossier ranks highest
