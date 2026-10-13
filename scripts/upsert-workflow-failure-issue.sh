#!/usr/bin/env bash
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${ISSUE_TITLE:?ISSUE_TITLE is required}"
mode="${ALERT_MODE:-failure}"
case "$mode" in
  failure) : "${ISSUE_BODY:?ISSUE_BODY is required}" ;;
  recovery)
    : "${RUN_URL:?RUN_URL is required for recovery}"
    : "${GITHUB_RUN_ID:?GITHUB_RUN_ID is required for recovery}"
    : "${GITHUB_RUN_ATTEMPT:?GITHUB_RUN_ATTEMPT is required for recovery}"
    : "${GITHUB_WORKFLOW:?GITHUB_WORKFLOW is required for recovery}"
    : "${GITHUB_REF_NAME:?GITHUB_REF_NAME is required for recovery}"
    : "${GITHUB_EVENT_NAME:?GITHUB_EVENT_NAME is required for recovery}"
    if [[ ! "$GITHUB_RUN_ID" =~ ^[1-9][0-9]*$ || ! "$GITHUB_RUN_ATTEMPT" =~ ^[1-9][0-9]*$ ]]; then
      echo 'Recovery run identity must contain positive integers' >&2
      exit 2
    fi
    ;;
  *) echo 'ALERT_MODE must be failure or recovery' >&2; exit 2 ;;
esac
if [[ "$ISSUE_TITLE" == *$'\n'* || "$ISSUE_TITLE" == *$'\r'* || "$ISSUE_TITLE" == *$'\t'* ]]; then
  echo 'ISSUE_TITLE must be a single line' >&2
  exit 2
fi
if [[ "$mode" == recovery ]]; then
  if [[ ! "${RUN_URL:-}" =~ ^https://[^[:space:]]+$ ]]; then
    echo 'RUN_URL must be an HTTPS URL without whitespace' >&2
    exit 2
  fi
fi

# Push is optional and best-effort, after the authoritative issue mutation.
notify_phone() {
  local message="$1" priority="$2" tags="$3"
  [[ -n "${NTFY_TOPIC:-}" ]] || return 0
  if [[ ! "$NTFY_TOPIC" =~ ^[A-Za-z0-9_-]+$ || ! "${RUN_URL:-}" =~ ^https://[^[:space:]]+$ ]]; then
    echo '::warning::ntfy skipped: invalid topic or run URL'
    return 0
  fi
  curl --silent --fail --max-time 10 --request POST \
    --header "Title: ${ISSUE_TITLE}" --header "Priority: ${priority}" \
    --header "Tags: ${tags}" --data-binary "$message" \
    "https://ntfy.sh/${NTFY_TOPIC}" >/dev/null 2>&1 || \
    echo '::warning::ntfy delivery failed'
}

existing_issue=""
results=$(
  gh issue list \
    --repo "$GITHUB_REPOSITORY" \
    --label "pipeline-failure" \
    --state open \
    --search "\"${ISSUE_TITLE}\" in:title" \
    --limit 100 \
    --json number,title,updatedAt
)
# Reject malformed API data rather than treating it as an empty lookup.
existing_issue=$(jq -ser --arg title "$ISSUE_TITLE" '
  if length != 1 then error("expected one JSON result") else .[0] end |
  if type != "array" then error("expected issue array")
  elif all(.[]; (.number | type == "number") and (.number > 0) and
      (.number == (.number | floor)) and (.title | type == "string")) then
    ([.[] | select(.title == $title) | .number] | min) as $exact |
    ([.[] | select(.title | startswith($title + " ")) |
      select(.title[($title | length + 1):] | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}$")) | .number] | min) as $legacy |
    ($exact // $legacy // "")
  else error("invalid issue lookup") end
' <<< "$results")

if [[ "$mode" == recovery ]]; then
  [[ -n "$existing_issue" ]] || exit 0
  # Workflow concurrency serializes mutations but queued runs are not FIFO.
  # Never let an older successful run close an issue changed by a newer run.
  run_metadata=$(gh api "repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}")
  started_at=$(jq -ser --arg id "$GITHUB_RUN_ID" --arg attempt "$GITHUB_RUN_ATTEMPT" \
    --arg workflow "$GITHUB_WORKFLOW" --arg branch "$GITHUB_REF_NAME" --arg event "$GITHUB_EVENT_NAME" '
    if length != 1 then error("expected one run result") else .[0] end |
    if (.id | tostring) != $id or (.run_attempt | tostring) != $attempt or
      .name != $workflow or .head_branch != $branch or .event != $event then
      error("recovery run identity mismatch")
    else .run_started_at end |
    if type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$") and
      ((fromdateiso8601 | todateiso8601) == .)
    then . else error("invalid run start time") end
  ' <<< "$run_metadata")
  updated_at=$(jq -er --argjson number "$existing_issue" '
    .[] | select(.number == $number) | .updatedAt |
    if type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$") and
      ((fromdateiso8601 | todateiso8601) == .)
    then . else error("invalid issue update time") end
  ' <<< "$results")
  if [[ "$updated_at" > "$started_at" || "$updated_at" == "$started_at" ]]; then
    echo 'Recovery deferred: issue activity is not older than this run'
    exit 0
  fi
  gh issue close "$existing_issue" --repo "$GITHUB_REPOSITORY" \
    --reason completed --comment "Recovered: ${RUN_URL}"
  notify_phone "Recovered: ${RUN_URL}" default white_check_mark
  exit 0
fi

if [[ -n "$existing_issue" ]]; then
  gh issue comment "$existing_issue" \
    --repo "$GITHUB_REPOSITORY" \
    --body "Failed again:

${ISSUE_BODY}"
else
  gh issue create \
    --repo "$GITHUB_REPOSITORY" \
    --title "$ISSUE_TITLE" \
    --body "$ISSUE_BODY" \
    --label "pipeline-failure"
  notify_phone "First failure: ${RUN_URL:-}" high rotating_light
fi
