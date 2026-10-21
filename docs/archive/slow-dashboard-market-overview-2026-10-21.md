---
ARCHIVED: 2026-10-21
REASON: The dashboard awaited an optional external market-overview request with an 8-second abort budget before it could render. Its index chips were removed to stop that request from blocking the initial dashboard response.
---

# Dashboard market-overview index chips

The signed-in dashboard no longer requests `/market-overview?sections=brief` during its server render. Before this archive, `app/dashboard/page.tsx` awaited both that request and the stored Hold/Fold movers in `Promise.all`; the market-overview request had an 8-second abort budget. The response supplied the optional market index chips and tone shown above the movers strip in `DashboardCockpit`.

The dashboard keeps its navigation, health banner, daily brief action, top movers, and feature cards. Only the index-chip feature and its upstream request were removed.

The 8-second value is the configured abort ceiling, not a measured user-facing load time. No browser timing trace was available. Removing the optional call guarantees this page render no longer waits on that upstream request; it does not establish a numeric improvement for overall dashboard load time.

Reintroduce market indices only through a non-blocking section with a meaningful fallback and measured initial-load evidence.

Original snapshots:

- `file-archive/dashboard-page-before-market-overview-archive-2026-10-21.tsx`
- `file-archive/DashboardCockpit-before-market-overview-archive-2026-10-21.tsx`
- `file-archive/dashboard-css-before-market-overview-archive-2026-10-21.css`
