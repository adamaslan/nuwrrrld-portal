#!/usr/bin/env bash
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${ISSUE_TITLE:?ISSUE_TITLE is required}"
: "${ISSUE_BODY:?ISSUE_BODY is required}"

existing_issue=""
legacy_issue=""
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
    if [[ -z "$existing_issue" ]] || (( number < existing_issue )); then
      existing_issue="$number"
    fi
  elif [[ "$title" == "$ISSUE_TITLE "* ]]; then
    suffix=${title#"$ISSUE_TITLE"}
    if [[ "$suffix" =~ ^\ [0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
      if [[ -z "$legacy_issue" ]] || (( number < legacy_issue )); then
        legacy_issue="$number"
      fi
    fi
  fi
done <<< "$results"
existing_issue=${existing_issue:-$legacy_issue}

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
