#!/usr/bin/env bash
# No GitHub or ntfy calls: both executables are recording mocks.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT

cat > "$TEMP_DIR/gh" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$GH_MOCK_LOG"
if [[ "$1" == api ]]; then
  [[ "${GH_MOCK_RUN_EXIT:-0}" == 0 ]] || exit "$GH_MOCK_RUN_EXIT"
  printf '%s\n' "$GH_MOCK_RUN"
elif [[ "$1 $2" == "issue list" ]]; then
  [[ "${GH_MOCK_LIST_EXIT:-0}" == 0 ]] || exit "$GH_MOCK_LIST_EXIT"
  printf '%s\n' "${GH_MOCK_LIST:-[]}"
else
  exit "${GH_MOCK_MUTATE_EXIT:-0}"
fi
MOCK
cat > "$TEMP_DIR/curl" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$CURL_MOCK_LOG"
exit "${CURL_MOCK_EXIT:-0}"
MOCK
chmod +x "$TEMP_DIR/gh" "$TEMP_DIR/curl"

export PATH="$TEMP_DIR:$PATH"
export GH_TOKEN=test-token
export GITHUB_REPOSITORY=owner/repo
export ISSUE_TITLE="Nightly AI precompute failed"
export ISSUE_BODY=$'**Run:** https://example.test/run/123\n\nLatest failure.'
export RUN_URL=https://example.test/run/123
export GITHUB_RUN_ID=123
export GITHUB_RUN_ATTEMPT=1
export GITHUB_WORKFLOW='Nightly AI precompute'
export GITHUB_REF_NAME=main
export GITHUB_EVENT_NAME=schedule
export GH_MOCK_LOG="$TEMP_DIR/gh.log"
export CURL_MOCK_LOG="$TEMP_DIR/curl.log"
# Do not inherit notification settings, mode or mock behavior from the caller.
unset ALERT_MODE NTFY_TOPIC GH_MOCK_LIST GH_MOCK_LIST_EXIT GH_MOCK_MUTATE_EXIT CURL_MOCK_EXIT GH_MOCK_RUN_EXIT
export GH_MOCK_RUN='{"id":123,"run_attempt":1,"name":"Nightly AI precompute","head_branch":"main","event":"schedule","run_started_at":"2026-10-12T12:00:00Z"}'
readonly EXACT='[{"number":41,"title":"Nightly AI precompute failed yesterday"},{"number":42,"title":"Nightly AI precompute failed","updatedAt":"2026-10-12T11:00:00Z"}]'
readonly NEAR='[{"number":41,"title":"Nightly AI precompute failed yesterday"}]'

reset_logs() { : > "$GH_MOCK_LOG"; : > "$CURL_MOCK_LOG"; }
assert_no_mutation() {
  if grep -Eq 'issue (create|comment|close)' "$GH_MOCK_LOG" || [[ -s "$CURL_MOCK_LOG" ]]; then
    echo 'Unexpected issue mutation or push' >&2
    exit 1
  fi
}
expect_failure() {
  if env "$@" bash "$SCRIPT_DIR/upsert-workflow-failure-issue.sh" > "$TEMP_DIR/output" 2>&1; then
    echo "Expected failure: $*" >&2
    exit 1
  fi
}

reset_logs
GH_MOCK_LIST="$EXACT" bash "$SCRIPT_DIR/upsert-workflow-failure-issue.sh"
grep -Fq 'issue comment 42 --repo owner/repo' "$GH_MOCK_LOG"
grep -Fq 'Failed again:' "$GH_MOCK_LOG"
grep -Fq "$RUN_URL" "$GH_MOCK_LOG"
grep -Fq -- '--limit 100' "$GH_MOCK_LOG"
! grep -Fq 'issue create' "$GH_MOCK_LOG"
[[ ! -s "$CURL_MOCK_LOG" ]]

