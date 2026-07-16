# Footer and Icon System Design

**Status:** Approved by the owner.

## Goal

Replace the minimal privacy-only footer with a structured utility footer and introduce a restrained inline-SVG icon language across the existing stone interface without changing application behavior.

## Footer structure

The footer is one engraved slate surface with four responsibilities:

1. **Brand and trust** — `Convolve WASM`, the existing browser-local privacy statement, and `No uploads · No analytics · No server processing`.
2. **Project navigation** — GitHub repository, package documentation, browser support, and report-an-issue links.
3. **Owner identity** — plain text `Built by @takana.gg` plus a separate Bluesky icon link to `https://bsky.app/profile/takana.gg`.
4. **Project metadata** — `MIT licensed · Rust + WebAssembly`.

The project resource links move out of the About panel so navigation is not duplicated. Desktop uses a compact multi-column layout; phone layouts stack sections and retain minimum 44px interactive targets.

## Owner and Bluesky behavior

- `@takana.gg` is plain text and is not a link.
- The Bluesky icon is a separate link.
- Accessible label: `@takana.gg on Bluesky`.
- The link opens in a new tab and uses `rel="noreferrer"`.

## Icon language

Use a single hidden inline SVG symbol sprite in `apps/demo/index.html`. Every visible icon is a small `<svg class="ui-icon" aria-hidden="true">` referencing that sprite. Icons use `currentColor`, consistent geometry, and no external package, font, CDN, request, or generated asset.

Icons are added only where they improve scanning or clarify an action:

- hero property badges;
- Audio A and Audio B labels;
- beat pan, pan transition, reverse crossfade, and true-peak labels;
- append reverse;
- render and download actions;
- About-card headings;
- footer project links and Bluesky.

Icons remain decorative whenever visible text already names the control. The icon-only Bluesky link carries its own accessible label.

## Visual treatment

The footer and icons extend the existing graphite/embossed interface. Icons appear engraved in labels and raised inside actionable controls. The footer uses the existing slate palette, recessed borders, and metallic edge lighting. No new color theme or competing illustration is introduced.

## Constraints

- Preserve all existing form control IDs, names, values, defaults, labels, and behavior.
- Preserve `CONVOLVE()` behavior, TypeScript runtime, Rust DSP, worker/WASM loading, playback, download, and output format.
- Preserve local base `/` and Pages base `/convolve-wasm/`.
- Preserve the approved logo files byte-for-byte.
- Keep audio browser-local and keep `@ffmpeg/core` absent.
- Add no runtime dependency, remote font, icon package, analytics, upload, or network request.
- Do not merge, tag, publish, or create a release.

## Acceptance criteria

- The About panel contains architecture content but no project-resource navigation.
- The footer contains four valid project links, the trust statement, project metadata, plain-text `@takana.gg`, and the Bluesky icon link.
- The Bluesky link has the exact URL and accessible label, opens in a new tab, and uses `rel="noreferrer"`.
- Existing interactive controls and selected informational elements display consistent inline-SVG icons.
- Phone and tablet layouts have no horizontal overflow and footer links remain at least 44px high.
- Documentation-image and repository-link validators remain green.
- Existing Rust, WASM, TypeScript, local E2E, Pages, package, and FFmpeg-absence gates remain green.
