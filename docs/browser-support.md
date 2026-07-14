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

Validation recorded on 2026-07-14:

| Browser/runtime | OS | Result | Coverage |
|---|---|---:|---|
| Chromium 150.0.7871.114 | Debian 13 | Pass | PCM24/48 kHz/stereo header, full convolution length, five-millisecond reverse overlap, 120 BPM beat metadata, playable/downloadable Blob, no page errors |
| Playwright WebKit | Local container | Not run | The WebKit binary was unavailable and the environment could not resolve `cdn.playwright.dev` to install it |

CI installs Playwright Chromium and WebKit and runs the same WAV suite on each push and pull request. A local environment without those browser binaries cannot substitute a Chromium-only pass for the WebKit gate.

## Manual HE-AAC release matrix

No private HE-AAC fixture is committed. The following checks remain mandatory before a release:

| Browser | OS/version | Plain convolution | Beat pan + reverse | Playback/download | Status |
|---|---|---:|---:|---:|---|
| Chrome | Record at release | — | — | — | Not run in this container |
| Edge | Record at release | — | — | — | Not run in this container |
| Safari | Record at release | — | — | — | Not run in this container |

For each browser:

1. Select a known stereo 48 kHz HE-AAC `.m4a` as A and a WAV impulse as B.
2. Process without beat pan or reverse.
3. Process with `beatPan: "a"` and reverse append.
4. Play and download both WAV outputs.
5. Confirm 48 kHz stereo PCM24 metadata, expected frame formulas, finite non-silent peak metadata, and no clipping or page errors.
6. Record exact browser version, operating-system version, M4A profile, and pass/fail above.

## Why there is no bundled FFmpeg core

The prebuilt `@ffmpeg/core` package is deliberately absent from the dependency tree. Adding it would introduce a materially different licensing and bundle-size boundary for an otherwise MIT-only v1. A future deterministic M4A backend should be an optional custom audio-only build, have an explicit separate entry point, and receive legal review before distribution.
