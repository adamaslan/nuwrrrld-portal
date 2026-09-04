# TODO — Demote "Market snapshot", promote confluence score + explanation

**Status:** proposed, not started
**Date:** 2026-09-02
**Owner:** unassigned

## The question being answered

> "Market snapshot loading" — is it even needed? It's not a core feature.
> Confluence score + explanation is. And maybe that doesn't even have to be live.

Answer, short version: **no, the live market snapshot is not needed**, and
**yes, the confluence score can be served from a cached/precomputed read
instead of a live fetch.** Both changes remove a synchronous third-party
dependency from the render path of pages whose value doesn't come from it.

## What exists today

| Surface | File | What it does | Live dependency |
|---|---|---|---|
| Landing hero phone mockup | [app/page.tsx:198-234](../app/page.tsx#L198-L234) | Renders S&P/QQQ/DIA/IWM prices, or the literal `"Market snapshot loading…"` string when `indices.SPY` is absent | `GET {MCP}/market-overview`, 5s abort, 3600s revalidate |
| Dashboard cockpit chips | [app/dashboard/page.tsx:28-35](../app/dashboard/page.tsx#L28-L35) | Index chips + market tone | same endpoint, 8s abort, 900s revalidate |
| Brief API | [app/api/brief/route.ts:39](../app/api/brief/route.ts#L39) | `/market-overview?sections=brief` | same endpoint |

The confluence score itself is **not** part of `/market-overview`. It arrives on
the `/signals` payload as `confluence_score` per ticker and is consumed in
[lib/digest.ts:107](../lib/digest.ts#L107) and
[lib/shared/signal-policy.ts:53](../lib/shared/signal-policy.ts#L53). The two
are already independent fetches — which is what makes this cheap to separate.

## Why "Market snapshot loading…" is the wrong thing to fix

The string is a *fallback*, not a loading state. It renders whenever
`indices.SPY == null` — i.e. when the MCP call failed, timed out at 5s, or
returned a shape without SPY. Because `app/page.tsx` is a server component,
there is no client-side retry: the phrase "loading…" is a lie to the visitor
and it never resolves. Note the sibling panel already does this correctly —
the signals phone falls back to sample data with an honest
`"Sample data — live backend unavailable"` tag ([app/page.tsx:257](../app/page.tsx#L257)).

So the real defect is: **a non-core decoration can degrade the hero of the
landing page, and does so dishonestly.**

## Recommended plan

Three tiers. Do Tier 1 now; Tier 2 is the actual answer to the question;
Tier 3 only if the score genuinely never needs to be fresh.

### Tier 1 — Stop the bleeding (small, safe, do first)

- [ ] Replace the `"Market snapshot loading…"` branch in
      [app/page.tsx:229-233](../app/page.tsx#L229-L233) with **static
      representative numbers** plus the same honest
      `sample-data-tag` treatment the signals panel already uses. The hero is
      a product mockup; a mockup with plausible static numbers is strictly
      better than a mockup admitting it is broken.
- [ ] Remove the `<span className="pill">Live</span>` badge from that panel
      when the data is not live — never label sample data "Live".
- [ ] Drop the landing page's `/market-overview` fetch from the
      `Promise.allSettled` in `fetchLandingData()`
      ([app/page.tsx:88-95](../app/page.tsx#L88-L95)) once the panel is static.
      This removes one 5s-worst-case dependency from the marketing page's TTFB.

**Effect:** landing page no longer depends on MCP at all for the hero, and
never shows a broken-looking panel.

### Tier 2 — Make confluence score the promoted, non-live surface

The score's value is *interpretive*, not tick-by-tick. A confluence reading
computed at market close is as useful at 2pm as one computed at 1:59pm — the
underlying multi-signal agreement doesn't meaningfully change intraday for the
audience this serves.

- [ ] Decide the freshness contract and **write it in the UI**, e.g.
      `"Confluence as of 2026-09-02 16:00 ET"`. A stated staleness is honest;
      an unstated one is the same bug as "loading…".
- [ ] Persist the scored signal set on ingest rather than fetching per-render.
      The write path already exists — hydrate-universe
      ([app/api/pipeline/hydrate-universe/route.ts](../app/api/pipeline/hydrate-universe/route.ts))
      — so this is a read-path change, not new infrastructure.
- [ ] Serve the landing/dashboard confluence display from that persisted copy.
      Target: no MCP call on the render path of any page a logged-out visitor
      can reach.
- [ ] Keep `cacheTtlMinutes()`
      ([lib/shared/signal-policy.ts:52](../lib/shared/signal-policy.ts#L52))
      as the refresh cadence for the *background* job. Its volatility-aware
      tiering (5min hot / 15 default / 30 quiet) is the right policy for a
      writer; it was never a good policy for a blocking read.
- [ ] Give the **explanation** equal weight to the number in the layout. A bare
      score is not the product; the reason for the score is. Whatever real
      estate the snapshot panel vacates should go here.

**Effect:** the core feature becomes fast and always-available; the number and
its explanation survive an MCP outage entirely.

### Tier 3 — Retire `/market-overview` from the portal (only if Tier 1+2 land)

- [ ] Audit whether the dashboard cockpit's index chips
      ([app/dashboard/page.tsx:28](../app/dashboard/page.tsx#L28)) earn their
      8-second worst-case blocking fetch for a signed-in user. If they're
      context-setting garnish, move them behind a client component that
      streams in after paint, or cut them.
- [ ] `app/api/brief/route.ts` is a separate consumer — decide independently;
      an explicitly-requested brief endpoint is a legitimate live call in a way
      a decorative hero panel is not.
- [ ] If no consumer remains, delete the `MCP_URL` market-overview constant and
      its interfaces from both page files.

## What NOT to do

- **Don't add a client-side retry/spinner** to the hero panel. That preserves
  the dependency and adds a loading state to a page that should have none.
- **Don't make the landing page dynamic** to get fresher numbers. It is a
  marketing surface; static wins.
- **Don't couple confluence to `/market-overview`.** They're separate endpoints
  today; keeping them separate is what allows the snapshot to be deleted
  without touching the score.

## Verification

- [ ] Landing page renders correctly with `MCP_BACKEND_URL` pointed at an
      unreachable host — no "loading…" text, no empty panels.
- [ ] Landing page TTFB with MCP unreachable ≈ TTFB with MCP healthy
      (proves the dependency is off the render path).
- [ ] Confluence score + explanation render with the backend down.
- [ ] Existing tests in `__tests__` covering `adaptLiveSignals` still pass;
      add one asserting the landing fallback contains no "Live" pill.

## Open questions for the owner

1. What is the acceptable staleness for the confluence score — close-of-day,
   hourly, or 15 minutes? This decides whether Tier 2 needs a scheduled job or
   can ride on the existing hydrate cadence.
2. Should logged-in dashboard users get a *fresher* score than logged-out
   visitors? A two-tier freshness policy is defensible but doubles the paths.
