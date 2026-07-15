# Private HE-AAC fixture preflight — 2026-07-15

**Status:** Useful fixture evidence; not a completed release-browser matrix row.

No private input or generated output audio is committed. SHA-256 values identify the exact local files used.

## Inputs

| Role | SHA-256 | Inspection | Browser-decoded shape |
|---|---|---|---|
| A | `f81751f49d8200b6f7585266b6d887b8d001e563e20ffd6acdbe5eb6b65cb8c0` | `ffprobe`: AAC, profile `HE-AAC`, M4A/MP4 container, stereo, 48,000 Hz, 6.741333 s | 323,584 frames, stereo, 48,000 Hz |
| B | `8b047831c37b2e7df9780d9a05296d50d2eab62a355110ac45fc8a4479338aa4` | WAV, signed PCM16, mono, 48,000 Hz, 1.289146 s | 61,879 frames, mono, 48,000 Hz |

B is real program audio rather than the WAV impulse required by the final manual release matrix. It is suitable for real-world pair preflight but does not replace the impulse-based matrix run.

## Native browser decode preflight

Environment:

```text
Browser: Chromium 144.0.7559.96
User agent: Chrome/144.0.0.0
OS: Debian GNU/Linux 13 (trixie)
API: OfflineAudioContext.decodeAudioData()
```

Results:

- A decoded successfully as stereo, 48,000 Hz, 323,584 frames.
- B decoded successfully as mono, 48,000 Hz, 61,879 frames.
- No page exceptions or console errors were recorded.

This proves that this local Chromium/OS codec stack can decode the exact HE-AAC fixture. Chromium on Linux is not a substitute for current desktop Google Chrome, Edge, or Safari.

## Independent processing preflight

An independent local reference implementation reproduced the documented v0.1.0 order and formulas: channel-wise FFT convolution, optional beat-grid panning, optional 5 ms reverse append, 4×/32-tap true-peak estimation, attenuation-only normalization to -1 dBTP, and stereo PCM24 WAV encoding.

This validates fixture behavior and expected values. It does **not** prove the repository's TypeScript worker/WASM application path, so it cannot mark a release-browser row Pass.

### Plain convolution

| Check | Result |
|---|---|
| Expected/output frames | `323584 + 61879 - 1 = 385462` |
| Duration | 8.030458 s |
| Output format | stereo, 48,000 Hz, signed PCM24 WAV |
| Estimated final true peak | -1.0000003 dBTP |
| Maximum sample magnitude | 0.89125085 |
| Finite/non-silent | Pass |
| Output SHA-256 | `3f6c7699d8b74d9d47ab5f959d814cd238d99c888ff17cc92ca52ad52966e614` |

### Beat pan from A plus reverse append

Detected grid:

```text
BPM: 104.1667
confidence: 0.3730
anchor sample: 16,896
period samples: 27,648
beats through convolution output: 14
```

| Check | Result |
|---|---|
| Forward frames | 385,462 |
| Crossfade | 240 frames / 5 ms |
| Expected/output frames | `2 * 385462 - 240 = 770684` |
| Duration | 16.055917 s |
| Output format | stereo, 48,000 Hz, signed PCM24 WAV |
| Estimated final true peak | -1.0000003 dBTP |
| Maximum sample magnitude | 0.89125085 |
| Exact PCM24 palindrome | Pass; maximum forward/reverse sample difference 0 |
| Finite/non-silent | Pass |
| Output SHA-256 | `8048203fa86e15596b0564921509d6d1592a6391d5117e9defc99d04742fb71f` |

## Chromium output playback/download round trip

Both generated WAVs were loaded from Blob URLs in Chromium 144:

- `decodeAudioData()` returned the exact expected frame counts, stereo channels and 48,000 Hz sample rate;
- each `<audio>` element reached ready state 4;
- `play()` started successfully for each output;
- each download completed with the intended filename;
- downloaded bytes matched the source output SHA-256 exactly;
- no page exceptions or console errors were recorded.

## Remaining release evidence

The final matrix still requires the actual repository demo/package path with a WAV impulse on current desktop:

- Google Chrome;
- Microsoft Edge;
- Safari.

For each, record exact browser/OS versions, the inspected HE-AAC profile, both processing modes, playback/download, output formulas/metadata/peak, clipping and page errors.