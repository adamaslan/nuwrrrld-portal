# NuWrrrld — Pain Point Solutions Explorer

**Date:** 2026-08-12
**Companion to:** the Top 10 Pain Points survey (branch `fix/morph-double-alloc-chaos-preserve-skydome`)
**Format:** 5 candidate approaches per pain point, each with tradeoffs, then a recommendation.

---

## #1 Zero automated tests

### Approach A — Vitest on pure functions first (bottom-up)
Install Vitest, write tests only for the deterministic, zero-DOM modules: `seededRandom.ts`, `buildingGenerator.ts`, `mergeStaticGeometry.ts`, `type-guards.ts`, pool acquire/release accounting.
- **Effort:** ~half a day for setup + first 30 tests.
- **Pros:** zero mocking, instant feedback, locks down exactly the math that keeps regressing.
- **Cons:** doesn't cover the R3F component layer where the visual bugs live.

### Approach B — Snapshot-test the generators' output
For `buildingGenerator` and any procedural placement code, snapshot the full generated output (positions, scales, seeds) as JSON fixtures. Any change to generation logic produces a visible diff.
- **Pros:** catches unintended changes to *any* generated value, not just the ones you thought to assert; near-zero authoring cost.
- **Cons:** noisy when you *intend* to change generation; snapshots need review discipline.

