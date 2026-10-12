#!/usr/bin/env bash
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${ISSUE_TITLE:?ISSUE_TITLE is required}"
: "${ISSUE_BODY:?ISSUE_BODY is required}"

existing_issue=""
results=$(
  gh issue list \
    --repo "$GITHUB_REPOSITORY" \
    --label "pipeline-failure" \
    --state open \
    --search "\"${ISSUE_TITLE}\" in:title" \
    --limit 100 \
    --json number,title \
    --template '{{range .}}{{.number}}{{"\t"}}{{.title}}{{"\n"}}{{end}}'
)
while IFS=$'\t' read -r number title; do
  if [[ "$title" == "$ISSUE_TITLE" ]]; then
    existing_issue="$number"
    break
  fi
done <<< "$results"

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
fi
