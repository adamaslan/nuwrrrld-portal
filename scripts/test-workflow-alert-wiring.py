#!/usr/bin/env python3
"""Validate alert wiring and its status/event truth table; requires PyYAML."""

import itertools
import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
# workflow: (dependencies, schedule-only, exact failure identity)
WORKFLOWS = {
    "afternoon-pipeline": (["gate", "pipeline"], False, "Afternoon pipeline failed"),
    "backup-to-sqlite": (["backup"], True, "Daily Neon→SQLite backup failed"),
    "compile-grounding-pack": (["compile"], True, "Scheduled grounding-pack compile failed"),
    "judge-followed-tickers": (["judge"], False, "Followed-tickers weekly judge failed"),
    "paper-portfolios": (["gate", "run-slot"], False, "Paper portfolios (${SLOT}) failed"),
    "precompute-ai": (["precompute"], True, "Nightly AI precompute failed"),
    "refresh-free-models": (["refresh"], True, "Weekly free-model chain refresh failed"),
    "select-followed-tickers": (["gate", "select"], False, "Followed-tickers monthly selection failed"),
    "track-followed-tickers": (["gate", "track"], False, "Followed-tickers daily tracking failed"),
}


def evaluate(
    expression: str,
    results: dict[str, str],
    event: str,
    dry_run: bool,
    account: str,
    cancelled: bool,
) -> object:
    """Evaluate the small expression subset used by these nine alert jobs."""
    expression = expression.strip().removeprefix("${{").removesuffix("}}")
    substitutions = {
        "always()": "True",
        "failure()": repr("failure" in results.values()),
        "cancelled()": repr(cancelled),
        "contains(needs.*.result, 'failure')": repr("failure" in results.values()),
        "github.event_name": repr(event),
        "inputs.dry_run": repr(dry_run),
        "inputs.account": repr(account),
    }
    for token, value in substitutions.items():
        expression = expression.replace(token, value)
    for job, result in results.items():
        expression = expression.replace(f"needs.{job}.result", repr(result))
    expression = expression.replace("&&", " and ").replace("||", " or ")
    expression = re.sub(r"!(?!=)", " not ", expression)
    expression = re.sub(r"\btrue\b", "True", expression)
    # Only checked-in expressions from the mapping above are evaluated.
    return eval(expression.strip(), {"__builtins__": {}}, {})


def main() -> None:
    """Check identities, permissions, concurrency and all relevant outcomes."""
    count = 0
    for workflow, (dependencies, schedule_only, title) in WORKFLOWS.items():
        path = ROOT / ".github/workflows" / f"{workflow}.yml"
        document = yaml.safe_load(path.read_text())
        notify = document["jobs"]["notify"]
        assert notify["needs"] == dependencies, workflow
        assert notify["permissions"] == {
            "contents": "read", "issues": "write", "actions": "read"
        }, workflow
        assert document["concurrency"] == {
            "group": workflow, "cancel-in-progress": False
        }, workflow
        assert notify["steps"][0]["uses"] == "actions/checkout@v4", workflow
        step = notify["steps"][1]
        assert step["env"]["GH_TOKEN"] == "${{ github.token }}", workflow
        assert step["env"]["NTFY_TOPIC"] == "${{ secrets.NTFY_TOPIC }}", workflow
        assert "failure()" not in step["env"]["ALERT_MODE"], workflow
        assert f'export ISSUE_TITLE="{title}"' in step["run"], workflow
        assert 'export RUN_URL="${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"' in step["run"], workflow
        assert "bash scripts/upsert-workflow-failure-issue.sh" in step["run"], workflow
        if workflow == "paper-portfolios":
            assert "needs.gate.outputs.slot || 'unresolved slot'" in step["run"]

        for states in itertools.product(["success", "failure", "skipped", "cancelled"], repeat=len(dependencies)):
            results = dict(zip(dependencies, states))
            for event, dry_run, account, cancelled in itertools.product(
                ["schedule", "workflow_dispatch", "push"], [False, True], ["", "one-account"], [False, True]
            ):
                arguments = (results, event, dry_run, account, cancelled)
                in_scope = not schedule_only or event == "schedule"
                failed = "failure" in states
                recovered = all(state == "success" for state in states) and (schedule_only or not dry_run)
                if workflow == "paper-portfolios" and account:
                    recovered = False
                expected = not cancelled and in_scope and (failed or recovered)
                actual = bool(evaluate(notify["if"], *arguments))
                assert actual == expected, (workflow, arguments, actual, expected)
                if actual:
                    mode = evaluate(step["env"]["ALERT_MODE"], *arguments)
                    assert mode == ("failure" if failed else "recovery"), (workflow, arguments, mode)
                count += 1
    print(f"workflow alert wiring tests passed: nine workflows, {count} condition cases")


if __name__ == "__main__":
    main()
