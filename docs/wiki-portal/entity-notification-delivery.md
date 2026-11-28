---
date: 2026-11-28
type: entity
tags: [email, notifications, resend, retries]
sources: [../../lib/notify/email.ts, ../../lib/notify/idempotency.ts, ../../app/api/retention/digest-email/route.ts, ../../app/api/retention/trial-nudge/route.ts, ../../app/api/launch/remind/route.ts, PR#460]
---

# Email notification delivery

## What it is

The portal's server-side email seam selects a configured delivery provider for
the retention digest, trial nudge, and launch reminder routes. On providers that
document idempotency support, each send now carries a SHA-256 key derived from
the normalized recipient, message kind, and UTC calendar date. Resend retains
keys for 24 hours, so this reduces duplicate delivery when the same send is
retried within that window; it is not a durable exactly-once record.

The key is omitted for providers that do not advertise support. In particular,
Brevo's single-send endpoint has no documented repeat-safe key, so this change
makes no repeat-safety claim for that fallback.

## Where used

- `app/api/retention/digest-email/route.ts` sends one user's weekly digest.
- `app/api/retention/trial-nudge/route.ts` sends a trial-ending reminder.
- `app/api/launch/remind/route.ts` sends individually addressed launch reminders.
- `lib/notify/email.ts` defines provider capabilities; `lib/notify/idempotency.ts`
  builds the recipient-scoped, message-scoped, date-scoped key.

## Known failures

- A provider timeout or connection error can leave delivery status unknown.
- Provider idempotency retention is time-limited and does not replace durable
  send-state storage.
- Brevo's single-send path does not document repeat-safe idempotency.

## Open questions

- If these sends need protection across provider retention windows, should they
  gain a durable per-recipient send record?

## See also

- [[overview]] — portal system map and documented areas
- [[concept-mobile-web-parity]] — cross-surface feature scope
