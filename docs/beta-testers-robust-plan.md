# Beta Testers — A More Robust Grant System (Proposal)

**Status:** PR 1 (read path) implemented; PRs 2–3 pending · **Drafted:** 2026-10-08
**Touches:** `lib/beta-testers.ts`, `lib/subscription-admin.ts`, nulogdash console, mobile `useSubscription`
**Related:** [entity-billing](wiki-portal/entity-billing.md) (PR #119 env-var incident),
[concept-sync-requirements](wiki-portal/concept-sync-requirements.md) (web-Pro / mobile-Free asymmetry)

---

## 1. Problem

Today a beta tester is someone whose verified primary email is in one of two lists:

| Source | Where | To change it |
|---|---|---|
| `BUILT_IN_BETA_TESTERS` | `lib/beta-testers.ts:38` (one entry) | code change → PR → deploy |
| `BETA_TESTER_EMAILS` | env var — **not set** in Vercel production or `.env.local` | Vercel env edit → redeploy, and separately per environment |

This setup has these problems:

1. **Adding a tester needs an engineer.** Both paths need a deploy. The env-var path also has to be repeated in each environment.
2. **It fails silently.** If the env var is missing in an environment, the tester gets nothing there, with no error. This is how PR #119 left the admin reading **Free** in production for two days.
3. **There's no lifecycle.** Grants never expire, there's no record of who granted them or when, and nothing lists the current testers.
4. **Testers are Pro on web and Free on mobile.** Mobile resolves the tier from Clerk metadata through the shared `lib/subscription.ts`. It never sees `resolveTier()`'s overrides.
5. **Grants are keyed by email.** If a tester changes their primary email, their access quietly moves with the email instead of staying with the person.

## 2. Proposal: the grant lives on the Clerk user

Subscription state already lives in Clerk `publicMetadata` (`subscription_status`, read by every dashboard page). A beta grant is the same kind of fact, so put it in the same place:

```jsonc
// user.publicMetadata
{
  "subscription_status": "free",          // unchanged, still Stripe-driven
  "beta": {
    "tier": "pro",
    "grantedAt": "2026-10-08",
    "expiresAt": "2027-01-08",            // optional; null = no expiry
    "grantedBy": "admin",                 // role/label, not an email
    "note": "fall 2026 cohort"
  }
}
```

Why Clerk metadata and not a new Neon table:

| | Clerk `publicMetadata` | Neon `beta_testers` table |
|---|---|---|
| Read cost | none, since `currentUser()` is already loaded on every gated page | one extra query per tier check (async, needs a cache) |
| Who can write | backend secret key only, so users can't edit `publicMetadata` | DB credentials |
| Keyed by | Clerk user ID, so access survives an email change | email, unless we also store the user ID |
| Mobile visibility | mobile already reads this metadata | needs an API round-trip |
| Migration | none | yes, and it's a sensitive surface under `/fixy` §4.3 |
| Per-environment | dev and prod Clerk instances are separate, so each grant is per instance (correct, not a bug) | depends on which branch `DATABASE_URL` points at |
| Querying "all testers" | Clerk users search API, which is slower | one `SELECT` |

The table only wins on bulk querying, and at beta scale (tens of users) the Clerk list API is fine. If the beta grows to hundreds of users, or needs cohorts and invite codes, revisit with a table (§7).

## 3. Resolution order

`resolveTier()` in `lib/subscription-admin.ts` becomes:

```ts
if (isNulogdashAdmin(user)) return 'pro';                 // unchanged
if (hasActiveBetaGrant(user?.publicMetadata)) return 'pro'; // new, primary path
if (isBetaTester(user)) return 'pro';                      // built-in list only, the fail-safe
return tierFromStatus(status);
```

- `hasActiveBetaGrant()` parses `publicMetadata.beta` defensively, the same way `parseSubscriptionMetadata` tolerates malformed input. A grant counts only if `tier === 'pro'` and `expiresAt` is null or in the future.
- **Keep `BUILT_IN_BETA_TESTERS`.** It holds only the owner's own account, so the owner can never lock themselves out. That's the PR #119 lesson, and it still applies.
- **Retire `BETA_TESTER_EMAILS`.** It's unset everywhere, so removing it changes no behavior and removes one silent-failure path. Keep the parser for one release and log at WARN if the var is ever set.
- Keep the verified-primary-email requirement for the built-in path. The metadata path doesn't need it, because a grant is attached to a user ID an admin chose deliberately.

## 4. Granting and revoking

### 4a. Admin console (main path)

Add a **Beta testers** panel to `/dashboard/nulogdash`:

- **List:** every user with `publicMetadata.beta`, showing grant date, expiry and note. Expired grants are greyed out.
- **Grant:** enter an email, look up the Clerk user, and write `beta`. If no account exists, show "ask them to sign up first" instead of failing silently.
- **Revoke:** set `beta` to `null`.
- Put grant and revoke behind the existing `canPerformAdminAction` gate (the self-implemented TOTP). Granting Pro is a mutating admin action.
- Write one row per grant or revoke to the existing admin audit trail, if there is one (otherwise a `console.info` with the user ID, never the email).

### 4b. Script fallback (before the panel exists, or when the panel is down)

`scripts/beta-grant.mjs <email> [--expires YYYY-MM-DD] [--revoke] [--dry-run]`. It uses the Clerk Backend API with `CLERK_SECRET_KEY`, which it reads from the environment and never prints.

Until the script exists, here's the equivalent by hand. **Step 1 — find the user (dev instance, `.env.local` key):**

```bash
cd ~/code/nuwrrrld-portal
set -a; source .env.local; set +a
curl -s -G https://api.clerk.com/v1/users \
  -H "Authorization: Bearer $CLERK_SECRET_KEY" \
  --data-urlencode "email_address=${TESTER_EMAIL:?export TESTER_EMAIL=<the tester's dev-instance email> first}" | jq '.[0].id'
```

Expect a `"user_..."` ID. `null` means they haven't signed up on this instance yet.

**Step 2 — grant (deep-merges, so it doesn't touch `subscription_status`):**

```bash
USER_ID=$(curl -s -G https://api.clerk.com/v1/users \
  -H "Authorization: Bearer $CLERK_SECRET_KEY" \
  --data-urlencode "email_address=${TESTER_EMAIL:?export TESTER_EMAIL=<the tester's dev-instance email> first}" | jq -r '.[0].id')
curl -s -X PATCH "https://api.clerk.com/v1/users/$USER_ID/metadata" \
  -H "Authorization: Bearer $CLERK_SECRET_KEY" -H "Content-Type: application/json" \
  -d "{\"public_metadata\":{\"beta\":{\"tier\":\"pro\",\"grantedAt\":\"$(date +%F)\",\"expiresAt\":null,\"grantedBy\":\"admin\"}}}" \
  | jq '.public_metadata.beta'
```

**Step 3 — verify:**

```bash
curl -s "https://api.clerk.com/v1/users/$USER_ID" \
  -H "Authorization: Bearer $CLERK_SECRET_KEY" | jq '.public_metadata'
```

> **Production:** the production `CLERK_SECRET_KEY` exists only in Vercel, not in `.env.local`, so these commands only reach the dev instance. Grant in production through the console panel (§4a), or 🖱 **Dashboard:** https://dashboard.clerk.com → production instance → Users → the user → Metadata → Public.

## 5. Mobile parity

This removes the web-Pro / mobile-Free asymmetry with no allowlist in the client:

- **Option A (smallest):** mobile `useSubscription` adds the same `hasActiveBetaGrant()` check. The metadata is already on the Clerk user that mobile reads. Put the parser in a new shared, byte-identical module (`lib/beta-grant.ts`), **not** in `lib/subscription.ts`, so that file's byte-identity contract stays untouched.
- **Option B:** mobile reads `GET /api/stripe/subscription`, which already returns the override-aware tier. That's the fix `concept-sync-requirements` already recommends. It also covers admins, but it's a bigger change.

Recommendation: A now, since it's cheap and pure, and B when the admin asymmetry is worked on.

## 6. Rollout

1. **PR 1, read path:** `hasActiveBetaGrant()` with unit tests (active, expired, malformed, missing), wired into `resolveTier()`, plus a WARN if `BETA_TESTER_EMAILS` is set. With no grants yet, nothing changes.
2. **Grant the first testers** with §4b against dev, then in production through the dashboard. Check that `/dashboard/signals` shows Pro features for them.
3. **PR 2, console panel:** list, grant and revoke behind the TOTP gate. Add `scripts/beta-grant.mjs`.
4. **PR 3, mobile (`gcp3-mobile`):** shared `lib/beta-grant.ts` and the `useSubscription` check (§5A). Refresh the parity wiki pages in both repos.
5. **Cleanup:** remove the `BETA_TESTER_EMAILS` parser one release after PR 1.

## 7. When to move to a table instead

Switch to a Neon `beta_grants` table (user ID, email at grant time, tier, granted/expires/revoked timestamps, granted_by, cohort) if any of these happen:

- the beta passes about 200 users, or we need cohort reporting,
- invite codes or self-serve signup ("join the beta") are added,
- grants need history: who had access when, not just who has it now.

Even then, have the table **write through** to `publicMetadata.beta`, so the read path in §3 stays a synchronous, zero-query check.

## 8. Non-goals and guardrails

- A beta grant is **never** admin. It doesn't touch `NULOGDASH_ADMIN_EMAILS` or the console gate. The two systems stay separate on purpose (see the `lib/beta-testers.ts` header).
- Billing pages (`/dashboard/billing`, `/dashboard/upgrade`) keep showing real Stripe state. A tester still sees "Free" there, matching the admin precedent.
- No tester emails in wiki pages or caveat entries. Refer to testers by role ("beta cohort, 3 users").

## 9. Open questions for the owner

1. Should grants expire by default (for example 90 days), or stay open-ended?
2. Should a tester who later subscribes through Stripe keep the grant record, or have it cleared on the `checkout.session.completed` webhook?
3. Is Option A (mobile parses metadata) acceptable, or should mobile wait for Option B?
