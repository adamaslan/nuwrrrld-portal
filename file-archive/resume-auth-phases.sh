#!/usr/bin/env bash
# ---
# ARCHIVED: 2026-08-29
# REASON: Its premise — "wait for PR #77 to merge into main" — was resolved by
# merging #77's branch into feat/auth-cookies-phase-1-3-6 directly. Kept per the
# archive-never-delete rule; do not run it.
# ---
# Resume the auth/cookies plan (Phases 1.3 + 6 done; 3-7 blocked on PR #77).
# Full procedure: docs/session-handoff.md. This script only does Step 0-2 and
# reports; the wiring (Step 3+) needs judgment and is left to the session.
set -euo pipefail
cd "$(dirname "$0")/.."

BRANCH=feat/auth-cookies-phase-1-3-6

echo "== fetching =="
git fetch origin --quiet

if git branch -r --contains origin/feat/consent-cookies-tracking 2>/dev/null | grep -q 'origin/main$'; then
  MERGED=1
else
  MERGED=0
fi

echo "== PR #77 (feat/consent-cookies-tracking) merged into main? =="
if [ "$MERGED" = "1" ]; then
  echo "  YES — Phases 3-7 are unblocked."
else
  echo "  NO — still blocked. CI status:"
  gh pr checks 77 2>/dev/null | grep -E 'fail|pass' | head -20 || echo "  (gh unavailable)"
  echo
  echo "  Nothing to do but wait. Optionally push the branch (NO PR):"
  echo "    git push -u origin $BRANCH"
  exit 0
fi

echo "== rebasing $BRANCH onto origin/main =="
git checkout "$BRANCH"
if git rebase origin/main; then
  echo "  clean rebase"
else
  cat <<'EOF'
  CONFLICT — expected in lib/db/schema.sql only (both branches append at EOF).
  Resolution: keep BOTH #77's consent_records / legal_consent_events blocks AND
  this branch's privacy_requests block. Then:
    git add lib/db/schema.sql && git rebase --continue
  Re-run this script after.
EOF
  exit 1
fi

echo "== verify =="
rm -rf .next/types
npx tsc --noEmit
npx eslint .
npx vitest run --project unit
echo
echo "Rebase + checks OK. Now do Steps 3-7 in docs/session-handoff.md:"
echo "  3. wire rate-limit + logPrivacyRequest into #77's export/delete/profile routes"
echo "  4. re-create Phase 3.2/4.1 first-party files (attribution + analytics sink)"
echo "  5. tick docs/todo-auth-cookies-tracking.md boxes for 1.3 + 6"
echo "  6. migrate, push, open ONE PR"
echo "  7. wiki ingest (docs/wiki-portal + gcp3-mobile parity)"
