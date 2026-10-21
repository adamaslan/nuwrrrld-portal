---
date: 2026-10-21
type: decision
tags: [performance, dashboard, portfolio, market-data, graceful-degradation]
sources: [../../app/dashboard/page.tsx, ../../app/dashboard/portfolio/page.tsx, ../../app/portfolio-intelligence/page.tsx, ../../docs/archive/slow-dashboard-market-overview-2026-10-21.md, ../../docs/archive/slow-industry-previews-2026-10-21.md]
---

# Decision — Remove optional market previews from blocking renders

## Decision

Remove the signed-in dashboard's market-index chips and the optional industry
gainers/laggards previews from the portfolio and portfolio-intelligence pages.
Their server-render paths no longer request `/market-overview` or
`/industry-intel` for those optional sections.

## Date

2026-10-21

## Context

The requests were optional presentation data but were awaited before the pages
could render. Their 7–8 second abort settings described maximum wait budgets,
not measured user-facing latency. Removing these requests eliminates their
contribution to blocking server-render latency, but no browser timing trace was
captured to quantify the total page improvement.

## Alternatives considered

- Keep the previews with the existing abort budgets: retains optional content
  while allowing a slow or unavailable upstream to delay rendering.
- Reintroduce them as independently loaded sections with explicit stale/failure
  states and timing evidence: preserves the content without making it a render
  dependency; this can be reconsidered when measured.

## Consequences

- Dashboard index chips and the industry gainers/laggards previews are no longer
  shown on these surfaces.
- Dashboard navigation, health banner, movers, portfolio watchlist, scoring,
  optimizer, and portfolio-intelligence marketing content remain.
- No numeric load-time claim is established. The historical portal/mobile
  parity matrix was not recomputed; mobile behavior was not changed.
- Archived source snapshots are retained under `file-archive/`, with scope
  notes in `docs/archive/`.

## Validated by

Source-path inspection in the archive change; browser performance measurement
and production behavior remain unverified.

## See also

- [[concept-cache-then-degrade]]
- [[concept-mobile-web-parity]]
- [[entity-portfolio-intelligence]]
