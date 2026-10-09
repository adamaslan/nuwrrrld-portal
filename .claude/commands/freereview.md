# /freereview [PR] — Free-model PR review (preview first, post only on a yes)

Reviews a PR with verified-$0 OpenRouter models. Read
`docs/free-model-pr-review.md` for the design. Output is unverified triage, not
a replacement for CodeRabbit.

1. **Preflight.** `cd` to the repo, run `gh auth status`, and confirm
   `grep -cE '^OPENROUTER_API_KEY=.+' .env.local` prints `1`. Never print the key.
2. **Tools first.** `npx tsc --noEmit` and `npx eslint` on the PR's changed `.ts/.tsx` files.
3. **Golden check** (skip if run in the last day):
   `node scripts/review/eval.mjs` — stop if a model's recall is below 0.5.
4. **Review.** Source the key from `.env.local` without printing it, then
   `gh pr diff <PR> | node scripts/free-pr-review.mjs | tee <scratchpad>/free-review-pr<PR>.json`.
   Exit `2` or `3` means the free-ness check stopped the run — report it, don't retry blindly.
5. **Report** the tally, `verifyTally`, `skipped`, `truncated` and `served`. If
   `unanswered > 0` or any file was truncated, say the review is **partial**.
6. **Preview** the inline comments (doc §5 Step 6a). Findings with
   `verdict: "false"` or `anchored: false` are never posted. `secret` findings
   get a generic comment with no quote.
7. **Post only after the user says yes** (doc §5 Step 6b). Event is always `COMMENT`.