### Approach C — Visual regression via Playwright screenshots
Boot the app headless, wait for scene settle, screenshot at 2–3 fixed camera positions and seeds, compare pixel diffs (Playwright's `toHaveScreenshot` with a threshold).
- **Pros:** the only approach that would have caught "hole in the sky" and clipped-horizon bugs directly.
- **Cons:** WebGL in CI is flaky (software rasterizer differences); needs a deterministic clock/seed injection point; slowest to run.

### Approach D — @react-three/test-renderer for component logic
Use R3F's official test renderer to mount scene components without a real canvas and assert on the scene graph: object counts, positions, material params, pool balance after unmount.
- **Pros:** tests the actual React lifecycle (mount/unmount/remount) where the double-alloc bugs live; no browser needed.
- **Cons:** learning curve; shader output is invisible to it; some drei components need mocking.

### Approach E — Dev-mode invariant assertions instead of tests
Skip a test runner entirely; embed `if (process.env.NODE_ENV !== 'production') assert(...)` checks: pool leak counters on unmount, scene-scale inequalities (#10), texture-size budget.
- **Pros:** zero infra, runs on every dev session, catches issues tests wouldn't (real-usage paths).
- **Cons:** not a substitute for tests — only fires when a human happens to hit the path; no CI signal.

**Recommendation:** A + B immediately (one afternoon), E in the same PR since it costs almost nothing. Add D once the TVScreen split (#2) starts, so the refactor has a harness. C only if sky/camera regressions continue after #10 is fixed — it's the highest-maintenance option.

---

## #2 `TVScreen.tsx` — the 1,909-line god component

### Approach A — Seam-based extraction (mechanical split)
Split along the seams that already exist, in order of independence: `ScreenMedia` (image/video/canvas branches) → `ScreenFrame` (bezel geometry) → `ScreenSidePanel` → `useScreenSelection` hook. Each extraction is a pure move, no behavior change, one PR each.
- **Pros:** lowest risk; each PR is reviewable; git blame survives.
- **Cons:** preserves the existing architecture, warts included; shared state may force prop-drilling.

### Approach B — State-first refactor (extract the hook layer before the JSX)
Pull *all* state and per-frame logic into hooks first (`useScreenMedia`, `useScreenAnimation`, `useScreenSelection`), leaving TVScreen as a dumb layout shell. Split JSX afterwards.
- **Pros:** the hooks become independently testable (pairs with #1D); the JSX split becomes trivial once state is out.
- **Cons:** the intermediate state (one big file, many hooks) briefly looks worse; hook interdependencies must be untangled first.

### Approach C — Strangler pattern with a new `Screen/` directory
Create `components/three/Screen/` with the target structure (`index.tsx`, `Media/`, `Frame.tsx`, `SidePanel.tsx`, `hooks/`). Build the new composition, wire it in behind a feature flag or per-variant, migrate call sites one at a time, delete the old file last.
- **Pros:** old code keeps working throughout; you can A/B the two implementations visually.
- **Cons:** two implementations to maintain during migration; risk of the migration stalling halfway (the classic strangler failure mode).

### Approach D — Data-driven config extraction first
Before touching structure, extract the ~dozens of layout/tuning values (bezel widths, panel offsets, text metrics) into a typed `screenConfig` object. The component shrinks and the remaining code becomes mostly composition.
- **Pros:** compounds with #9; often reveals the natural split boundaries; very low risk.
- **Cons:** only shaves maybe 200–300 lines; doesn't fix the responsibility problem alone.

### Approach E — AI-assisted split with characterization snapshots
Snapshot the rendered scene graph of TVScreen (via test-renderer, #1D) for each media type and selection state *first*, then let an agent perform the split with the snapshots as the contract.
- **Pros:** makes a large mechanical refactor safe to delegate; the snapshots outlive the refactor as regression tests.
- **Cons:** requires #1D infra to exist first; snapshot contract can miss shader/visual behavior.

**Recommendation:** D → B → A, in that order, after #1 lands. Config extraction is free and informative; hooks-first makes the JSX split mechanical; then the seam splits are one-day PRs. Skip C — strangler is overkill for a single file with one call site, and E is just A with better safety gear (use it if delegating the work).

---

## #3 No mobile / low-end performance tier

### Approach A — Static tier detection at mount
One `getQualityTier()` run once: screen size + `navigator.hardwareConcurrency` + `prefers-reduced-motion` + `devicePixelRatio` → `'low' | 'medium' | 'high'`. Clamp `dpr` to `[1, 1.5]` on low/medium, gate Noise + ChromaticAberration to high, drop Bloom's `mipmapBlur` on low.
- **Pros:** simple, predictable, one file; a day of work.
- **Cons:** static heuristics misjudge (an M-series iPad is "mobile" but fast; an old desktop GPU is "desktop" but slow).

### Approach B — Adaptive/reactive quality via drei's `PerformanceMonitor`
Use `<PerformanceMonitor>` (or `AdaptiveDpr`) to measure real frame rate and step quality up/down at runtime: start at medium, promote if sustained 60fps, demote on sag.
- **Pros:** measures ground truth instead of guessing; handles thermal throttling mid-session — the actual failure mode on phones.
- **Cons:** visible quality pops when tier changes; needs hysteresis tuning to avoid oscillation.

### Approach C — GPU benchmark lookup (detect-gpu)
Use the `detect-gpu` library: it fingerprints the GPU via WebGL and returns a benchmarked tier (0–3) from a maintained database.
- **Pros:** far more accurate than CPU-core heuristics; one dependency, one call.
- **Cons:** external dep + fetch of the benchmark data; unknown GPUs fall back to guessing anyway.

### Approach D — User-facing quality toggle
Add a small settings control (fits the existing RemoteControl UI): Low / Medium / High / Auto, persisted in `localStorage`.
- **Pros:** the user is the ultimate judge of "runs well on my device"; trivially debuggable ("set it to Low"); pairs with any auto approach as the Auto default.
- **Cons:** most users never open settings; doesn't fix the *default* experience alone.

### Approach E — Separate mobile scene composition
Branch at the composition level: mobile gets a genuinely reduced scene — fewer decorative animators, no post-processing at all, capped particle counts — rather than the desktop scene with knobs turned down.
- **Pros:** biggest possible win on low-end; honest about what a phone can do.
- **Cons:** two scene graphs to maintain; visual identity diverges; highest effort by far.

**Recommendation:** A as the foundation (ship this week), then layer B on top so `'auto'` self-corrects under thermal throttling, with D as the escape hatch inside RemoteControl. C is a reasonable upgrade to A's heuristic later. Avoid E unless analytics show low-tier devices are a major audience segment — maintenance cost is real.

---

## #4 7.3 MB of unoptimized media, no enforcement

### Approach A — One-time re-encode + prebuild budget gate
Re-encode: JPEGs → WebP/AVIF at actual texture resolution (likely 1024px max for a TV screen texture), MP4 → re-encoded H.264 at lower bitrate + WebM/AV1 variant. Wire the existing `scripts/check-media-size.ts` into `"prebuild"` so the build *fails* over budget.
- **Pros:** the script already exists — this is mostly plumbing; budget becomes enforced, not documented.
- **Cons:** manual re-encode is a one-time fix; next asset added regains the problem until the gate catches it at build time.

### Approach B — Automated asset pipeline (sharp + ffmpeg script)
A `scripts/optimize-media.ts` that ingests originals from `media-src/`, outputs sized/encoded variants to `public/media/`, runs via npm script. Originals never ship.
- **Pros:** repeatable; contributors drop in raw files and the pipeline handles it; guarantees consistent sizing.
- **Cons:** build step complexity; originals need a home (git LFS or excluded dir).

### Approach C — Progressive texture loading (low-res first)
Ship tiny placeholder textures (~10 KB blurred versions) loaded synchronously, swap in full-res via `useTexture` once loaded. Video gets a poster-frame texture until playback starts.
- **Pros:** scene *looks* complete almost immediately regardless of payload; perceived performance win independent of file size.
- **Cons:** doesn't reduce total bytes; texture swap needs care to avoid a visible pop; more state in the already-overloaded TVScreen (#2).

### Approach D — KTX2/Basis compressed GPU textures
Convert images to KTX2 (Basis Universal) and load via `KTX2Loader`. These stay compressed *in GPU memory*, not just over the wire.
- **Pros:** 4–8× GPU memory reduction — directly helps mobile (#3); smaller downloads too; the "correct" answer for a texture-heavy Three.js app.
- **Cons:** tooling (`toktx`/`basisu`) is clunky; loader setup + WASM transcoder adds complexity; overkill for 5 assets.

### Approach E — CDN/service-based optimization (offload it)
Move media to an image/video CDN (Cloudflare Images/Stream, Bunny, etc.) that serves format- and size-negotiated variants per device.
- **Pros:** zero pipeline maintenance; automatic AVIF/WebM negotiation; caching for free.
- **Cons:** external dependency + cost; textures now need CORS config for Three.js; ties a personal project to a paid service.

**Recommendation:** A today — it's an hour of ffmpeg/squoosh plus wiring the existing script into `prebuild`, and probably cuts 7.3 MB to under 2 MB. Add C's poster-frame for the video (cheap, big perceived win). Graduate to B when asset count grows past ~10, and to D only if mobile GPU memory becomes a measured problem. E doesn't fit a project this size.

---

## #5 Documentation sprawl — three competing systems, no README

### Approach A — README as router, archive everything stale
Write one README: what the project is, how to run it, and "docs live in `docs/wiki/` — everything else is historical." Move completed `PHASE_*.md`, `RESOLUTION_FIX_PLAN.md`, `IMAGE_RESOLUTION_ISSUES.md`, `SUMMARY.md`, `trae-summary.md` to `docs/archive/` with `ARCHIVED:` headers.
- **Pros:** one afternoon; respects the archive-never-delete rule; immediately gives newcomers and agents an entry point.
- **Cons:** doesn't merge the three overlapping refactoring docs — sprawl is contained, not resolved.

### Approach B — Consolidate into the wiki as single source of truth
Fold the three `REFACTORING_*` docs into one `docs/wiki/concept-refactoring.md`, migrate anything still-true from root MDs into wiki pages, archive the rest. Root keeps only README.
- **Pros:** ends with one genuinely coherent system; the wiki's SCHEMA and `concept-`/`decision-` naming already fit.
- **Cons:** a real writing/reconciliation task (a day+); risk of losing nuance in the merge.

### Approach C — Docs-as-code with a freshness contract
Add a `status: current | historical` + `last-verified: date` frontmatter field to every doc; a tiny lint script fails CI if a doc references files that no longer exist.
- **Pros:** solves the "is this still true?" problem *permanently*, not just for this cleanup.
- **Cons:** infrastructure for a problem that discipline could solve; frontmatter rots too if nobody updates it.

### Approach D — AGENTS.md-centric consolidation
Since much of this repo is edited by AI agents, make the repo-root AGENTS.md the canonical router: current architecture, invariants (the #10 constraints belong here), where docs live, what's archived. Human README stays minimal.
- **Pros:** targets the actual audience (agents blowing context on stale phase docs); invariants in AGENTS.md get read on every session.
- **Cons:** humans may not think to read AGENTS.md; duplicates README's role if both grow.

### Approach E — Ruthless deletion (git history is the archive)
Delete everything stale outright; git history preserves it.
- **Pros:** cleanest end state; zero archive maintenance.
- **Cons:** violates the project's established archive-never-delete rule; git history is a poor discovery mechanism. Listed for completeness — not viable here.

**Recommendation:** A + D together in one PR (README for humans, AGENTS.md for agents, archive the stale docs), then B for the refactoring-doc merge whenever the #2 refactor starts — merging those three docs is natural prep work for it. Skip C unless doc rot recurs after the cleanup; skip E entirely.

---

## #6 50 uncoordinated `useFrame` callbacks

### Approach A — Single animation driver for decorative motion
One `useFrame` in a `DecorativeAnimator` that iterates a registry of lightweight update functions (flicker, bobbing, rotation). Components register `{ object, update }` on mount, unregister on unmount.
- **Pros:** collapses ~30 of the 50 subscriptions; one place to profile; enables batching and early-out.
- **Cons:** loses R3F's per-component ergonomics; registry lifecycle bugs are possible (pairs well with #7's leak assertions).

### Approach B — useFrame priority + budget instrumentation
Keep the callbacks but assign R3F render priorities, and wrap each in a dev-mode timing shim that logs per-callback cost to a table (`window.__frameBudget`). Enforce the wiki's documented budget with a dev overlay.
- **Pros:** measurement before surgery — reveals which of the 50 actually cost anything; minimal code change.
- **Cons:** instrumentation alone fixes nothing; the shim itself costs a little in dev.

### Approach C — Distance/frustum-based update culling
A shared `useCulledFrame(ref, maxDistance, callback)` hook that checks camera distance (cheap, every N frames) and skips the callback entirely for far or off-screen objects.
- **Pros:** directly implements the survey's "skip work for invisible objects"; scales with scene growth; no architectural upheaval.
- **Cons:** popping if an object animates in from "frozen" state; frustum checks have their own cost if done naively per-frame.

### Approach D — Demote decoration to shader time
Move purely visual motion (flicker, pulse, sway) into vertex/fragment shaders driven by a shared `uTime` uniform — zero JS per frame for those elements.
- **Pros:** the cheapest possible per-frame cost (GPU does it); already the pattern used for the sky dome.
- **Cons:** only works for stateless motion; shader code is harder to author/debug; scatters logic into materials.

### Approach E — Throttled tiers (not every animator needs 60fps)
Run cheap ambient animations at 15–20fps via a frame-skip counter in the shared driver; reserve full-rate updates for camera-proximate or interactive objects.
- **Pros:** big CPU savings with almost invisible quality loss for slow ambient motion; trivial once A exists.
- **Cons:** requires A's registry to implement cleanly; motion at 15fps can look steppy for fast movement.

**Recommendation:** B first (measure — one day, and it validates whether this is even the bottleneck vs. #3's post-processing), then A as the structural fix, with C and E as features *of* the new driver. D opportunistically for flicker/pulse effects when touching those materials anyway.

---

## #7 127 raw `new THREE.*` allocations, 11 `dispose()` calls

### Approach A — Audit + triage spreadsheet, then route through pools
Script a scan (already half-done by the survey) categorizing all 127 sites: (1) module-scope constants — fine, (2) `useMemo` without disposal — leak on unmount, (3) per-frame or per-render — bugs. Fix category 3 immediately, migrate category 2 to pools or add disposal.
- **Pros:** proportionate — many of the 127 are probably fine; effort lands where leaks actually are.
- **Cons:** manual audit is tedious; drifts stale unless backed by enforcement (see D).

### Approach B — `useDisposable` hook as the universal wrapper
A tiny hook: `const geo = useDisposable(() => new THREE.BoxGeometry(...), [])` — `useMemo` semantics plus automatic `.dispose()` on unmount/dep-change. Mechanically replace category-2 sites.
- **Pros:** near-mechanical migration; fixes the leak class without forcing everything into pools; codemod-able.
- **Cons:** doesn't get pooling's reuse benefits; yet another pattern alongside the pools (three ways to allocate).

### Approach C — Full pool discipline (everything routes through GeometryPool/MaterialPool)
Make the pools the only sanctioned allocation path; extend them to cover the missing resource types; forbid raw `new THREE.*` in components.
- **Pros:** one pattern, maximal reuse, the double-alloc bug class disappears by construction.
- **Cons:** pools add indirection for one-off resources that never remount; 696-line MaterialPool suggests the abstraction is already heavy; highest migration cost.

### Approach D — ESLint rule + dev-mode leak counter (enforcement layer)
`no-restricted-syntax` ESLint rule flagging `new THREE.*` inside component bodies (allowlist for module scope and pool internals). Plus a dev-mode `THREE.Object3D` add/remove + pool acquire/release counter that warns on imbalance after unmount.
- **Pros:** stops the bleeding — no new violations regardless of which fix approach is chosen; the leak counter would have caught `ec86e15`'s bug automatically.
- **Cons:** enforcement without migration leaves 127 grandfathered `eslint-disable`s; counter has false positives during HMR.

### Approach E — Lean on R3F's own lifecycle (JSX-declared resources)
Where possible, replace imperative construction with declarative JSX (`<boxGeometry args={...}/>`, `<meshStandardMaterial .../>`) — R3F auto-disposes JSX-declared objects on unmount.
- **Pros:** zero custom infrastructure; idiomatic R3F; disposal is automatic and correct.
- **Cons:** not viable for shared/pooled resources (auto-dispose would kill reuse); some construction is genuinely dynamic.

**Recommendation:** D immediately (enforcement first — it's the only approach that prevents regression during all the other refactors), then A's triage, fixing leaks via E where JSX-declarable, B where dynamic, and pools only where reuse across mounts is real. C is a trap: uniform pool discipline sounds clean but the 696-line MaterialPool is already a complexity warning sign.

---

## #8 Accessibility confined to the RemoteControl

### Approach A — `prefers-reduced-motion` as the first-class fix
One `usePrefersReducedMotion()` hook consumed at three points: disable Noise/ChromaticAberration/flicker entirely, damp ambient animation amplitude to near-zero, disable camera auto-motion. This is the vestibular/photosensitivity fix.
- **Pros:** the single highest-impact a11y change; one hook, three call sites; also a free perf win that overlaps #3's tier logic.
- **Cons:** covers motion sensitivity only — no keyboard or screen-reader progress.

### Approach B — Keyboard selection path via the RemoteControl
Rather than raycasting-by-keyboard (hard in 3D), make the RemoteControl — already the accessible island — the keyboard interface: arrow keys / number keys cycle and select screens, with visible focus indication in-scene (highlight the "focused" TV).
- **Pros:** builds on the six a11y attributes that already exist; a natural interaction model (it's literally a remote control for TVs); avoids solving "keyboard navigation of 3D space."
- **Cons:** in-scene focus indication is new rendering work; still pointer-first for orbit/zoom.

### Approach C — Semantic DOM overlay mirroring the scene
A visually-hidden DOM list (`<nav aria-label="Screens">`) with a button per TV screen, synchronized with scene state. Screen readers and keyboard users interact with the DOM; the scene reflects it.
- **Pros:** the canonical pattern for canvas accessibility — full SR support, not just keyboard; canvas gets proper fallback content too.
- **Cons:** two representations to keep in sync; meaningless if screen content itself (the media) lacks text alternatives.

### Approach D — @react-three/a11y integration
Adopt pmnd's a11y library: wrap interactive meshes in `<A11y role="button" description="...">`, which generates the DOM mirror, focus management, and hover/focus states automatically.
- **Pros:** C's pattern without hand-rolling it; maintained by the R3F team; least custom code for the most coverage.
- **Cons:** another dependency; less control over the announced semantics; some friction with heavily custom interaction code like TVScreen's (worth doing *after* #2's split).

### Approach E — Full audit-driven pass
Run axe + manual VoiceOver/NVDA testing, fix everything found: canvas accessible name, instruction text that mentions keyboard, focus-visible styles, contrast, `aria-live` for selection announcements.
- **Pros:** comprehensive; catches issues the other approaches don't target (contrast, announcements).
- **Cons:** a week+ of work; the audit result on a 3D scene is only as good as the interaction model beneath it — premature before B/C/D exist.

**Recommendation:** A this week — it's a one-hook fix for a genuine health concern and doubles as #3 groundwork. Then B (the RemoteControl-as-keyboard-interface idea fits this app unusually well). D after the TVScreen split gives clean interactive components to wrap. E as the final verification pass, not the starting point.

---

## #9 Magic numbers scattered outside `config/constants.ts`

### Approach A — Sweep-and-centralize into the existing constants file
Grep-driven pass moving every tuning literal (camera, fog, controls, post-processing intensities, dome scale, segment counts) into `config/constants.ts` under namespaced objects (`CAMERA`, `FOG`, `POST`, `SKY`).
- **Pros:** the file and convention already exist; mechanical; makes #10 possible.
- **Cons:** 369 lines becomes 500+; a single giant constants file has its own discoverability problem; not every literal deserves promotion (sphere segments `32, 32` is arguably fine inline).

### Approach B — Co-located config objects per domain
Instead of one file, each domain gets a typed config adjacent to its component: `PostProcessing.config.ts`, `camera.config.ts`. `constants.ts` keeps only cross-cutting values (like `SCENE_SCALE`).
- **Pros:** configs live next to the code that reads them; cross-cutting vs. local is an explicit distinction — which is exactly the #10 lesson.
- **Cons:** splits the "one place to tune" property; needs judgment about what's cross-cutting.

### Approach C — Derived-value functions, not just named constants
The real bug class was *coupled* values, not unnamed ones. Express relationships as derivations: `far: skyDomeScale(SCENE_SCALE) * 1.67`, `maxDistance: SCENE_SCALE * 0.67`. Constants file exports functions of base values.
- **Pros:** attacks the actual failure mode (cc9748f); changing one base value updates everything consistently.
- **Cons:** derivation formulas can obscure intent if overdone ("why 0.67?" needs a comment anyway).

### Approach D — Runtime tuning panel (leva) as the forcing function
Add leva (dev-only) and register every tunable through it. Anything you want on the panel *must* be a named binding — centralization happens as a side effect, and tuning the scene stops requiring code-reload cycles.
- **Pros:** makes tuning delightful (huge for a visual project); naturally discovers which values are actually tuned vs. set-once; dev-only so zero prod cost.
- **Cons:** a dependency and some wiring; leva values still need to be written back to config files by hand.

### Approach E — Lint enforcement against new magic numbers
ESLint `no-magic-numbers` scoped to the scene directories (allowlist 0, 1, 2, 0.5, array indices), so new literals require either a named constant or an explicit disable-with-reason.
- **Pros:** prevents regression permanently; forces the conversation at review time.
- **Cons:** `no-magic-numbers` is notoriously noisy in graphics code (matrix values, colors, easing curves); aggressive config needed or it gets disabled wholesale in frustration.

**Recommendation:** C for the coupled cluster (that's really #10), B for the rest — per-domain configs keep the sweep from bloating `constants.ts`. D is worth it independent of this pain point for a project whose value is visual tuning. Skip E; the noise-to-signal ratio in shader/scene code makes it a team-morale tax.

---

## #10 Camera/dome/fog constraints implicitly coupled

### Approach A — Single `SCENE_SCALE` with derived values + dev assertion
One base constant; derive `skyDome.scale`, `camera.far`, `controls.maxDistance`, `fog.far` from it with the inequalities (`maxDistance < domeScale < cameraFar`, `fogFar ≤ cameraFar`) asserted in a dev-mode `validateSceneScale()` called at scene mount.
- **Pros:** exactly the survey's suggested fix; small, self-documenting, impossible to break silently.
- **Cons:** the derivation ratios themselves are new magic numbers unless commented; assertion only fires at mount, not if values are animated later.

### Approach B — Typed `SceneScaleConfig` with a validating constructor
A `createSceneScale({ base, domeRatio, farRatio, ... })` factory that *throws* (dev) or clamps-and-warns (prod) on invalid relationships, returning a frozen object consumed by Scene, SceneContent, and controls.
- **Pros:** invariants are unrepresentable rather than checked-after-the-fact; the config object is mockable for tests (#1).
- **Cons:** slightly more ceremony than A; clamping in prod can hide a real misconfiguration.

### Approach C — Eliminate the constraint: render the sky on a separate pass
Make the dome immune to the camera-far coupling entirely — render it with `depthWrite: false`, `frustumCulled: false` at infinite-distance semantics (the classic skybox technique: draw first, depth-test off, or use `scene.background` with a cube/equirect texture).
- **Pros:** removes the invariant instead of guarding it — the whole `far: 1200→2000` bug class becomes impossible; camera-centering `useFrame` also goes away.
- **Cons:** the dome uses a custom animated shader, so `scene.background` won't work directly — needs a shader-on-background or renderOrder approach; a real rendering change on the most regression-prone code in the repo (do it *after* tests/screenshots exist).

### Approach D — Runtime watchdog in dev
A dev-only `useFrame` (low priority, every ~60 frames) that re-checks the inequalities against *live* values — catching cases where an animation, leva tweak (#9D), or future feature moves one of them out of range.
- **Pros:** catches dynamic violations A/B miss; near-zero cost at 1Hz.
- **Cons:** dev-only means prod misconfigurations still ship; another dev-mode subsystem to maintain.

### Approach E — Encode the invariant as documentation + wiki page only
Write the promised `concept-scene-scale.md` wiki page with the inequality diagram and rationale; add pointed comments at all four sites cross-referencing it.
- **Pros:** zero code risk; captures the knowledge that currently lives in commit messages.
- **Cons:** documentation doesn't stop the next person — the survey's whole point is that comment-borne knowledge already failed three times.

**Recommendation:** A + E now (an hour: the constant, the assertion, the wiki page — E alone is insufficient but as the *companion* to A it's where the "why" lives). Add D when #9D's leva panel makes runtime tuning possible. C is the architecturally superior endgame — the invariant shouldn't exist — but touch it only after #1's visual snapshots (or at least #1C) can catch a broken sky automatically.

---

## Cross-cutting synthesis

Several approaches reinforce each other — sequencing them right roughly halves the total effort:

| Cluster | Members | Shared payoff |
|---|---|---|
| **Safety net** | #1A/B/E, #7D, #10A | Assertions + pure-function tests + lint enforcement make every later refactor cheap |
| **Perf tier** | #3A/B, #8A, #6B | One quality/reduced-motion system feeds renderer config, post stack, and animation driver |
| **Config discipline** | #9B/C, #10A/B, #2D | Same pattern (typed, derived, per-domain config) applied three places |
| **TVScreen unlock** | #1D → #2B → #8D | Test renderer enables the split; the split enables clean a11y wrapping |

**Week 1:** #1A+B+E, #10A+E, #8A, #4A — all small, all independent, all high-value.
**Week 2:** #3A(+B), #7D + triage start, #5A+D.
**Weeks 3–4:** #2 (D→B→A), #6B→A, #9 sweep alongside whatever files get touched.
**Later, opportunistic:** #10C, #8D, #4D, #6D.
