#!/usr/bin/env bash
# POST to a portal route with Modal-equivalent retries; print the final HTTP status.
#
#   STATUS=$(bash .github/scripts/portal-post.sh <out-file> <url> [extra curl args...])
#
# Policy matches modal-backend's JOB_RETRIES: 3 attempts, 10 s first delay,
# x2 backoff, 60 s cap. It retries ONLY failures where the request cannot have
# run on the server: DNS/connect errors (curl 6, 7) and HTTP 429/502/503.
# A timeout, 500 or 504 can mean the route is still running or already ran,
# and these routes write state, so those return immediately for the caller to
# fail on. The caller still decides what a non-2xx status means.
set -uo pipefail

out=$1 url=$2
shift 2
attempts=${RETRY_ATTEMPTS:-3}
delay=${RETRY_INITIAL_DELAY:-10}

for (( i = 1; ; i++ )); do
  status=$(curl -sS -o "$out" -w '%{http_code}' -X POST "$url" "$@")
  rc=$?
  retryable=false
  case "$rc" in 6|7) retryable=true ;; esac
  case "$status" in 429|502|503) retryable=true ;; esac
  if [[ $retryable == false || $i -ge $attempts ]]; then
    echo "${status:-000}"
    exit 0
  fi
  echo "::warning::POST ${url%%\?*} attempt $i/$attempts failed (curl=$rc http=${status:-none}); retrying in ${delay}s" >&2
  sleep "$delay"
  delay=$(( delay * 2 > 60 ? 60 : delay * 2 ))
done
