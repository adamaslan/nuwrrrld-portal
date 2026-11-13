---
date: 2026-11-13
type: decision
tags: [seo, verdict, sitemap, public-surface, growth]
sources: [../../lib/verdict-seo.ts, ../../app/sitemap.ts, ../../app/verdict/[ticker]/page.tsx, ../../lib/council-db.ts]
---

# Decision: A Verdict Page Is Indexable Only When a Verdict Was Recorded

## Decision

`/verdict/[ticker]` is public and shareable already. It is now also discoverable: the sitemap lists every ticker that has at least one recorded council verdict (capped at 2,000 entries), and each page carries a canonical URL, a title and description built from what was recorded, and `index` or `noindex` depending on whether a verdict exists. A ticker with no recorded verdict renders as before for a direct visitor but is `noindex` and absent from the sitemap.

## Date

2026-11-13

## Context

The page was only reachable through the share card. Search engines had no path to it, and the one acquisition surface that costs nothing per visitor was unused. Making every hydrated ticker indexable would create about two thousand near-identical "no verdict recorded" pages, which searchers cannot use and which dilute the pages that do have content.

## Alternatives considered

- **List the whole ticker universe.** Rejected: thin pages, and it advertises coverage the council does not have.
- **Statically generate every ticker at build.** Rejected: a build would need a database and would go stale between deploys. Hourly revalidation serves the same purpose.
- **Hide the verdict behind sign-up.** Rejected: the page's whole value as an acquisition surface is that the call is visible before sign-up; the depth (history, full reasoning) stays in the app.

## Consequences

Sitemap size tracks the number of tickers the council has actually covered, so it grows with real use. The DB reader is imported lazily in both the sitemap and the page's data path so a build without `DATABASE_URL` still produces the static sitemap entries. The disclaimer modal and footer on the page are unchanged.

> ❓ Open question: whether crawlers index a page whose first paint sits under the disclaimer modal. Server-rendered HTML contains the verdict, but no indexing result has been observed.

## Validated by

Unit tests on the pure helper cover indexability, title and description wording when fields were never recorded, malformed-symbol rejection, de-duplication and the cap. No rendered page, sitemap output or search-console result was checked when this was written.

## See also

- [[entity-ai-council]]
- [[decision-four-field-verdict-scaffold]]
- [[concept-public-surface-audit]]
- [[decision-public-track-record-counts-only]]