reset_logs
GH_MOCK_LIST='[{"number":51,"title":"Nightly AI precompute failed 2026-10-13","updatedAt":"2026-10-12T11:00:00Z"},{"number":41,"title":"Nightly AI precompute failed 2026-10-12","updatedAt":"2026-10-12T11:00:00Z"},{"number":49,"title":"Nightly AI precompute failed 2026-10-11","updatedAt":"2026-10-12T11:00:00Z"}]' bash "$SCRIPT_DIR/upsert-workflow-failure-issue.sh"
grep -Fq 'issue comment 41 --repo owner/repo' "$GH_MOCK_LOG"
if grep -Fq 'issue create' "$GH_MOCK_LOG"; then
  echo "expected the lowest-numbered legacy dated issue to be reused" >&2
  exit 1
fi

reset_logs
GH_MOCK_LIST='[{"number":41,"title":"Nightly AI precompute failed 2026-10-12","updatedAt":"2026-10-12T11:00:00Z"},{"number":60,"title":"Nightly AI precompute failed","updatedAt":"2026-10-12T11:00:00Z"},{"number":42,"title":"Nightly AI precompute failed","updatedAt":"2026-10-12T11:00:00Z"},{"number":40,"title":"Nightly AI precompute failed 2026-10-11","updatedAt":"2026-10-12T11:00:00Z"}]' bash "$SCRIPT_DIR/upsert-workflow-failure-issue.sh"
grep -Fq 'issue comment 42 --repo owner/repo' "$GH_MOCK_LOG"
if grep -Fq 'issue create' "$GH_MOCK_LOG"; then
  echo "expected the lowest-numbered exact match to take precedence" >&2
  exit 1
fi

reset_logs
GH_MOCK_LIST="$NEAR" bash "$SCRIPT_DIR/upsert-workflow-failure-issue.sh"
grep -Fq 'issue create --repo owner/repo --title Nightly AI precompute failed' "$GH_MOCK_LOG"

reset_logs
GH_MOCK_LIST='[{"number":41,"title":"Nightly AI precompute failed yesterday","updatedAt":"2026-10-12T11:00:00Z"},{"number":42,"title":"Nightly AI precompute failed 2026-10-12 extra","updatedAt":"2026-10-12T11:00:00Z"},{"number":43,"title":"Nightly AI precompute failed  2026-10-12","updatedAt":"2026-10-12T11:00:00Z"},{"number":44,"title":"Nightly AI precompute failed 2026-1-12","updatedAt":"2026-10-12T11:00:00Z"},{"number":45,"title":"Nightly AI precompute failed2026-10-12","updatedAt":"2026-10-12T11:00:00Z"}]' bash "$SCRIPT_DIR/upsert-workflow-failure-issue.sh"
grep -Fq 'issue create --repo owner/repo --title Nightly AI precompute failed' "$GH_MOCK_LOG"
grep -Fq "$RUN_URL" "$GH_MOCK_LOG"
! grep -Fq 'issue comment' "$GH_MOCK_LOG"
[[ ! -s "$CURL_MOCK_LOG" ]]

# Enabled push: only first failure, then recovery; repeats remain issue comments.
reset_logs
NTFY_TOPIC=test-only bash "$SCRIPT_DIR/upsert-workflow-failure-issue.sh"
grep -Fq 'First failure: https://example.test/run/123' "$CURL_MOCK_LOG"
grep -Fq -- '--max-time 10' "$CURL_MOCK_LOG"
grep -Fq -- '--data-binary' "$CURL_MOCK_LOG"
grep -Fq 'https://ntfy.sh/test-only' "$CURL_MOCK_LOG"
reset_logs
NTFY_TOPIC=test-only GH_MOCK_LIST="$EXACT" bash "$SCRIPT_DIR/upsert-workflow-failure-issue.sh"
[[ ! -s "$CURL_MOCK_LOG" ]]

