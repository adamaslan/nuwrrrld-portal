# TODO — attribution.ts cross-surface sync: remaining follow-ups

Context: mobile PR #39 (`adamaslan/gcp-expo1`) merged 2026-09-01 (`a8a8e92`),
mirroring `lib/shared/attribution.ts` into `gcp3-mobile` and reconciling the
mobile parity wiki. Portal PR #81 had already landed `attribution.ts` +
`parseTouch` hardening on portal `main`. These are the pieces still open.

## 1. Portal drift-guard `PAIRS` entry — HIGH, trivial, do first

`scripts/check-shared-drift.mjs` on portal `main` still lacks the
`attribution.ts` pair. The mobile side already has it (merged in #39). Both
copies are byte-identical on their respective `main` branches, so this is a
one-line add with zero risk of a red gate.

```js
// scripts/check-shared-drift.mjs — PAIRS array
{ path: "lib/shared/attribution.ts", normalize: null },
```

- [ ] Add the line on a small branch off `origin/main`, open a PR, merge.
- [ ] After merge, confirm `shared-drift-check` is green on both repos (it
      compares against the other repo's default branch — both now carry the file).

## 2. Portal parity-page wording — LOW, cosmetic

`docs/wiki-portal/concept-mobile-web-parity.md` headline reads
"…`attribution.ts` mirrored to mobile" — written ahead of the fact by an
earlier session. **It is now true** as of mobile PR #39. No edit strictly
required; if touching the page for another ingest, drop the "(pending)" framing
if any remains and cite mobile PR #39 as the mirror.

- [ ] Fold into the next `docs/wiki-portal/` ingest rather than its own PR.

## 3. Mobile attribution-capture path — MEDIUM, real feature work

`lib/shared/attribution.ts` is adopted on mobile but **unconsumed** — nothing
builds or persists a touch there. To close the Attribution matrix row from
🟡 Partial to ✅ Synced, `gcp3-mobile` needs:

- [ ] A client call on first authenticated load that POSTs the launch URL's
      query params + the referrer equivalent to a mobile endpoint
      (mirrors the portal's `AttributionCapture` component + `/api/attribution`).
- [ ] A mobile backend route to receive it and write the `user_attribution`
      row (or a decision that mobile attribution capture stays deferred).
- Tracked in `gcp3-mobile/docs/wiki-mobile/concept-sync-requirements.md`
  priority #8.

## 4. Mobile consent adoption — HIGH (compliance), separate track

Not attribution, but the same sync batch surfaced it. `consent.ts` /
`legal-consent.ts` are portal-only; `gcp3-mobile` runs `analytics.ts` +
`sentry.ts` with no consent gate. GDPR/CPRA bind the app too.

- [ ] Adopt `lib/shared/consent.ts` + `legal-consent.ts` into `gcp3-mobile`
      (portable now — only the `prefs.ts` storage seam) and gate the two
      trackers behind them.
- Tracked in `gcp3-mobile/docs/wiki-mobile/concept-sync-requirements.md`
  priority #7 (#1 by ROI).

## 5. Mobile DSAR path — MEDIUM (compliance)

Portal PR #78 shipped `/api/privacy/{export,profile,delete,rectify}` +
`privacy_requests` ledger web-only. Same account has no mechanism on mobile.

- [ ] Build a mobile DSAR path, or record a decision that DSAR is handled
      web-only for app users (with a link surfaced in-app).
- Tracked in `gcp3-mobile/docs/wiki-mobile/concept-sync-requirements.md`
  priority #9.

---

Parity headline after this batch: **~62%** (both wikis agree). Items 3–5 are
what would move it back up.
