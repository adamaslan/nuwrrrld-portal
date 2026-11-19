# NWF style guide (implementation reference)

White / black / gray. Square. No dark mode. Border thickness communicates the
importance of the enclosed data. This file is the code-facing contract; it
defines the tokens every stylesheet must consume. What is marked **confirmed**
comes from the product owner (2026-10-31 / 2026-11-01); what is marked
**proposed** is the current implementation choice and may be tuned.

## 1. Principles (confirmed)

- Always white background. No dark mode: `color-scheme: light` only, no
  `prefers-color-scheme: dark` rules.
- Black, white and gray only. No hue anywhere, including badges, charts,
  icons and focus rings.
- Square geometry: `border-radius: 0` on every element. No circles, no pills,
  no rounded avatars.
- No glow, no neon shadows, no decorative gradients.
- Every page is in scope: public pages, sign-in/up, error/404, and every
  signed-in dashboard route, including shared chrome (cookie banner,
  disclaimers, consent modal).

## 2. Border-weight hierarchy (confirmed intent, proposed scale)

Border thickness signals how important the enclosed data is - grounded in
what the element shows, never decorative.

| Token | Value | Use |
|---|---|---|
| `--bw-primary` | 4px | The data the page exists for: the verdict, the live price, the key metric block |
| `--bw-standard` | 2px | Working cards, sections, inputs, primary buttons |
| `--bw-supporting` | 1px | Metadata, dividers, secondary/quiet panels |

Rules:
- Thicker = more primary. A page normally has one primary block.
- Do not outline everything equally; equal weights read as noise.
- Never use border weight to imply financial signal strength or a
  recommendation; it encodes layout importance only.

## 3. Monochrome semantic encodings (proposed)

Direction and status are never carried by color alone. Markup keeps explicit
signed text (`+2.3%` / `-1.1%`, HOLD / FOLD labels); the fill reinforces it.

| Meaning | Encoding |
|---|---|
| Positive / bull / pass | Solid ink fill `--fill-strong` (#111) with white text, or bold ink text |
| Negative / bear / fail | Ghost fill `--fill-ghost` (#fff) with ink text and a `--bw-supporting` ink border |
| Neutral / metadata | `--text-dim` (#555) text |

Legacy token names (`--neon-blue`, `--neon-red`, `--bull`, `--bear`) remain
mapped onto the ink scale so older stylesheets compile; new code uses the
`--fill-*` and `--bw-*` tokens.

## 4. CTA treatment (confirmed intent)

A call to action is a deliberate change in layout and emphasis, not a colored
button. Reference: the MoMA "Get the latest art, events, and special offers /
Email / Subscribe" pattern - a clear invitation line, a distinct form/action
area, and a strong button.

- Invitation: one plain sentence naming what the user gets.
- Action area: visually distinct block - `--bw-standard` border, white or
  `--surface-2` background, square.
- Primary button: solid ink fill, white text, square, `--bw-standard` border.
- Hover/focus: invert (white fill, ink text) or thicken to `--bw-primary`.
- One primary CTA per view; secondary actions are ghost buttons.

## 5. States (proposed)

| State | Spec |
|---|---|
| Hover | Invert fill or thicken border one step; never color |
| Focus-visible | `--bw-standard` solid ink outline, 2px offset (globals.css) |
| Error | Ghost fill, ink border `--bw-standard`, explicit text label; never red-only |
| Disabled | `--text-dim` text, `--bw-supporting` gray border, no fill |
| Loading/skeleton | Gray `--surface-2` blocks, square |

## 6. Responsive (proposed)

- Same tokens at every breakpoint; hierarchy via weight, not size alone.
- Primary block keeps `--bw-primary` on mobile; never shrink below
  `--bw-supporting` for real content borders.
- Touch targets >= 44px; CTAs stack full-width on narrow screens.

## 7. Tokens (proposed values)

Defined in `app/globals.css`:

```
--bg #ffffff   --surface #ffffff   --surface-2 #f5f5f5
--text #111111  --text-dim #555555  --border #111111
--bw-primary 4px  --bw-standard 2px  --bw-supporting 1px
--fill-strong #111111  --fill-ghost #ffffff
```

## 8. Proof criteria (confirmed)

Every route ships with route-by-route proof: a screenshot plus a functional
note per page, covering desktop and mobile-critical views. A route that could
not be tested is marked BLOCKED with the reason - never passed by assumption.