reset_logs
ALERT_MODE=recovery NTFY_TOPIC=test-only GH_MOCK_LIST="$EXACT" ISSUE_BODY='' \
  bash "$SCRIPT_DIR/upsert-workflow-failure-issue.sh"
grep -Fq 'issue close 42 --repo owner/repo --reason completed --comment Recovered: https://example.test/run/123' "$GH_MOCK_LOG"
grep -Fq 'Recovered: https://example.test/run/123' "$CURL_MOCK_LOG"
grep -Fq 'Tags: white_check_mark' "$CURL_MOCK_LOG"
! grep -Eq 'issue (create|comment)' "$GH_MOCK_LOG"
reset_logs
ALERT_MODE=recovery GH_MOCK_LIST="$EXACT" bash "$SCRIPT_DIR/upsert-workflow-failure-issue.sh"
grep -Fq 'issue close 42' "$GH_MOCK_LOG"
[[ ! -s "$CURL_MOCK_LOG" ]]
for list in '[]' "$NEAR"; do
  reset_logs
  ALERT_MODE=recovery NTFY_TOPIC=test-only GH_MOCK_LIST="$list" bash "$SCRIPT_DIR/upsert-workflow-failure-issue.sh"
  assert_no_mutation
 done

# Lookup/auth errors and malformed JSON must fail closed in both modes.
for mode in failure recovery; do
  reset_logs
  expect_failure ALERT_MODE="$mode" NTFY_TOPIC=test-only GH_MOCK_LIST_EXIT=1
  assert_no_mutation
  for list in ' ' '[] []' 'not-json' '{}' 'null' '[{"number":"42","title":"Nightly AI precompute failed"}]' \
    '[{"number":-1,"title":"Nightly AI precompute failed"}]' \
    '[{"number":1.5,"title":"Nightly AI precompute failed"}]' \
    '[{"number":42}]' '[{"number":42,"title":null}]'; do
    reset_logs
    expect_failure ALERT_MODE="$mode" NTFY_TOPIC=test-only GH_MOCK_LIST="$list"
    assert_no_mutation
done
  # No push if GitHub did not accept the create/comment/close.
  for list in '[]' "$EXACT"; do
    reset_logs
    if [[ "$mode" == recovery && "$list" == '[]' ]]; then continue; fi
    expect_failure ALERT_MODE="$mode" NTFY_TOPIC=test-only GH_MOCK_LIST="$list" GH_MOCK_MUTATE_EXIT=1
    [[ ! -s "$CURL_MOCK_LOG" ]]
  done
  # Failed optional transport is a warning, not an alert lifecycle failure.
  reset_logs
  ALERT_MODE="$mode" NTFY_TOPIC=test-only CURL_MOCK_EXIT=22 \
    GH_MOCK_LIST="$([[ "$mode" == recovery ]] && echo "$EXACT" || echo '[]')" \
    bash "$SCRIPT_DIR/upsert-workflow-failure-issue.sh" > "$TEMP_DIR/output"
  grep -Fq '::warning::ntfy delivery failed' "$TEMP_DIR/output"
  [[ -s "$CURL_MOCK_LOG" ]]
done

# Bad push configuration cannot break the authoritative GitHub alert.
for topic in 'bad/topic' $'bad\r\nheader' 'bad?query'; do
  reset_logs
  NTFY_TOPIC="$topic" bash "$SCRIPT_DIR/upsert-workflow-failure-issue.sh" > "$TEMP_DIR/output"
  grep -Fq 'issue create' "$GH_MOCK_LOG"
  grep -Fq '::warning::ntfy skipped' "$TEMP_DIR/output"
  [[ ! -s "$CURL_MOCK_LOG" ]]
done
reset_logs
NTFY_TOPIC=test-only RUN_URL='' bash "$SCRIPT_DIR/upsert-workflow-failure-issue.sh" > "$TEMP_DIR/output"
grep -Fq 'issue create' "$GH_MOCK_LOG"
[[ ! -s "$CURL_MOCK_LOG" ]]

