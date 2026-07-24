# Browser and codec support

## Supported boundary

Current desktop Chrome/Edge and Safari remain the established release target. v0.1.2 is a candidate for current Android Chrome: it retains v0.1.1 safe rejection and delivers the lower-memory full FFT, including incremental beat panning, virtual reverse layering, explicit FFT scratch reuse, and backpressured PCM24 chunk streaming.

This is not yet an official Android-completion claim. Both the immutable [v0.1.1 safe-rejection evidence](testing/2026-07-17-mobile-safe-rejection.md) and the [v0.1.2 lower-memory evidence](testing/2026-07-18-lower-memory-full-fft.md) require a physical-device `Pass` before release candidate packaging or publication can proceed. On a reported 4 GB device, the private pair remains expected to produce readable pre-worker `INPUT_TOO_LARGE` results because its corrected v0.1.2 estimates exceed the 192 MiB browser budget. A public multi-chunk fixture must complete with playback/download and a clean console. iOS remains best effort.

- WAV is the automated portability baseline.
- M4A is passed to `decodeAudioData()` and depends on codecs exposed by the browser and operating system.
- Firefox M4A behavior is best effort and platform dependent.
- A decode failure returns `DECODE_FAILED`; there is no upload, server fallback, or bundled FFmpeg decoder.
- Processing is single-threaded WASM in a dedicated worker and does not require `SharedArrayBuffer`, COOP, or COEP headers.
- Browser budgets range from 64 MiB to 384 MiB using the reported `navigator.deviceMemory` class; the independent 256 MiB Rust/WASM guard remains active.

## Android local diagnostics

The hosted demo keeps bounded, same-origin diagnostic checkpoints for Android investigation. On the next load, an active record without a terminal completion or clean-shutdown boundary is marked `unexpected-termination`; this is an inference rather than proof of OOM, a browser crash, or an exact system cause. Reopen the same site promptly to review and export it, then combine it with Chrome remote debugging or `adb logcat` when available.

See [mobile crash diagnostics](mobile-crash-diagnostics.md) for the collection boundary, retention limits, recovery meaning, clearing behavior, and Android report workflow.

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

GitHub CI validates the portable WAV path in Chromium and WebKit. It does not by itself prove native HE-AAC availability in branded desktop Chrome, Edge, or Safari because M4A decoding depends on each browser and operating system's codec stack.

## Private HE-AAC fixture preflight

The exact private HE-AAC fixture and supplied WAV were preflighted on 2026-07-15. Local Chromium 144 on Debian 13 decoded both through `OfflineAudioContext.decodeAudioData()` without page errors. Independent processing preflight produced formula-correct stereo 48 kHz PCM24 outputs, and Chromium successfully played and downloaded both generated WAVs with byte-identical SHA-256 round trips.

See [the complete private-fixture preflight record](testing/2026-07-15-private-fixture-preflight.md) for input hashes, codec metadata, decoded frame counts, beat-grid results, output formulas, peak data and limitations.

That preflight did not complete a release-browser row because the supplied WAV was program audio rather than an impulse, the repository's worker/WASM application path was not executed, and Linux Chromium was not current branded Chrome, Edge, or Safari.

## Hosted real-browser HE-AAC release matrix

The release-browser matrix was completed on 2026-07-15 using the unchanged production build of the repository demo/package/worker/WASM path and a deterministic stereo 48 kHz HE-AAC M4A plus a WAV impulse. See [the complete hosted-browser evidence record](testing/2026-07-15-hosted-release-browser-matrix.md).

The M4A was produced by Apple `afconvert` with `-f m4af -d aach` and inspected with Apple `afinfo`, which reported stereo 48 kHz `aach` in the format list. Every browser ran plain convolution and `beatPan: "a"` with reverse append, started playback, activated the download path, and produced finite non-silent unclipped stereo 48 kHz PCM24 output matching the browser-specific decoded-frame formulas. No page errors were recorded.

| Browser | Browser version | OS/version | M4A codec/profile + inspection tool | Plain convolution | Beat pan + reverse | Playback/download | Metadata/formulas/peak | Status |
|---|---|---|---|---:|---:|---:|---:|---|
| Chrome | 149.0.7827.201 | Windows Server 2025 Datacenter, build 26100, x64 | HE-AAC; Apple `aach`; `afconvert` + `afinfo` | Pass | Pass | Pass | PCM24/48 kHz/stereo; 198,943 and 397,646 frames; finite/unclipped | Pass |
| Edge | 149.0.4022.98 | Windows Server 2025 Datacenter, build 26100, x64 | HE-AAC; Apple `aach`; `afconvert` + `afinfo` | Pass | Pass | Pass | PCM24/48 kHz/stereo; 198,943 and 397,646 frames; finite/unclipped | Pass |
| Safari | 26.4 (21624.1.16.11.4) | macOS 26.4, build 25E246, Apple Silicon | HE-AAC; Apple `aach`; `afconvert` + `afinfo` | Pass | Pass | Pass | PCM24/48 kHz/stereo; 194,399 and 388,558 frames; finite/unclipped | Pass |

Chrome and Edge decoded 196,544 HE-AAC frames; Safari decoded 192,000. That difference reflects browser-specific codec delay and priming handling. Each output matched the documented formulas using the actual frames returned by that browser's decoder.

The Safari test used system Safari through the included `safaridriver`. Safari's automation sandbox made operating-system-injected file handles unreadable, including a WAV file. The same fixture bytes were therefore fetched from the demo origin and wrapped in browser-native `File` objects before assignment to the unchanged file inputs. Safari then passed its offline and realtime Web Audio decode checks, media-element metadata check, application worker/WASM processing, Blob playback, and download-byte validation.

## Why there is no bundled FFmpeg core

The prebuilt `@ffmpeg/core` package is deliberately absent from the dependency tree. Adding it would introduce a materially different licensing and bundle-size boundary for an otherwise MIT-only v0.1.0. A future deterministic M4A backend should be an optional custom audio-only build, have an explicit separate entry point, and receive legal review before distribution.
