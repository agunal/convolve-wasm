# Conservative Visual Cleanup Design

**Status:** Approved by the owner through “A.DO.”

## Goal

Repair broken repository image references and polish the existing GitHub Pages interface without changing the public API, audio pipeline, project identity, or deployment architecture.

## Findings

- `packages/convolve-wasm/README.md` points its logo at the nonexistent `v0.1.0` Git ref, so GitHub returns 404.
- The site uses fixed logo and panel dimensions plus a single narrow breakpoint. Native file controls, the two-column control grid, result actions, long resource links, and the large hero can crowd or overflow on phone and tablet widths.
- Existing browser tests prove audio behavior and Pages subpath loading, but they do not explicitly guard against horizontal overflow or broken documentation image targets.

## Design

### Documentation assets

Keep the canonical logo files unchanged. Replace the package README’s nonexistent tag URL with the canonical raw `main` asset URL so the image works on GitHub and on the eventual npm package page. Add a repository-local validator that scans Markdown/HTML image references, resolves local paths and canonical raw-GitHub paths to files in the checkout, and fails on missing repository assets or references to nonexistent release tags.

### Website polish

Preserve the cream, charcoal, and orange editorial style. Make targeted CSS-only improvements wherever possible:

- use fluid logo, heading, shell, and panel dimensions;
- add `min-width: 0` and overflow-safe treatment to grid children, native file controls, audio controls, and long links;
- move the two-column grids and result actions to a single column before they become cramped;
- stack the render action at narrow widths;
- improve touch-target sizing, text wrapping, and WebKit backdrop-filter support;
- keep every existing control, label, link, section, and behavior.

No layout framework, font download, JavaScript UI dependency, animation system, color redesign, or component rewrite is introduced.

### Regression coverage

Add Playwright layout tests at representative phone and tablet viewports. Each test loads the real demo, selects long-filename fixtures, verifies the logo loads, checks that key controls remain visible, and asserts that the document has no horizontal overflow. Keep all existing functional convolution and Pages-subpath tests unchanged.

Add the documentation-asset validator to root scripts and CI so broken GitHub images cannot regress.

## Constraints

- Preserve `CONVOLVE()` signatures, stable errors, processing order, output format, and worker/WASM asset behavior.
- Preserve `/` for local development and `/convolve-wasm/` for Pages.
- Keep all processing browser-local and keep `@ffmpeg/core` absent.
- Do not add, replace, regenerate, or stylistically alter the approved logo.
- Do not merge, tag, publish, create a release, or modify registry settings.
- Stop at a verified pull request.

## Acceptance criteria

- Every repository-owned image reference validated by the new script resolves to an existing file.
- The package README logo renders without relying on an absent tag.
- Phone and tablet browser tests report no horizontal overflow with long filenames.
- Existing Rust, WASM, TypeScript, package, local E2E, Pages artifact, and Pages subpath tests remain green.
- The final diff is limited to documentation asset repair, responsive CSS, regression tests, validation wiring, and the approved spec/plan.