for setting in 'ALERT_MODE=bogus' 'ISSUE_TITLE=' 'GH_TOKEN=' 'GITHUB_REPOSITORY=' 'ISSUE_BODY=' \
  $'ISSUE_TITLE=bad\nheader'; do
  reset_logs
  expect_failure "$setting"
  assert_no_mutation
  [[ ! -s "$GH_MOCK_LOG" ]]
done
for url in '' 'http://example.test/run' $'https://example.test/\nheader'; do
  reset_logs
  expect_failure ALERT_MODE=recovery RUN_URL="$url"
  assert_no_mutation
  [[ ! -s "$GH_MOCK_LOG" ]]
done

# A recovery must identify its own run/attempt/workflow/event/branch and
# conservatively defer for same-second or newer issue activity.
for time in '2026-10-12T12:00:00Z' '2026-10-12T13:00:00Z'; do
  reset_logs
  ALERT_MODE=recovery NTFY_TOPIC=test-only GH_MOCK_LIST="${EXACT/2026-10-12T11:00:00Z/$time}" \
    bash "$SCRIPT_DIR/upsert-workflow-failure-issue.sh" > "$TEMP_DIR/output"
  grep -Fq 'Recovery deferred' "$TEMP_DIR/output"
  assert_no_mutation
done
for metadata in ' ' 'null' '{}' 'not-json' "$GH_MOCK_RUN $GH_MOCK_RUN" \
  "${GH_MOCK_RUN/\"id\":123/\"id\":124}" \
  "${GH_MOCK_RUN/\"run_attempt\":1/\"run_attempt\":2}" \
  "${GH_MOCK_RUN/Nightly AI precompute/Other workflow}" \
  "${GH_MOCK_RUN/main/other-branch}" \
  "${GH_MOCK_RUN/schedule/workflow_dispatch}" \
  "${GH_MOCK_RUN/2026-10-12T12:00:00Z/invalid}" \
  "${GH_MOCK_RUN/2026-10-12T12:00:00Z/2026-02-30T12:00:00Z}"; do
  reset_logs
  expect_failure ALERT_MODE=recovery NTFY_TOPIC=test-only GH_MOCK_LIST="$EXACT" GH_MOCK_RUN="$metadata"
  assert_no_mutation
done
for time in 'invalid' '2026-02-30T11:00:00Z'; do
  reset_logs
  expect_failure ALERT_MODE=recovery NTFY_TOPIC=test-only GH_MOCK_LIST="${EXACT/2026-10-12T11:00:00Z/$time}"
  assert_no_mutation
done
reset_logs
expect_failure ALERT_MODE=recovery NTFY_TOPIC=test-only GH_MOCK_LIST="$EXACT" GH_MOCK_RUN_EXIT=1
assert_no_mutation
for setting in 'GITHUB_RUN_ID=' 'GITHUB_RUN_ID=abc' 'GITHUB_RUN_ATTEMPT=' 'GITHUB_RUN_ATTEMPT=0' \
  'GITHUB_WORKFLOW=' 'GITHUB_REF_NAME=' 'GITHUB_EVENT_NAME='; do
  reset_logs
  expect_failure ALERT_MODE=recovery "$setting"
  assert_no_mutation
  [[ ! -s "$GH_MOCK_LOG" ]]
done

# Quotes/backslashes in a legitimate identity are data, never a jq program.
reset_logs
ISSUE_TITLE='Pipeline "quoted" \\ failed' GH_MOCK_LIST='[{"number":7,"title":"Pipeline \"quoted\" \\\\ failed"}]' \
  bash "$SCRIPT_DIR/upsert-workflow-failure-issue.sh"
grep -Fq 'issue comment 7' "$GH_MOCK_LOG"

echo 'upsert-workflow-failure-issue mock tests passed'
