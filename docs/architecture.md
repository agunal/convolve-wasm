# Architecture

## Boundary overview

`@takana-labs/convolve-wasm` is an offline browser library with three execution layers.

### Browser control thread

The public `CONVOLVE()` API validates inputs/options, decodes A followed by B through a lazily created `OfflineAudioContext(2, 1, 48_000)`, and builds a checked post-decode `MemoryPlan`. Unsafe work fails with actionable `INPUT_TOO_LARGE` details before a worker is created. Safe work transfers the four decoded channel buffers to one module worker; it does not clone them.

The control thread receives the original progress stages and incrementally assembles the final `audio/wav` Blob using a backpressured `ReadableStream` and `Response.blob()`. It permits one PCM chunk in flight, validates every sequence/offset/length/metadata field, and discards partial output on a protocol or callback failure.

### Module worker

The module worker loads wasm-bindgen once and serializes process requests. It first constructs `WasmProcessJob`, immediately drops transferred request-channel references, and then calls `job.process(progress)` to obtain a `WasmOutputSession`. The worker sends `output-start`, answers one `pull-output` at a time with ordered transferred `output-chunk` buffers, and emits `encode` and `done` only after the final successful chunk. `cancel` bypasses the normal queue; all job/session state is released on success, cancellation, malformed output, and error.

### Rust/WASM core

The Rust crate owns deterministic validation, memory estimation, DSP, metadata, and PCM24 encoding. The order remains:

1. validate inputs/options and check the independent allocation guard;
2. full stereo RealFFT convolution;
3. optional beat detection from original A or B;
4. optional equal-power panning on the beat grid;
5. optional reverse append/crossfade;
6. estimated true-peak normalization;
7. streamed PCM24 WAV output.

## Full FFT and views

Each channel uses a real FFT sized to the next power of two, multiplies complex bins, divides the inverse by the FFT length, and copies its linear result into exact `n = Na + Nb - 1` frame storage. Channels run serially and reuse explicit RealFFT scratch buffers.

Beat panning uses an incremental beat/range state machine instead of materialized beat-position and pan arrays. It preserves the legacy f32 gain operation order, transition clipping, beat count, and equal-power cosine/sine result.

The forward audio, reverse append, and gain are read-only typed views. Reverse uses a virtual palindrome with the same overlap indices and complementary blend as the materialized legacy waveform. True-peak measurement, attenuation, and PCM conversion walk the layered view, so reverse-overlap blending happens before gain. These changes preserve the established full-engine WAV bytes.

## Reverse append and peak safety

Reverse append follows panning and does not swap channels. With effective overlap `crossfadeFrames` clamped to `forwardFrames - 1`:

```text
finalFrames = 2 * forwardFrames - crossfadeFrames
```

Peak estimation includes ordinary samples plus three fractional phases from a normalized four-phase, 32-tap Blackman-windowed sinc. It allocates no 4x waveform. Normalization is attenuation-only; silence reports `-Infinity` dBTP.

## Memory guards

The post-decode browser plan keeps the v0.1.1 device-class budget and now models the streamed full engine:

```text
decoded stereo D  = 8 * (a + b)
forward audio F   = 8 * n
FFT workspace X   = 24 * nextPowerOfTwo(n)
WAV size W        = 68 + 6 * finalFrames
PCM chunk C       = 393,216 bytes (65,536 stereo PCM24 frames)
encoded input E   = fileA.size + fileB.size
runtime reserve   = 32 MiB
estimated peak    = E + 3D + F + X + W + 2C + reserve
```

There is no reverse-waveform or beat-pan-vector charge because both are virtual/incremental. The browser budget is `clamp(deviceMemoryGiB * 48 MiB, 64 MiB, 384 MiB)`; reported 4 GB devices receive 192 MiB, while reported 8 GB devices and unknown desktops receive 384 MiB. Checked arithmetic saturates to rejection.

The independent streaming Rust/WASM guard stays exactly 256 MiB and models `D + F + X + 2C + 16 MiB`. It does not bypass the browser plan. The legacy one-shot compatibility wrapper retains its conservative whole-WAV allowance until it returns, while worker sessions use the streaming model.

## Output

The encoder preserves the 68-byte `WAVE_FORMAT_EXTENSIBLE` header and emits interleaved stereo 48 kHz signed 24-bit PCM. It emits ordered chunks of at most 65,536 frames; `W = 68 + 6 * finalFrames`. PCM rounding remains byte-compatible with prior full-engine output.

## Demo-only diagnostic recorder

The hosted demo includes a demo-only diagnostic recorder that writes allow-listed, sanitized lifecycle checkpoints to origin-local `localStorage`. It stores a bounded session ring and a separate active-session marker so that local checkpoints can be recovered after a same-origin reload.

The recorder is observational and best effort: storage, export, or clipboard failures cannot change convolution processing. It records no audio data and has no upload or server-side telemetry path. The canonical [mobile crash diagnostics guide](mobile-crash-diagnostics.md) defines its schema/export v1 limits, privacy boundary, recovery inference, and Android workflow.

## Distribution and licensing

The project is MIT licensed and deliberately excludes prebuilt `@ffmpeg/core`. Browser-native decoding keeps the shipped library focused on one project-owned WASM DSP runtime; a future deterministic M4A decoder must be optional and separately reviewed.
