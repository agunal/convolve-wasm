# Stone Visual Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply a broad graphite/embossed visual redesign to the existing Pages app and prevent repository links from breaking again without changing any application behavior.

**Architecture:** Preserve the existing HTML controls, IDs, TypeScript, worker, WASM, and deployment paths. Establish a testable visual contract in Playwright, add a repository-local link validator, repair canonical site links, and replace the demo stylesheet with a responsive stone/material system built only from CSS gradients, borders, and shadows.

**Tech Stack:** HTML, CSS, TypeScript test code, Playwright 1.61, Node.js ESM, GitHub Actions.

## Global Constraints

- Do not modify Rust, DSP, worker, WASM, `CONVOLVE()` API, accepted files, defaults, output format, status flow, playback, or download behavior.
- Preserve local base `/` and GitHub Pages base `/convolve-wasm/`.
- Keep the approved logo files byte-for-byte unchanged.
- Do not add runtime dependencies, remote fonts, analytics, uploads, server processing, or `@ffmpeg/core`.
- Keep all existing IDs and accessible labels.
- Do not merge, tag, publish, or create a release.

---

### Task 1: Guard and repair repository links

**Files:**
- Create: `scripts/validate-repo-links.mjs`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `apps/demo/index.html`
- Modify: `tests/pages/pages.spec.ts`

**Interfaces:**
- Produces root command `npm run validate:links`.
- Validates local Markdown/HTML links and canonical `blob/main` or `tree/main` repository paths against the checkout.
- Site resource links remain four anchors with direct canonical targets.

- [ ] Add a failing Pages assertion requiring package documentation to link directly to `/blob/main/packages/convolve-wasm/README.md` and requiring all four resource links to match canonical URLs.
- [ ] Add `scripts/validate-repo-links.mjs`, root `validate:links` script, and CI step after documentation-image validation.
- [ ] Confirm the new browser assertion fails against the current package-directory link.
- [ ] Replace the package-directory URL with the canonical README URL and keep the other three URLs pinned to existing files.
- [ ] Confirm link validation and Pages assertions pass.
- [ ] Commit as `fix: repair and validate repository links`.

---

### Task 2: Define the visual contract before redesigning

**Files:**
- Modify: `tests/e2e/layout.spec.ts`

**Interfaces:**
- Adds non-pixel visual-contract assertions at desktop, tablet, and phone widths.
- Retains existing no-overflow and stacking checks.

- [ ] Add a desktop test requiring a dark color scheme, a two-column hero, visible logo plaque, dark panel background, and visible/focusable primary action.
- [ ] Extend phone/tablet tests to verify the hero collapses to one column and controls retain at least 44px touch height.
- [ ] Run the browser suite and confirm the visual-contract test fails against the current cream stylesheet.
- [ ] Commit as `test: define stone interface visual contract`.

---

### Task 3: Implement the stone/embossed visual system

**Files:**
- Modify: `apps/demo/index.html`
- Modify: `apps/demo/src/styles.css`

**Interfaces:**
- All existing controls and IDs remain.
- Adds only presentational classes/wrappers where necessary.
- Uses no new image or JavaScript assets.

- [ ] Add presentational hero wrappers and decorative elements with `aria-hidden="true"`; do not move or rename controls.
- [ ] Replace the stylesheet with a dark graphite palette, layered page texture, embossed hero, plaque logo, recessed controls, raised action, engraved links, status colors, and responsive layouts.
- [ ] Ensure focus-visible outlines, native file inputs, audio controls, disabled states, long filenames, and reduced-motion preferences remain usable.
- [ ] Run E2E and Pages tests and confirm the visual contract and all existing functional assertions pass.
- [ ] Commit as `feat: redesign demo with embossed stone interface`.

---

### Task 4: Verify and finalize the pull request

**Files:**
- No production changes expected.

- [ ] Run or observe exact-head CI for documentation images, repository links, Rust formatting/Clippy/tests, WASM, TypeScript, builds, Chromium/WebKit E2E, Pages artifact/subpath tests, package inspection, and FFmpeg absence.
- [ ] Compare branch against current `main`; confirm zero commits behind and only intended paths changed.
- [ ] Open/update the PR with the reference direction, behavior boundaries, red/green evidence, exact head SHA, and CI run ID.
- [ ] Mark ready only after all exact-head checks pass.
- [ ] Stop before merge.
