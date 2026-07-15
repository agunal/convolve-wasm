# Hosted real-browser HE-AAC release matrix — 2026-07-15

**Status:** Chrome, Edge, and Safari release-browser gate passed against the unchanged built `release/v0.1.0-final` application.

No input or output audio is committed. The deterministic fixture, output WAVs, JSON reports, logs, and hashes were retained as GitHub Actions artifacts for run `29392630499` on temporary probe commit `38d17ef688260b7201821964996757549feafc69`.

The temporary probe changed only test harness and workflow files on `test/browser-matrix-probe`; it did not alter the package, worker, Rust/WASM DSP, demo application, or release branch implementation.

## Test environments

| Browser | Exact version | Operating system | Execution path |
|---|---|---|---|
| Google Chrome | `149.0.7827.201` | Windows Server 2025 Datacenter, build `26100`, x64 | Installed branded Chrome, Playwright `channel: "chrome"` |
| Microsoft Edge | `149.0.4022.98` | Windows Server 2025 Datacenter, build `26100`, x64 | Installed branded Edge, Playwright `channel: "msedge"` |
| Safari | `26.4` (`21624.1.16.11.4`) | macOS `26.4`, build `25E246`, Apple Silicon | System Safari through the included `safaridriver` |

The app was built from the exact probe commit with the repository's normal `npm ci` and `npm run build` path, including the Rust/WASM build and the production Vite demo bundle.

## Deterministic fixture

The fixture was generated on the macOS runner and was not checked into Git:

- A source: four-second stereo 48 kHz PCM16 click/tone WAV.
- A release input: Apple `afconvert` output using `-f m4af -d aach -b 64000`.
- B input: mono 48 kHz PCM16 WAV impulse, 2,400 frames (50 ms).

Apple `afinfo` reported the M4A format list as stereo, 48 kHz `aach`, with the compatible 24 kHz AAC representation. `aach` is Apple's HE-AAC encoder identifier. Safari also returned `probably` for `audio/mp4; codecs="mp4a.40.5"`.

| File | SHA-256 |
|---|---|
| HE-AAC M4A | `fc689994d76c77461b59bba307691e9b8a51c0f364485a7cefbbf06cefc239b0` |
| WAV impulse | `b227b5823d31a8deda4bcb6cf3d9e1810bee28cdc83fb20391cba52ae4c3cf92` |

## Input decoding

All browsers decoded A as stereo 48 kHz and B as mono 48 kHz through the application's `OfflineAudioContext.decodeAudioData()` boundary.

| Browser | Decoded A frames | Decoded B frames | Expected plain frames | Expected reverse-append frames |
|---|---:|---:|---:|---:|
| Chrome | 196,544 | 2,400 | `196544 + 2400 - 1 = 198943` | `2 * 198943 - 240 = 397646` |
| Edge | 196,544 | 2,400 | `196544 + 2400 - 1 = 198943` | `2 * 198943 - 240 = 397646` |
| Safari | 192,000 | 2,400 | `192000 + 2400 - 1 = 194399` | `2 * 194399 - 240 = 388558` |

The decoded HE-AAC frame count differs between browser media stacks because codec delay, priming, and remainder handling are implementation-dependent. Each output was checked against the formula using that browser's actual decoded frame counts.

## Plain convolution

| Browser | Output frames | Status metadata | WAV validation | Output SHA-256 |
|---|---:|---|---|---|
| Chrome | 198,943 | 0 beats; `-9.43 dBTP` | stereo 48 kHz PCM24; maximum PCM magnitude 2,833,313; finite, non-silent, unclipped | `424c8d8475290ea88a20175f76cc26ec1dec5ed2d4660a2d57436d24d3b79c6d` |
| Edge | 198,943 | 0 beats; `-9.43 dBTP` | stereo 48 kHz PCM24; maximum PCM magnitude 2,833,313; finite, non-silent, unclipped | `424c8d8475290ea88a20175f76cc26ec1dec5ed2d4660a2d57436d24d3b79c6d` |
| Safari | 194,399 | 0 beats; `-9.43 dBTP` | stereo 48 kHz PCM24; maximum PCM magnitude 2,833,225; finite, non-silent, unclipped | `ee690143f3895f924f9281a645c98c9b3196eb1bf0d1d05f31dd312ee8702274` |

## Beat pan from A plus reverse append

The requested mode used `beatPan: "a"`, the default 20 ms pan transition, reverse append, and the default 5 ms / 240-frame midpoint crossfade.

| Browser | Output frames | Beat metadata | Status metadata | WAV validation | Output SHA-256 |
|---|---:|---|---|---|---|
| Chrome | 397,646 | 9 beats; 119.68 BPM | `-9.76 dBTP` | stereo 48 kHz PCM24; maximum PCM magnitude 2,726,572; finite, non-silent, unclipped | `6ebe752c5363802ff7af9fc2abd3ce527c309193758fc7b9c64cb5c16a79fa37` |
| Edge | 397,646 | 9 beats; 119.68 BPM | `-9.76 dBTP` | stereo 48 kHz PCM24; maximum PCM magnitude 2,726,572; finite, non-silent, unclipped | `6ebe752c5363802ff7af9fc2abd3ce527c309193758fc7b9c64cb5c16a79fa37` |
| Safari | 388,558 | 9 beats; 119.68 BPM | `-9.76 dBTP` | stereo 48 kHz PCM24; maximum PCM magnitude 2,726,489; finite, non-silent, unclipped | `54c71618f1899f903970a369a82399da283a44a185334cd72fb6c990f3f04bf1` |

## Playback, download, and page state

For both processing modes in every browser:

- the output `<audio>` element reached ready state 4;
- `play()` started successfully and was then paused;
- the enabled download link had the expected `convolved-audio.wav` filename and a Blob URL;
- the link was activated and the exact resulting bytes were retained and parsed;
- the WAV contained WAVE_FORMAT_EXTENSIBLE with the PCM subtype, stereo channels, 48,000 Hz sample rate, and 24 valid bits;
- no page exception or console error was recorded.

Safari's WebDriver sandbox produced unreadable OS-injected file handles. To test the application rather than that automation defect, the same artifact bytes were fetched from the demo's own origin and wrapped in browser-native `File` objects before assignment to the unchanged file inputs. The application's `File.arrayBuffer()`, `OfflineAudioContext.decodeAudioData()`, worker, WASM, Blob playback, and download paths then ran normally. Both Safari's offline and realtime Web Audio decoders accepted the HE-AAC fixture, and its media element loaded the same file with a four-second duration.

## Artifact record

| Artifact | GitHub artifact ID | Artifact digest |
|---|---:|---|
| Fixture and inspection evidence | `8333843009` | `sha256:b7ea4ba2e78e8ee8fe0cc9055211bcbab9056131afe18810e3c9385e2ff8c13a` |
| Chrome and Edge outputs/results | `8333918434` | `sha256:6b6e20007fd2088fa75b62c4bc4c169212c5a928afaf80f37113a3b5a4204c27` |
| Safari outputs/results | `8333914875` | `sha256:050b2634a1fc7f719ed18b50e0c3947774bd5dd833d80789c8161484df30bec8` |

The `fixture`, `windows-matrix`, and `safari-matrix` jobs all completed successfully in GitHub Actions run `29392630499`.
