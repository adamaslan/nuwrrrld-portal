---
date: 2026-09-06
type: concept
tags: [accessibility, css, landing, contrast, specificity]
sources: [../../app/landing.css, ../../components/landing/CouncilScrollDebate.tsx, PR#113]
---

# Concept: Contrast Is a Property of the Composite, Not the Token

A color token that passes WCAG on its own can still render unreadable, because
what the eye receives is the token **after** every opacity in the stack has
multiplied it against the background. The landing page shipped text at 2.00:1
using a token measured at 4.12:1, and nothing in the stylesheet made that
visible.

This page records the two ways that happened, because both are invisible to
review-by-reading and both recur.

## The pattern

### 1. The token was never measured against its own background

`--dim: #747267` reads as a plausible "muted gray" next to `--muted: #aba89e`
and `--ink: #f7f3ea`, and the three form a clean visual ladder. But on the
landing's `--bg: #08090c` it measures **4.12:1**, and on `--panel` composited
over that background, **3.88:1** — both under the 4.5:1 AA floor for normal
text. It was used in ten places (hero subtext, footer, signal-matrix column
headers, `.label`, `.statusbar`, input placeholders, risk footer, the debate
ticker, the debate label), so one unmeasured token produced ten failures.

The rule: **a palette ladder is a design judgment; a contrast ratio is a
measurement.** Looking right relative to its siblings tells you nothing about
whether a token clears the floor against the surface it lands on. Measure each
token against every background it is actually painted on — for this palette,
`--bg` and `--panel`-over-`--bg` are different numbers.

### 2. Opacity multiplies, and nobody measures the product

[[entity-ai-council]]'s landing demo (`CouncilScrollDebate`) is a
scrollytelling reveal: each seat's line sits at `opacity: 0.18` until scrolled
past, `0.55` once revealed, `1` while active. The seat labels used `--dim`.

Neither value is wrong on its own. Their **product** is: `--dim` at 0.55
composites to **2.00:1**, well below the threshold at which text reads as text
rather than as a smudge. The reveal animation was authored as a motion
concern and the color as a palette concern, and the failure lives only in
their intersection — which is exactly the seam no single reviewer owns.

The rule: **any element carrying a non-1 opacity has a different effective
contrast than its declared color**, and the reveal's *dimmed-but-shown* state
is the one that must clear the floor, not the fully-active state. Compute
`bg + α·(fg − bg)` and measure that.

A deliberately-pending state (not yet scrolled to) may sit below the floor —
it is signaling "not yet", not presenting text — but it should be far enough
above the background to read as pending rather than as a rendering bug. 0.18
was not; 0.35 is.

### 3. A media query does not add specificity

The same component carried a `prefers-reduced-motion` reset that never once
applied:

```css
.nwf-landing .council-debate-line.is-revealed { opacity: 0.55; }   /* 3 classes */

@media (prefers-reduced-motion: reduce) {
  .nwf-landing .council-debate-line { opacity: 1; }                /* 2 classes */
}
```

Wrapping a rule in `@media` changes *when* it is considered, never how
strongly it competes. The two-class selector loses to the three-class one
regardless of source order, so reduced-motion users — who are served the
fully-expanded static list precisely because they cannot scroll-drive the
reveal — had every line pinned at the dimmed opacity forever, with none ever
reaching the active state.

This is the sharp edge of accessibility fallbacks generally: **the fallback
path is the one nobody looks at**, so a fallback that silently does nothing is
indistinguishable from one that works. The reset has to match the specificity
of what it is overriding, and the non-animated render deserves its own
unconditional rule rather than relying on a media query to rescue it.

## Where it appears

- `app/landing.css` — the `--dim` token and every one of its ten consumers;
  the `.council-debate-line` reveal states and their reduced-motion reset.
- `components/landing/CouncilScrollDebate.tsx` — the scroll-driven reveal that
  supplies the opacity half of failure #2, and the `--static` branch that
  failure #3 rendered permanently dim.
- The same shape is latent anywhere a reveal/fade wrapper ([[concept-graceful-degradation]]'s
  `Reveal` component and the `.seat-card` grid both animate opacity) wraps text
  colored from the low end of the palette.

## Contradictions / tensions

- **Scrollytelling wants a wide dynamic range; accessibility caps the bottom
  of it.** The dramatic effect of the debate reveal comes from how faint the
  un-reached lines are. Raising the floor to keep them legible-as-pending
  costs some of that drama. The resolution taken here is that the *revealed*
  state must clear AA unconditionally, while the *pending* state is allowed to
  sit below it — the compromise lands on the state the user is actually
  reading, not the one they are scrolling toward.
- **Fixing the token vs. fixing the call sites.** Raising `--dim` itself
  repaired all ten consumers in one edit, but it also slightly compresses the
  gap between `--dim` and `--muted`. The alternative — leaving the token and
  patching each site — would have preserved the ladder and left the next
  consumer of `--dim` to reintroduce the bug. The token was the root cause, so
  the token moved.
- **No automated gate exists.** Nothing in CI measures contrast; both failures
  were found by a human saying the text was invisible. [[entity-playwright-e2e]]
  could assert computed contrast on a handful of landing selectors, which would
  catch the token regression but not necessarily the opacity product unless the
  assertion reads the composited pixel rather than the declared style.

> ❓ Open question: is `--dim`'s new value (5.82:1 on `--bg`) the right target,
> or should the landing adopt a single documented floor — e.g. every text token
> ≥ 4.5:1 on both `--bg` and `--panel`, every non-1 opacity state ≥ 4.5:1
> composited — enforced by a checked-in script rather than by measurement at
> review time?

## See also

- [[entity-ai-council]] — the debate demo whose labels surfaced this
- [[concept-public-surface-audit]] — the same methodological shape: a property
  everyone assumed held, which no read of the code could confirm or deny, and
  which had to be *measured* to be known
- [[entity-playwright-e2e]] — where a contrast gate would live if one is added
- [[concept-mobile-web-parity]] — why this is portal-only (React Native has no
  CSS cascade, no media queries, and no `--dim`)
