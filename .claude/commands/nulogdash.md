# /nulogdash — Feature-Level End-to-End Sweep

Runs every user-facing feature in `docs/nulogdash-inventory.json` against
the running local dev server (tier 1: authenticated API calls, not a
browser pass — see `docs/nulogdash-dashboard-plan.md`), classifies each as
`pass` / `fail` / `blocked` / `not_run`, and writes the result to
`.nulogdash/latest.json` so `app/dashboard/nulogdash` can render it.

Unlike `/local-check` (which only verifies the stack is *reachable*), this
actually calls `/api/holdfold`, `/api/nuai`, the Stripe checkout route,
etc., with a real session, and — critically — reports which features it
did *not* exercise this pass rather than staying silent about them.

Takes no required arguments; `/nulogdash --feature <slug>` runs a single
feature from the inventory (see the `slug` field in
`docs/nulogdash-inventory.json`) for fast iteration while debugging one
check.

## Preconditions

- `next dev` must be running (`npm run dev`) — the sweep hits
  `http://localhost:3000` by default (override with `NULOGDASH_BASE_URL`).
- `.env.local` needs the same keys `/local-check` checks (Neon, OpenRouter,
  Stripe, GCP backend). Run `/local-check` first if unsure.
- `NULOGDASH_SESSION_COOKIE` should be set in `.env.local` to a real Clerk
  `__session` cookie value for a dedicated test user (copy from browser
  devtools after signing in as that user). Without it, every auth-required
  feature reports `blocked`, not silently skipped — that's intentional, but
  it means most of the sweep won't actually run.
- `NULOGDASH_ADMIN_EMAILS` (comma-separated) gates who can view
  `/dashboard/nulogdash` — set it to your own email to see the page at all.

## Execute

```bash
# 1. Regenerate the feature inventory from app/api/** and check for drift
#    (a route added/removed without updating scripts/nulogdash-inventory.mjs)
npm run nulogdash:inventory

# 2. Run the sweep (chains the inventory step; pass through any $ARGUMENTS)
node --env-file=.env.local scripts/nulogdash.mjs $ARGUMENTS
```

If `$ARGUMENTS` is empty, run the full sweep. If the user passes
`--feature <slug>`, that flag is forwarded as-is.

## Report

Summarize as: pass/fail/blocked/not_run counts, the headline "N of M
features not run end-to-end this pass" line the script prints, and any
inventory drift warnings. For failures, show the redacted `reason` field
from `.nulogdash/latest.json` rather than re-running the request. Point to
`/dashboard/nulogdash` (after starting `next dev` if it isn't already
running) for the full matrix rather than dumping the whole JSON file into
the response. Do not paste raw `reason` text if it looks like it might
contain unredacted request/response bodies beyond what the script already
truncated — summarize instead.
