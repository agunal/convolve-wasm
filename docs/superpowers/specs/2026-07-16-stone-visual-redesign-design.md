# Stone Visual Redesign Design

**Status:** Approved by the owner through the supplied visual reference and explicit “DO.”

## Goal

Rebuild the GitHub Pages interface around the supplied dark embossed convolve-wasm artwork while preserving every application behavior, public API contract, worker/WASM path, Pages base path, and audio-processing invariant.

## Visual direction

The reference image is treated as a material and lighting guide rather than copied into the page. The interface uses graphite, slate, gunmetal, and muted mineral highlights. Surfaces feel carved, pressed, or inset through layered gradients and paired light/dark shadows. The existing logo becomes a plaque inside the hero. Subtle CSS-only arcs and scan lines evoke the reference waveform and carved background without adding a new image asset.

The page remains readable and functional rather than becoming a decorative mockup. Text contrast, focus visibility, touch targets, responsive stacking, and native audio/file control usability remain mandatory.

## Layout

- Keep the existing single-page sequence and all existing controls.
- Turn the hero into a two-column monolithic header on wide screens: logo plaque on the left, title and description on the right.
- Render input, effects, run, result, and About regions as distinct embossed slabs with consistent edge lighting.
- Use recessed wells for file inputs, numeric inputs, selects, the reverse option, and output audio.
- Use a raised metallic primary action and engraved secondary links.
- Stack cleanly at existing tablet and phone breakpoints with no horizontal overflow.

## Link repair and validation

- Replace the site’s package-directory link with a direct canonical link to `packages/convolve-wasm/README.md`.
- Keep browser-support and release-note links pinned to existing files on `main`.
- Add a repository-link validator that checks local Markdown/HTML links and `github.com/agunal/convolve-wasm/blob|tree/main/...` targets against the checkout.
- Keep the existing documentation-image validator.
- Add browser assertions for the four project-resource URLs.

## Behavior boundary

No changes to `apps/demo/src/main.ts`, package runtime code, Rust, WASM, worker loading, accepted file types, option defaults, status semantics, output naming, playback, download behavior, Pages deployment, or privacy boundary.

## Regression coverage

- Existing functional and Pages tests remain unchanged.
- Responsive tests continue to check phone/tablet containment.
- Add visual-contract assertions for dark color scheme, hero grid behavior, readable controls, and canonical links without pixel snapshots.
- Run the complete existing CI workflow before marking the PR ready.

## Acceptance criteria

- The site visibly reflects the supplied graphite/embossed reference at desktop, tablet, and phone widths.
- No document horizontal overflow occurs with long filenames.
- All repository-owned images and internal/canonical repository links validate.
- All four site resource links point to existing canonical targets.
- Every existing Rust, WASM, TypeScript, package, E2E, Pages, and dependency-boundary gate passes.
- The final work stops at an open, ready, mergeable PR; it does not merge, tag, publish, or release.
