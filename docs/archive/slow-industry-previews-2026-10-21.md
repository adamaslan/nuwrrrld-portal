---
ARCHIVED: 2026-10-21
REASON: Optional industry-performance previews blocked server rendering behind upstream market-data requests with 7- and 8-second abort budgets. The route content and portfolio tools remain available without those previews.
---

# Slow industry-performance previews

The industry gainers/laggards preview was removed from two active render paths:

- `/dashboard/portfolio` waited for `/industry-intel` (up to 7 seconds) alongside the watchlist read before rendering. The watchlist, portfolio score, and optimizer tools remain active.
- `/portfolio-intelligence` waited for `/industry-intel` (up to 8 seconds) before returning its marketing page. The hero, feature descriptions, and calls to action remain active.

These are configured abort budgets, not measured user-facing load times. The endpoint response may arrive sooner, including from the one-hour server cache; no browser trace was available in this environment. Removing the optional previews means neither page now waits for that endpoint.

The original source snapshots are preserved in `file-archive/`:

- `portfolio-page-before-industry-preview-archive-2026-10-21.tsx`
- `PortfolioClient-before-industry-preview-archive-2026-10-21.tsx`
- `portfolio-css-before-industry-preview-archive-2026-10-21.css`
- `portfolio-intelligence-page-before-industry-preview-archive-2026-10-21.tsx`
