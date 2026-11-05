# PR #324 — MoMA-inspired redesign review

Reviewed: 2026-11-05  
PR: https://github.com/adamaslan/nuwrrrld-portal/pull/324  
Reviewed head: `2babdc755f3ac461d2c55571e70994d95a99cf2f`  
Design reference: https://www.moma.org/

## Goal

Make the pre-login experience feel like an editorial institution: confident typography, generous space, strong alignment, prominent visual content and clear navigation. Use MoMA's visual approach as a reference while retaining NuWrrrld's own identity and financial-product content.

This document proposes design work only. It does not change application code, pricing, access tiers, feature flags or production configuration.

## Review scope and preview status

Reviewed PR metadata, comments, current-head checks, selected source files and MoMA's live homepage. MoMA's mobile homepage was visually inspected: a bold black wordmark in a white header, a contrasting Tickets action, edge-to-edge imagery and left-aligned headings and copy.

The PR's current-head Vercel status is failure:
https://vercel.com/adam-aslans-projects/nuwrrrld-portal/J74pBAkAV8qNnxDvHvJBaWcGwYYQ

The Vercel PR comment also reports an error and supplies no working preview link:
https://github.com/adamaslan/nuwrrrld-portal/pull/324#issuecomment-6547142672

The PR timeline also includes earlier successful deployments. Opening the earlier preview at https://nuwrrrld-portal-ogt1xkt27-adam-aslans-projects.vercel.app redirected to Vercel login; it was not visually reviewed. It must not be treated as the current head.

Therefore this is a source-based design review with a visually inspected reference, not visual approval of the PR. GitHub test/E2E checks passing does not establish that the deployment succeeds.

A prior review reports a missing `getAggregateTrackRecord` import. Current `app/page.tsx:26` calls it, and the import block at lines 1–20 does not import it. Restore the deployment in a separate implementation step and verify a preview for the reviewed commit before design sign-off. No local database credentials are required to inspect a working hosted preview.

## What is already in place

- Shared public navigation/footer through `components/landing/PreLoginShell.tsx`.
- Grounded feature copy and distinct free-account versus Pro messaging.
- Monochrome, square-corner styling already added in `app/landing.css:1402–1451`.

The next step is composition and hierarchy, not another grayscale pass.

## Recommended changes, in order

### 1. Give public pages one editorial layout

**Evidence:** `app/landing-pages.css:7–8` keeps feature heroes centered at 2.4rem, while `app/landing.css:1428` left-aligns the homepage hero.

Use a consistent left edge for navigation, headlines, supporting copy and section labels. Create a clear display/headline/body/caption type scale. Allow major headlines to occupy substantial space without crowding their supporting text. Use deliberate section spacing rather than uniform stacks of similar cards.

For the homepage, start with one clear promise, a primary signup action and one dominant product visual. For feature pages, pair a strong proposition with an actual product example.

### 2. Make the product the visual centerpiece

MoMA gives visual content substantial space. Translate that principle into a large, legible council verdict, signal view or portfolio example. Use real interface captures or a clearly labeled illustrative example.

Prefer one dominant visual per section, with a short title and caption. Avoid a dense collage of tiny unreadable interface panels. Keep stored-data timestamps, sample labels and empty states truthful. Do not use MoMA's logo or artwork as NuWrrrld assets.

### 3. Replace repetitive feature boxes with varied editorial sections

**Evidence:** `app/landing-pages.css:14–18` repeats an equal-weight boxed feature grid.

Use a mix of large feature panels, numbered rows and sections separated by rules. Let the main capability receive more space than supporting details. Keep pricing a comparison structure; avoid forcing every page into the same grid.

### 4. Refine the shared navigation

**Evidence:** `components/landing/PreLoginShell.tsx:18–42` contains eight desktop destinations; Paper trading appears only on mobile.

Group secondary destinations and make the primary action visually distinct. Give desktop and mobile users equivalent destinations. Preserve active-page states, keyboard access and visible focus. Check that the header remains legible and compact at narrow widths.

### 5. Rework the two audience paths

**Evidence:** `components/landing/TwoAudiences.tsx:19–35` uses inline card styles and a `minmax(300px, 1fr)` grid.

Keep the beginner and active-trader paths, but lead with short, direct headings and shorter supporting text. Use a spacious typographic split with clear links. Move layout into scoped CSS and ensure columns can shrink on small screens; the current minimum width is a mobile overflow risk, not a confirmed browser defect.

### 6. Consolidate the visual system

**Evidence:** `app/landing.css:1416` uses a late universal grayscale override and `!important` rules over earlier colorful styling.

Define intentional public-page tokens for background, ink, muted text, borders, spacing and accent. Style components directly. Remove superseded rules as part of the implementation so future changes do not depend on competing overrides.

A restrained accent for actions or section panels is a proposed direction; MoMA-inspired does not require everything to be grayscale.

## Preserve from this PR

- Accurate free versus Pro entitlement and trial copy; existing prices and terms.
- Nu AI's documented grounding and product limitations.
- Stored-data descriptions, public-verdict context and honest sample/empty/error states.
- Existing data-loading and streaming behavior.
- Reduced-motion support, semantic headings, contrast and keyboard focus.
- Adam's held decisions, including feature flags, /launch and Schwab messaging.

## Design acceptance checklist

- [ ] A successful deployment exists for the latest PR commit.
- [ ] Capture the homepage, Signals, Portfolio Intelligence, AI Assistant, Pricing, sign-in/sign-up shell and public verdict at desktop and mobile widths.
- [ ] Check representative widths of 1440, 768 and 390px, plus no horizontal overflow at 320px.
- [ ] The first screen communicates the product, one primary action and one clear visual focal point.
- [ ] Public pages share a consistent grid, type hierarchy, navigation and footer.
- [ ] Product examples remain readable on mobile and accurately labeled.
- [ ] Both audience paths and all navigation links work by keyboard.
- [ ] Contrast, visible focus, reduced motion and zoom/reflow remain usable.
- [ ] Existing lint and relevant component/E2E checks pass after implementation.
- [ ] Adam reviews the preview and approves before merge.

## Suggested implementation sequence

1. Restore the failed preview and capture the current baseline.
2. Establish shared public typography, spacing and layout tokens.
3. Redesign the homepage around the dominant product visual.
4. Apply the system to feature and pricing pages, then the authentication and verdict shells.
5. Review responsive screenshots and accessibility, then request Adam's approval.

## References

- MoMA homepage: https://www.moma.org/
- PR scope and held decisions: https://github.com/adamaslan/nuwrrrld-portal/pull/324
- Prior build review: https://github.com/adamaslan/nuwrrrld-portal/pull/324#issuecomment-6640858109

