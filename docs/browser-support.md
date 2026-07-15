# Browser and codec support

## Supported boundary

The release target is current desktop Chrome/Edge and Safari.

- WAV is the automated portability baseline.
- M4A is passed to `decodeAudioData()` and depends on codecs exposed by the browser and operating system.
- Firefox M4A behavior is best effort and platform dependent.
- A decode failure returns `DECODE_FAILED`; there is no upload, server fallback, or bundled FFmpeg decoder.
- Processing is single-threaded WASM in a dedicated worker and does not require `SharedArrayBuffer`, COOP, or COEP headers.

The real-world input that shaped the decoder decision was identified during planning as stereo, 48 kHz HE-AAC in an M4A container. A pure Rust AAC-LC-only decoder would not reliably cover that profile, so v1 uses the native browser media stack.

## Automated WAV validation

Local-container evidence and GitHub Actions evidence are recorded separately. Browser availability in one environment does not describe what ran in another.

### Local-container record

Validation recorded on 2026-07-14:

| Browser/runtime | OS | Result | Coverage |
|---|---|---:|---|
| Chromium 150.0.7871.114 | Debian 13 | Pass | PCM24/48 kHz/stereo header, full convolution length, five-millisecond reverse overlap, 120 BPM beat metadata, playable/downloadable Blob, no page errors |
| Playwright WebKit | Local container | Not run | The WebKit binary was unavailable and the environment could not resolve `cdn.playwright.dev` to install it |

The WebKit row is a historical limitation of that local container. It is not a statement that the repository's WebKit CI gate failed or was skipped.

### GitHub Actions record

The authoritative pre-merge integration run for PR #1 was GitHub Actions run `29374482569` on 2026-07-14. Its `verify` job completed successfully on Ubuntu 24.04.4 (`ubuntu-24.04`) and validated the PR merge ref that was subsequently squash-merged into `main`.

| Runner/browser gate | Result | Coverage |
|---|---:|---|
| Chrome via `wasm-pack test --headless --chrome` | Pass | Generated-WASM browser smoke tests |
| Playwright Chromium | Pass | WAV demo E2E suite |
| Playwright WebKit | Pass | The same WAV demo E2E specifications used for Chromium |

That run also passed Rust formatting, linting and tests, the WASM build, TypeScript/package tests, the library and demo build, package inspection, and the `@ffmpeg/core` absence check.

GitHub CI validates the portable WAV path in Chromium and WebKit. It does not prove native HE-AAC availability in desktop Chrome, Edge, or Safari because M4A decoding depends on each browser and operating system's codec stack.

## Manual HE-AAC release matrix

No private HE-AAC fixture is committed. Every row below remains a release blocker until the exact browser, operating system, codec profile, inspection tool, and results are recorded.

| Browser | Browser version | OS/version | M4A codec/profile + inspection tool | Plain convolution | Beat pan + reverse | Playback/download | Metadata/formulas/peak | Status |
|---|---|---|---|---:|---:|---:|---:|---|
| Chrome | — | — | — | — | — | — | — | Not run |
| Edge | — | — | — | — | — | — | — | Not run |
| Safari | — | — | — | — | — | — | — | Not run |

For each browser:

1. Select a known stereo 48 kHz HE-AAC `.m4a` as A and a WAV impulse as B.
2. Identify the exact AAC profile or object type with a named inspection tool and record both in the table; do not infer the profile from the filename or extension.
3. Process without beat pan or reverse.
4. Process with `beatPan: "a"` and reverse append.
5. Play and download both WAV outputs.
6. Confirm 48 kHz stereo PCM24 metadata, expected frame formulas, finite non-silent peak metadata, and no clipping or page errors.
7. Record the exact browser version, operating-system version, codec/profile, inspection tool, and pass/fail in the table.

A successful Playwright WebKit run on Linux does not substitute for the Safari row: it validates the browser application path, not Safari's desktop media-decoding stack.

## Why there is no bundled FFmpeg core

The prebuilt `@ffmpeg/core` package is deliberately absent from the dependency tree. Adding it would introduce a materially different licensing and bundle-size boundary for an otherwise MIT-only v1. A future deterministic M4A backend should be an optional custom audio-only build, have an explicit separate entry point, and receive legal review before distribution.
