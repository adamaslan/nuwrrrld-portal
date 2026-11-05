# TEST 01 — MoMA-inspired homepage experiment

**Status: exploratory test. Visual approval is pending. Do not merge or deploy this as an approved design.**

This draft PR asks for feedback on a possible direction. Sharing it does not mean the designer has approved its appearance, copy, color choices, layout or functionality. Adam should review it as an experiment, not a production handoff.

## What to review

- Headline scale and left-aligned typography.
- Whitespace, strong section rules and square geometry.
- Council graphic and larger product specimen.
- Simplified navigation and beginner/active-market paths.

Please leave feedback as **keep / change / discard**. These areas are open decisions, including the blue/cream palette and headline copy.

## How Adam can open the test

Download `preview.html` from this folder and open it in a browser. That single file includes its styles and interactions; no installation, Vercel, database, account or credentials are needed. The GitHub file view shows source; download the file to view the rendered page.

For editing, use `index.html`, `style.css` and `script.js`. Open `index.html` with its sibling files present, or serve this folder locally.

## What works in the experiment

Navigation anchors, mobile menu, audience tabs, expandable feature rows and Design notes. Signup buttons show a test-only explanation. No account is created and no data is submitted.

## Relationship to the application

Based on the `feat/prelogin-redesign` branch for PR #324. All changes are contained in `design-preview/`; this folder is separate from the application's actual homepage and routes. Existing libraries, integrations, authentication, payments, database access, consent and feature flags are unchanged. All displayed research data and the chart are illustrative.

This experiment requires a later, separately reviewed integration into the React/Next.js pages before it can affect the real site. Merging this folder alone does not restyle the application.

## Approval and next steps

- [ ] Designer reviews this test and records keep/change/discard feedback.
- [ ] Adam reviews feasibility and integration constraints.
- [ ] Revise or discard the test based on feedback.
- [ ] Obtain explicit visual approval of a specific revision.
- [ ] Prepare a separate implementation PR using existing app components and services.
- [ ] Verify app behavior, accessibility, mobile layout and existing checks.
- [ ] Adam makes the production merge/release decision.

The draft PR targets the redesign branch, not `main`. Do not enable auto-merge or mark this ready for production based on the existence of the test.
