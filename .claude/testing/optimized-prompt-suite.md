# Optimized Prompt Suite — Testing Index

Skills in `.claude/skills/` for nuwrrrld-portal. Each was distilled from the opt-prompts sets (1–4). This file is the index for the suite; add a row when a skill is added.

## Skills

| Skill | Use when |
|---|---|
| evidence-gated-delivery | Shipping a change with proof: evidence packs, test-first fixes, UI runtime proof, PR gatekeeping |
| feature-gating-safety | Flag-first rollouts, safety audits, canary/rollback plans |
| ai-code-debugging | Reviewing AI-written code for failure modes; evidence-first debugging |
| debug-lifecycle-early | Start of a bug: triage, reproduction, evidence, write-path trace |
| debug-lifecycle-late | Bug after repro: hypotheses, root cause, fix, verification, postmortem |
| planning-framing-options | Framing a goal, assumptions register, options, decision record |
| planning-handoff-review | Milestone plans, session briefs for fresh agents, checkpoint reviews |
| codebase-build-refactor | Mapping an unfamiliar repo, impact analysis, specs, safe refactors |
| testing-perf-cost | Test gap/mutation checks, measure-before-optimize, cost audits |
| ops-security-data-delegation-docs | Data/security/ops reviews, incidents, delegation, docs and status updates |

## Suite checks

Run these when the suite changes:

```bash
python3 - <<'PY_CHECK'
from pathlib import Path
import ast, re
bad = False
for folder in sorted(Path('.claude/skills').iterdir()):
    if not folder.is_dir():
        continue
    text = (folder / 'SKILL.md').read_text()
    lines = text.splitlines()
    close = next((i for i in range(1, len(lines)) if lines[i] == '---'), None)
    front = '\n'.join(lines[1:close]) if lines and lines[0] == '---' and close is not None else ''
    names = re.findall(r'^name:\s*(.*?)\s*$', front, re.M)
    value = names[0] if len(names) == 1 else None
    if value and value[:1] in ('"', "'"):
        try:
            value = ast.literal_eval(value)
        except (ValueError, SyntaxError):
            value = None
    ok = value == folder.name
    print(('ok ' if ok else 'BAD ') + folder.name)
    bad |= not ok
raise SystemExit(1 if bad else 0)
PY_CHECK
```

This check supports plain names and Python-compatible single/double-quoted scalar names; it is not a full YAML parser. Opening and closing frontmatter delimiters must be standalone `---` lines.

Expect every line to start with `ok`. A `BAD` line means the frontmatter scalar `name` is missing, malformed, duplicated, or does not match its folder, so the skill will not load under that name.

## Growing the suite

1. Add `.claude/skills/<name>/SKILL.md` with frontmatter `name` equal to the folder name.
2. Add a row to the table above.
3. Run the suite check.
