# Architecture

## Boundary overview

`@takana-labs/convolve-wasm` is an offline browser library with three execution layers.

### Browser control thread

The public `CONVOLVE()` function validates the input object and options, then decodes A followed by B with a lazily created `OfflineAudioContext(2, 1, 48_000)`. Web Audio performs content sniffing and resampling. Mono data is copied into two independent planar `Float32Array`s; stereo channels remain discrete; decoded audio with more than two channels is rejected.

The four channel buffers are transferred—not cloned—to one lazily created module worker. The control thread receives progress events and constructs the final `Blob` with MIME type `audio/wav`.

### Module worker

The module worker loads the generated wasm-bindgen JavaScript and WASM asset once. Requests carry IDs so progress, results, and errors resolve the correct promise. A promise queue serializes synchronous WASM jobs while keeping DSP off the page thread.

WAV bytes are copied out of WASM into a standalone `ArrayBuffer` and transferred back. Rust error codes, messages, and details are preserved by the worker protocol.

### Rust/WASM core

The Rust crate owns deterministic validation, memory estimation, DSP, metadata, and WAV encoding. The processing order is:

1. validate inputs/options;
2. check conservative peak allocation;
3. full stereo RealFFT convolution;
4. optional beat detection from original A or B;
5. optional beat-grid extension and equal-power panning;
6. optional reverse append/crossfade;
7. estimated true-peak normalization;
8. PCM24 WAV encoding.

## Convolution

Channels are processed independently:

```text
left  = conv(A.left,  B.left)
right = conv(A.right, B.right)
```

The full output contains `Na + Nb - 1` frames. Each channel uses a real FFT sized to the next power of two, multiplies complex bins, divides inverse output by the FFT length, and truncates to the exact linear-convolution length. Channels are processed serially to reduce simultaneous working memory.

## Beat analysis and panning

The selected original input is converted to mono with `(left + right) * 0.5`. Beat analysis uses a 2,048-sample Hann-windowed STFT, 512-sample hop, positive spectral flux, and a centered nine-frame median threshold. Autocorrelation searches 60–200 BPM and rejects confidence below 0.15. The strongest phase anchors a periodic grid, with near-zero phase normalized to sample zero.

The grid repeats through the complete convolved tail. A zero beat anchors the initial side and does not flip it. Panning starts hard left, alternates on later beats, caps transition duration to half the beat period, collapses the convolved pair to mono, and applies equal-power cosine/sine gains. Original stereo width is therefore intentionally removed whenever beat pan is enabled.

## Reverse append

Reverse append happens after panning. The appended section is an exact sample-time reversal of the processed forward waveform with no channel swap. The overlap uses complementary linear gains and no duplicated hard midpoint. The effective overlap is clamped to `forwardFrames - 1`.

```text
finalFrames = 2 * forwardFrames - crossfadeFrames
```

## Peak safety

Peak safety runs after every requested effect. The estimator always includes the ordinary sample peak and evaluates three fractional phases between samples using a normalized, four-phase, 32-tap Blackman-windowed sinc. Coefficients and accumulation use double precision without allocating a 4× waveform.

Normalization is attenuation-only. A signal already at or below the requested ceiling receives exactly 0 dB gain. Silence reports `-Infinity` dBTP. The default target is `-1.0` dBTP.

## Memory guard

Requests are rejected before FFT/output allocation when this conservative estimate exceeds 268,435,456 bytes:

```text
input bytes       = 2 * (a + b) * 4
forward output    = 2 * n * 4
final output      = forward output, or 2 * (2*n - crossfade) * 4
FFT working set   = 24 * checked_next_power_of_two(n)
fixed headroom    = 16 MiB
n                 = a + b - 1
```

Every arithmetic operation is checked for overflow.

## Output

The encoder writes RIFF/WAVE, two channels, 48,000 Hz, signed integer PCM, 24 bits per sample, interleaved left/right. v1 does not add dither.

## Distribution and licensing

The project is MIT licensed. v1 deliberately excludes the standard prebuilt `@ffmpeg/core`, whose licensing would change the distribution obligations. Browser-native decoding keeps the shipped library focused on one project-owned WASM DSP runtime. A future deterministic M4A decoder must be an optional, separately reviewed backend rather than a hidden dependency of the main entry point.
