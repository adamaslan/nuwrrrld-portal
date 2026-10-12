#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT

cat > "$TEMP_DIR/gh" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$GH_MOCK_LOG"
if [[ "$1 $2" == "issue list" ]]; then
  if [[ "${GH_MOCK_LIST_EXIT:-0}" != "0" ]]; then
    exit "$GH_MOCK_LIST_EXIT"
  fi
  printf '%b' "${GH_MOCK_LIST:-}"
fi
MOCK
chmod +x "$TEMP_DIR/gh"

export PATH="$TEMP_DIR:$PATH"
export GH_TOKEN=test-token
export GITHUB_REPOSITORY=owner/repo
export ISSUE_TITLE="Nightly AI precompute failed"
export ISSUE_BODY=$'**Run:** https://example.test/run/123\n\nLatest failure.'
export GH_MOCK_LOG="$TEMP_DIR/gh.log"

GH_MOCK_LIST=$'41\tNightly AI precompute failed yesterday\n42\tNightly AI precompute failed\n' \
  bash "$SCRIPT_DIR/upsert-workflow-failure-issue.sh"
grep -Fq 'issue comment 42 --repo owner/repo' "$GH_MOCK_LOG"
grep -Fq 'https://example.test/run/123' "$GH_MOCK_LOG"
grep -Fq -- '--limit 100' "$GH_MOCK_LOG"
if grep -Fq 'issue create' "$GH_MOCK_LOG"; then
  echo "expected an exact-title match to comment, not create" >&2
  exit 1
fi

: > "$GH_MOCK_LOG"
GH_MOCK_LIST=$'41\tNightly AI precompute failed yesterday\n' \
  bash "$SCRIPT_DIR/upsert-workflow-failure-issue.sh"
grep -Fq 'issue create --repo owner/repo --title Nightly AI precompute failed' "$GH_MOCK_LOG"
grep -Fq 'https://example.test/run/123' "$GH_MOCK_LOG"
if grep -Fq 'issue comment' "$GH_MOCK_LOG"; then
  echo "expected a near-title mismatch to create, not comment" >&2
  exit 1
fi

: > "$GH_MOCK_LOG"
if GH_MOCK_LIST_EXIT=1 bash "$SCRIPT_DIR/upsert-workflow-failure-issue.sh"; then
  echo "expected a failed lookup to abort the upsert" >&2
  exit 1
fi
if grep -Eq 'issue (create|comment)' "$GH_MOCK_LOG"; then
  echo "a failed lookup must not create or comment" >&2
  exit 1
fi

echo "upsert-workflow-failure-issue mock tests passed"
