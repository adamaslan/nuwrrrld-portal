# Public editorial design implementation

Prepared 2026-11-05 against PR324 head f6c66157f6d0e7c5d170e1b4fc291c1c5e803afd, then reconciled to f5f33c995831e548be0c053b5c93b3cf73178720 (import-only advance) and its latest docs/pr-324-moma-design-review.md. Reconciled locally onto main 92b15edb863319b55fdf63cb4b577c6c1b6b3c31 after PR324 squash merge. Separate implementation branch: fix/pr-324-design-review-2026-11-05. This work did not change PR330.

## Implemented

- Shared public tokens, left-aligned display hierarchy, gutters, rules and square monochrome surfaces. Existing black/white/gray direction preserved rather than assuming approval of a proposed accent.
- Dominant, explicitly illustrative homepage research example. Desktop side-by-side composition and compact-width reordering put it in the opening viewport. Supporting copy retained below the panel on phones; one primary action remains above it. No invented live data or return claim.
- Illustrated reading guides on Signals, Portfolio Intelligence, Nu AI, Paper Trading and Track Record, labeled as guides rather than live product results.
- Numbered feature rows; shrinkable two-audience paths and directory rows without inline fixed minimum widths.
- Equivalent desktop/mobile destinations, grouped secondary navigation, active states and visible keyboard focus. Compact header covers intermediate tablet widths.
- Pricing remains a comparison with unchanged prices, entitlement/trial copy and checkout implementation.
- Public authentication shells and empty/filled verdict layouts. Clerk, legal-consent and data behavior unchanged.
- Existing reviewed missing-import fix is now upstream in PR324; no duplicate import change in this branch. Homepage data loading and streaming remain in place; the prior topSignals phone display is deliberately replaced by the illustrative example, not preserved as a live visual. No dashboard, feature-flag, schema, production configuration or PR330 planning edits.
- Supplemental illustrative signal matrix is a semantic table, recomposed into labeled rows on phones without dropping values.

## Local verification

Own lockfile installed with npm ci --ignore-scripts --no-audit --no-fund. No environment file, credentials, build, migration or service calls used for layout fixtures.

- Full npm test passed: 1189 unit tests, 9 unit skips; 30 market-gate tests; 132 component tests.
- Full npm run lint passed.
- TypeScript has 17 existing errors, byte-identical to the separately installed main baseline. This is not a clean typecheck and may still block a hosted build.
- Actual source-rendered local fixtures checked at 1440, 768, 390 and 320px: home, five feature routes, pricing, sign-in, sign-up, empty and filled public verdict. Auth/data/provider/checkout behavior was mocked and is not proved by these renders.
- Pixel checks caught and fixed centered inherited hero alignment, tablet menu stretch, residual inline300px grids, table caption reflow and a low-contrast matrix header.
- Automated axe WCAG2/2.1A/AA checks of the public subtree pass on all11fixtures at1440/320px after fixing one low-contrast example caption. Ambiguous ARIA labels received group roles. Three short step-number contrast checks manually verified after changing the old6%-opacity ink to solid#666 on white (5.74:1). Fixture checkout button labels corrected in the renderer; no checkout behavior changed.
- Reflow-equivalent CSS widths640/320px (1280px at200%/400%) pass all11fixtures with root clipping disabled. This is not an actual browser-zoom claim; a CSS zoom probe does not change viewport media queries and was discarded as a proxy.
- Clipping-disabled320px checks show no element overflow on all11fixtures. Native keyboard menu activation and visible focus were exercised at1440/1000/900/768/390/320px.

## Still required before sign-off

- Current main has a versioned direct Next build command for preview and production, bypassing the npm prebuild migration hook. The old preview-only wrapper proposal is obsolete and not applied. Ordinary new-PR CI still has remote DB test effects; PR324's exception does not transfer. Resolve that coverage/effect decision before publication.
- New draft PR and latest-head hosted preview. No push or deployment has occurred during local preparation.
- Actual hydration/client navigation, real auth widget/consent, provider loading/error and feature-flag states.
- Hosted keyboard, contrast, reduced-motion and browser zoom review; remaining real-browser accessibility checks.
- Independent review and Adam's preview approval before merge, as the requested design-review checklist states. No merge or production release is authorized by this note.

A source-rendered fixture is layout evidence only, not deployment, account, data or end-to-end proof.

## Current-main reconciliation (18:39 EST)

Main-only updates did not overlap any saved design edits. All 21 design files remain local and unpublished. Targeted 8 component tests and scoped ESLint pass on main92b15ed. Landed deployment safeguards are preserved without alteration. This is not a hosted new-design build result.

## Publication and live evidence

Adam approved SQLite-only parity and skipping live database tests for this separate design PR at 18:59 EST. The branch-specific exception retains lint, unit and offline checks, and the versioned direct Next build bypasses the migration hook. The exception does not cover other PRs or a later merge. No merge is requested before preview/design review. Actual deployed mobile interactions, navigation, console/network capture and screenshots are now the next required evidence. No live evidence is claimed by the earlier source-rendered fixtures.
