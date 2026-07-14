# Convolve WASM Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a reusable browser library and small demo that implement `CONVOLVE({a, b}, appendReverse, options)` entirely client-side, accepting `.wav` and browser-decodable `.m4a`, performing stereo FFT convolution plus optional beat-synchronized left/right panning and reverse append, and returning a 48 kHz stereo 24-bit WAV without clipping.

**Architecture:** Decode files on the browser control thread with `OfflineAudioContext.decodeAudioData()` at 48 kHz, then transfer planar stereo `Float32Array` buffers to a dedicated module worker. The worker loads a Rust/WASM DSP core that performs validation, memory estimation, full linear FFT convolution, beat analysis, equal-power panning, reverse append/crossfade, 4× estimated true-peak normalization, and PCM24 WAV encoding. The TypeScript package owns browser compatibility, worker lifecycle, progress events, and typed errors; the Rust crate owns all deterministic DSP.

**Tech Stack:** Rust stable, `wasm-bindgen`, `realfft`, `hound`, TypeScript, Vite 8.1.4, Vitest, Playwright, npm workspaces, GitHub Actions.

## Global Constraints

- Preserve the repository's MIT license. Do **not** bundle the prebuilt `@ffmpeg/core` package in v1 because that package is GPL-2.0-or-later.
- Public API must retain the requested first two parameters: `CONVOLVE(audio: { a: File; b: File }, appendReverse?: boolean, options?: ConvolveOptions)`.
- Accepted filename extensions are `.wav` and `.m4a`, case-insensitive. Actual decoding is content-sniffed by the browser, so a valid extension does not guarantee codec support.
- Processing sample rate is fixed at exactly `48_000` Hz in v1.
- Input is normalized to exactly two planar channels. Mono is duplicated to left and right. Inputs with more than two decoded channels fail with `UNSUPPORTED_CHANNEL_COUNT`.
- Convolution is full, wet-only, channel-wise linear convolution: `out.left = conv(a.left, b.left)` and `out.right = conv(a.right, b.right)`.
- Convolution output frame count before optional reverse append is exactly `a.frames + b.frames - 1`.
- Beat pan source is `"a"`, `"b"`, or `null`. The panned convolved signal starts hard left; the first beat at sample zero is an anchor, and direction flips on each later beat.
- Beat panning treats the convolved stereo signal as one object by collapsing it to mono with `(L + R) * 0.5`, then applying equal-power left/right gains. This intentionally trades original stereo width for hard spatial motion.
- The detected tempo grid is extended through the convolution tail using the detected median beat period.
- Default pan transition is `20` ms and is centered on each beat.
- Reverse append happens after beat panning. The reverse section is an exact sample reversal of the processed forward section.
- Default forward/reverse crossfade is `5` ms with complementary linear gains and no duplicated midpoint. Final frame count is `2 * forwardFrames - crossfadeFrames` when crossfade is nonzero.
- Normalization happens after every requested effect. It is attenuation-only, targets `-1.0` dBTP, and uses a documented 4× windowed-sinc intersample-peak estimate.
- Output is stereo, 48 kHz, signed 24-bit PCM WAV with MIME type `audio/wav`.
- All heavy synchronous DSP runs in a dedicated module worker. The browser main thread performs only file reading, native decoding/resampling, buffer copying, progress dispatch, and Blob construction.
- No audio leaves the browser. No network upload or server processing is permitted.
- v1 is single-threaded WASM and does not require `SharedArrayBuffer`, COOP, or COEP headers.
- Reject requests whose conservative estimated peak WASM allocation exceeds `256 * 1024 * 1024` bytes with `INPUT_TOO_LARGE` before allocating FFT/output buffers.
- No cancellation, streaming convolution, multichannel surround, dry/wet control, mastering EQ/compression, or npm publication automation in v1.
- Supported release browsers are current Chrome/Edge and Safari. WAV must work in all tested browsers; M4A support is explicitly dependent on the browser/OS codec stack.
- Commit generated lockfiles. Do not commit `wasm-pack` output under `packages/convolve-wasm/src/wasm/`.

---

## Final Public Contract

```ts
export type BeatPanSource = "a" | "b" | null;

export type ConvolveStage =
  | "decode-a"
  | "decode-b"
  | "load-wasm"
  | "validate"
  | "convolve"
  | "beat-detect"
  | "beat-pan"
  | "append-reverse"
  | "normalize"
  | "encode"
  | "done";

export interface ConvolveProgress {
  stage: ConvolveStage;
  fraction: number; // inclusive range 0..1
}

export interface ConvolveOptions {
  beatPan?: BeatPanSource;
  panTransitionMs?: number;       // default 20
  reverseCrossfadeMs?: number;    // default 5
  targetDbtp?: number;            // default -1
  onProgress?: (event: ConvolveProgress) => void;
}

export interface ConvolveMetadata {
  sampleRate: 48_000;
  channels: 2;
  durationSeconds: number;
  outputFrames: number;
  detectedBeats: number;
  detectedBpm: number | null;
  beatConfidence: number | null;
  appliedGainDb: number;
  estimatedTruePeakDbtp: number;
}

export interface ConvolveResult {
  wav: Blob;
  metadata: ConvolveMetadata;
}

export async function CONVOLVE(
  audio: { a: File; b: File },
  appendReverse?: boolean,
  options?: ConvolveOptions,
): Promise<ConvolveResult>;
```

## Error Contract

```ts
export type ConvolveErrorCode =
  | "INVALID_INPUT"
  | "UNSUPPORTED_EXTENSION"
  | "DECODE_FAILED"
  | "UNSUPPORTED_CHANNEL_COUNT"
  | "INPUT_TOO_LARGE"
  | "BEAT_DETECTION_FAILED"
  | "WASM_INIT_FAILED"
  | "PROCESSING_FAILED"
  | "ENCODE_FAILED";

export class ConvolveError extends Error {
  readonly code: ConvolveErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ConvolveErrorCode,
    message: string,
    details?: Record<string, unknown>,
    cause?: unknown,
  );
}
```

## Repository Layout

```text
agunal/convolve-wasm/
├── .github/
│   └── workflows/
│       └── ci.yml
├── apps/
│   └── demo/
│       ├── index.html
│       ├── package.json
│       ├── tsconfig.json
│       ├── vite.config.ts
│       └── src/
│           ├── main.ts
│           └── styles.css
├── crates/
│   └── convolve-core/
│       ├── Cargo.toml
│       ├── src/
│       │   ├── audio.rs
│       │   ├── beats.rs
│       │   ├── convolution.rs
│       │   ├── error.rs
│       │   ├── lib.rs
│       │   ├── limits.rs
│       │   ├── options.rs
│       │   ├── pan.rs
│       │   ├── peak.rs
│       │   ├── processor.rs
│       │   ├── reverse.rs
│       │   └── wav.rs
│       └── tests/
│           ├── beat_detection.rs
│           ├── convolution.rs
│           ├── effects.rs
│           ├── processor.rs
│           └── wasm_smoke.rs
├── docs/
│   ├── architecture.md
│   ├── browser-support.md
│   └── superpowers/
│       └── plans/
│           └── 2026-07-14-convolve-wasm.md
├── packages/
│   └── convolve-wasm/
│       ├── package.json
│       ├── tsconfig.json
│       ├── tsconfig.build.json
│       ├── vite.config.ts
│       ├── src/
│       │   ├── convolve.worker.ts
│       │   ├── decode.test.ts
│       │   ├── decode.ts
│       │   ├── errors.test.ts
│       │   ├── errors.ts
│       │   ├── index.test.ts
│       │   ├── index.ts
│       │   ├── options.test.ts
│       │   ├── options.ts
│       │   ├── types.ts
│       │   ├── worker-client.test.ts
│       │   ├── worker-client.ts
│       │   ├── worker-protocol.ts
│       │   └── wasm/                 # generated; gitignored
│       └── tests/
│           └── package-consumer.test.ts
├── tests/
│   └── e2e/
│       ├── convolve.spec.ts
│       ├── fixtures.ts
│       └── playwright.config.ts
├── .gitignore
├── Cargo.lock
├── Cargo.toml
├── LICENSE
├── package-lock.json
├── package.json
├── README.md
└── rust-toolchain.toml
```

## Task 1: Scaffold the Workspace and Lock the TypeScript Contract

**Files:**
- Create: `package.json`
- Create: `Cargo.toml`
- Create: `rust-toolchain.toml`
- Create: `.gitignore`
- Create: `crates/convolve-core/Cargo.toml`
- Create: `crates/convolve-core/src/lib.rs`
- Create: `packages/convolve-wasm/package.json`
- Create: `packages/convolve-wasm/tsconfig.json`
- Create: `packages/convolve-wasm/tsconfig.build.json`
- Create: `packages/convolve-wasm/vite.config.ts`
- Create: `packages/convolve-wasm/src/types.ts`
- Create: `packages/convolve-wasm/src/options.ts`
- Create: `packages/convolve-wasm/src/errors.ts`
- Create: `packages/convolve-wasm/src/index.ts`
- Create: `packages/convolve-wasm/src/index.test.ts`
- Modify: `README.md`

**Interfaces:**
- Produces: the exact public TypeScript contract and error codes shown above.
- Produces: `DEFAULT_OPTIONS: Required<Omit<ConvolveOptions, "onProgress">>`.
- Produces: `normalizeOptions(options?: ConvolveOptions): NormalizedConvolveOptions`.
- Consumes: no earlier task.

- [ ] **Step 1: Create the workspace manifests and toolchain files**

Use npm workspaces `packages/*` and `apps/*`. Set `engines.node` to `^20.19.0 || >=22.12.0`, matching Vite 8's Node requirement. Add scripts with these exact names:

```json
{
  "private": true,
  "workspaces": ["packages/*", "apps/*"],
  "engines": { "node": "^20.19.0 || >=22.12.0" },
  "scripts": {
    "build:wasm": "cd crates/convolve-core && wasm-pack build --target web --out-dir ../../packages/convolve-wasm/src/wasm --out-name convolve_core",
    "build": "npm run build:wasm && npm run build -w @agunal/convolve-wasm && npm run build -w @agunal/convolve-demo",
    "test:rust": "cargo test --workspace",
    "test:ts": "npm run test -w @agunal/convolve-wasm",
    "test:e2e": "playwright test -c tests/e2e/playwright.config.ts",
    "test": "npm run test:rust && npm run test:ts",
    "check": "cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings && npm run test && npm run build"
  }
}
```

Create this Rust workspace:

```toml
[workspace]
members = ["crates/convolve-core"]
resolver = "2"
```

Create `rust-toolchain.toml`:

```toml
[toolchain]
channel = "stable"
components = ["clippy", "rustfmt"]
targets = ["wasm32-unknown-unknown"]
profile = "minimal"
```

Ignore `node_modules/`, all `dist/` directories, Rust `target/`, Playwright output, and `packages/convolve-wasm/src/wasm/`.

Create the initial package manifest so workspace commands are valid from the first commit:

```json
{
  "name": "@agunal/convolve-wasm",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "license": "MIT",
  "scripts": {
    "test": "vitest run",
    "build:js": "vite build",
    "build:types": "tsc -p tsconfig.build.json --emitDeclarationOnly",
    "build": "npm run build:js && npm run build:types"
  }
}
```

Also create a compilable Rust crate skeleton in Task 1 so the workspace never points at a missing member:

```toml
[package]
name = "convolve-core"
version = "0.1.0"
edition = "2024"
license = "MIT"
publish = false

[lib]
crate-type = ["cdylib", "rlib"]
```

`crates/convolve-core/src/lib.rs` initially contains only `pub const SAMPLE_RATE: u32 = 48_000;` and a unit test asserting that value. Task 3 replaces the minimal manifest with the full dependency list without changing package identity.

Create `packages/convolve-wasm/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable", "WebWorker"],
    "types": ["vite/client"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true,
    "useDefineForClassFields": true
  },
  "include": ["src", "tests", "vite.config.ts"]
}
```

Create `packages/convolve-wasm/tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "declaration": true,
    "emitDeclarationOnly": true,
    "outDir": "dist"
  },
  "include": ["src/index.ts", "src/types.ts", "src/errors.ts", "src/options.ts"],
  "exclude": ["**/*.test.ts", "tests"]
}
```

Create the initial `packages/convolve-wasm/vite.config.ts`:

```ts
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: {
      entry: "src/index.ts",
      formats: ["es"],
      fileName: "index",
    },
    assetsInlineLimit: 0,
    sourcemap: true,
  },
  worker: { format: "es" },
});
```

- [ ] **Step 2: Install and lock the JavaScript toolchain**

Run:

```bash
npm install -D vite@8.1.4 typescript vitest @vitest/coverage-v8 @playwright/test @types/node
```

Expected: `package-lock.json` is created and `npm ls vite` resolves `vite@8.1.4`.

- [ ] **Step 3: Write the failing public-contract test**

Create `packages/convolve-wasm/src/index.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  ConvolveError,
  DEFAULT_OPTIONS,
  normalizeOptions,
} from "./index";

describe("public contract", () => {
  it("exposes stable defaults", () => {
    expect(DEFAULT_OPTIONS).toEqual({
      beatPan: null,
      panTransitionMs: 20,
      reverseCrossfadeMs: 5,
      targetDbtp: -1,
    });
  });

  it("rejects invalid option ranges", () => {
    expect(() => normalizeOptions({ panTransitionMs: -1 })).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });

  it("keeps a machine-readable error code", () => {
    expect(new ConvolveError("DECODE_FAILED", "bad input").code).toBe(
      "DECODE_FAILED",
    );
  });
});
```

- [ ] **Step 4: Run the contract test and verify failure**

Run:

```bash
npm run test -w @agunal/convolve-wasm -- src/index.test.ts
```

Expected: FAIL because `./index` and exported symbols do not exist yet.

- [ ] **Step 5: Implement the public types, options, and error class**

Implement the exact interfaces in the “Final Public Contract” section. `normalizeOptions()` must merge defaults and reject:

- non-finite numbers;
- `panTransitionMs < 0`;
- `reverseCrossfadeMs < 0`;
- `targetDbtp > 0` or `targetDbtp < -24`;
- `beatPan` outside `null | "a" | "b"`.

`index.ts` exports all public types, `ConvolveError`, `DEFAULT_OPTIONS`, and `normalizeOptions`. Add a temporary `CONVOLVE()` export that throws `ConvolveError("PROCESSING_FAILED", "WASM pipeline is not initialized")`; Task 11 replaces the body without changing the signature.

- [ ] **Step 6: Run tests and type checking**

Run:

```bash
npm run test -w @agunal/convolve-wasm
npx tsc -p packages/convolve-wasm/tsconfig.json --noEmit
```

Expected: all tests PASS and TypeScript reports no errors.

- [ ] **Step 7: Commit the contract**

```bash
git add package.json package-lock.json Cargo.toml rust-toolchain.toml .gitignore README.md packages/convolve-wasm
git commit -m "chore: scaffold convolve wasm workspace"
```

## Task 2: Add Browser-Native WAV/M4A Decoding and Stereo Normalization

**Files:**
- Create: `packages/convolve-wasm/src/decode.ts`
- Create: `packages/convolve-wasm/src/decode.test.ts`
- Modify: `packages/convolve-wasm/src/index.ts`

**Interfaces:**
- Produces: `DecodedStereoAudio`.
- Produces: `AudioDecodeBackend.decode(file: File): Promise<DecodedStereoAudio>`.
- Produces: `WebAudioDecodeBackend`.
- Produces: `decodeInputPair(audio, backend, onProgress)`.
- Consumes: `ConvolveError`, `ConvolveProgress`.

```ts
export interface DecodedStereoAudio {
  sampleRate: 48_000;
  frames: number;
  left: Float32Array;
  right: Float32Array;
}
```

- [ ] **Step 1: Write tests for extension validation and channel normalization**

Create a minimal `AudioBuffer` test double exposing `numberOfChannels`, `length`, `sampleRate`, and `copyFromChannel`. Cover:

1. `.WAV` and `.m4a` are accepted case-insensitively.
2. `.mp3` throws `UNSUPPORTED_EXTENSION`.
3. Mono is copied into two independent, equal arrays.
4. Stereo channels remain separate.
5. Three channels throw `UNSUPPORTED_CHANNEL_COUNT`.
6. A decode rejection becomes `DECODE_FAILED` with the filename in `details`.

Representative test:

```ts
it("duplicates mono into independent stereo arrays", async () => {
  const backend = makeBackend(makeAudioBuffer([[0.25, -0.25]], 48_000));
  const decoded = await backend.decode(new File([new Uint8Array([1])], "x.wav"));

  expect([...decoded.left]).toEqual([0.25, -0.25]);
  expect([...decoded.right]).toEqual([0.25, -0.25]);
  expect(decoded.left).not.toBe(decoded.right);
});
```

- [ ] **Step 2: Run the decoder test and verify failure**

```bash
npm run test -w @agunal/convolve-wasm -- src/decode.test.ts
```

Expected: FAIL because `decode.ts` does not exist.

- [ ] **Step 3: Implement the decode backend**

Use a lazily created, reusable `OfflineAudioContext(2, 1, 48_000)`. Do not instantiate Web Audio globals at module-import time; this keeps package imports safe in Node-based tests and SSR tooling. Call `file.arrayBuffer()`, then `context.decodeAudioData(buffer)`. Copy channel samples with `copyFromChannel`; do not retain `AudioBuffer` channel views. Confirm `decoded.sampleRate === 48_000` and `decoded.length > 0`.

Keep the backend injectable:

```ts
export interface AudioDecodeBackend {
  decode(file: File): Promise<DecodedStereoAudio>;
}

export class WebAudioDecodeBackend implements AudioDecodeBackend {
  constructor(private readonly context: BaseAudioContext) {}

  async decode(file: File): Promise<DecodedStereoAudio> {
    validateSupportedExtension(file.name);
    try {
      const bytes = await file.arrayBuffer();
      const decoded = await this.context.decodeAudioData(bytes);
      return stereoFromAudioBuffer(decoded);
    } catch (cause) {
      if (cause instanceof ConvolveError) throw cause;
      throw new ConvolveError("DECODE_FAILED", `Could not decode ${file.name}`, {
        fileName: file.name,
      }, cause);
    }
  }
}

let defaultBackend: WebAudioDecodeBackend | undefined;

export function getDefaultDecodeBackend(): WebAudioDecodeBackend {
  if (typeof OfflineAudioContext === "undefined") {
    throw new ConvolveError("DECODE_FAILED", "Web Audio decoding is unavailable");
  }
  return (defaultBackend ??= new WebAudioDecodeBackend(
    new OfflineAudioContext(2, 1, 48_000),
  ));
}
```

`decodeInputPair()` decodes A then B, emitting completed progress events for `decode-a` at `0.10` and `decode-b` at `0.20`.

- [ ] **Step 4: Run decoder tests and type checking**

```bash
npm run test -w @agunal/convolve-wasm -- src/decode.test.ts
npx tsc -p packages/convolve-wasm/tsconfig.json --noEmit
```

Expected: PASS.

- [ ] **Step 5: Commit the decoder adapter**

```bash
git add packages/convolve-wasm/src/decode.ts packages/convolve-wasm/src/decode.test.ts packages/convolve-wasm/src/index.ts
git commit -m "feat: decode wav and m4a with web audio"
```

## Task 3: Define Rust Audio Models, Options, Errors, and the 256 MiB Guard

**Files:**
- Modify: `crates/convolve-core/Cargo.toml`
- Modify: `crates/convolve-core/src/lib.rs`
- Create: `crates/convolve-core/src/audio.rs`
- Create: `crates/convolve-core/src/options.rs`
- Create: `crates/convolve-core/src/error.rs`
- Create: `crates/convolve-core/src/limits.rs`
- Create: `crates/convolve-core/tests/processor.rs`

**Interfaces:**
- Produces: `StereoAudio`, `ProcessOptions`, `BeatPanSource`, `ProcessMetadata`, `ConvolveCoreError`.
- Produces: `estimate_peak_bytes(a_frames, b_frames, append_reverse, crossfade_frames) -> Result<usize, ConvolveCoreError>`.
- Consumes: decoded 48 kHz planar stereo arrays from Task 2 only at the later WASM boundary.

- [ ] **Step 1: Add Rust dependencies**

Use these dependency families and commit the resolved `Cargo.lock`:

```toml
[package]
name = "convolve-core"
version = "0.1.0"
edition = "2024"
license = "MIT"
publish = false

[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
hound = "3.5"
js-sys = "0.3"
realfft = "3.5"
serde = { version = "1", features = ["derive"] }
serde-wasm-bindgen = "0.6"
thiserror = "2"
wasm-bindgen = "0.2"

[dev-dependencies]
wasm-bindgen-test = "0.3"
```

- [ ] **Step 2: Write failing validation and memory tests**

Test exact invariants:

```rust
#[test]
fn output_length_is_full_linear_convolution() {
    assert_eq!(convolution_frames(3, 4).unwrap(), 6);
}

#[test]
fn rejects_empty_inputs() {
    let error = StereoAudio::new(48_000, vec![], vec![]).unwrap_err();
    assert_eq!(error.code(), "INVALID_INPUT");
}

#[test]
fn rejects_estimates_over_256_mib() {
    let error = estimate_peak_bytes(20_000_000, 20_000_000, true, 240)
        .unwrap_err();
    assert_eq!(error.code(), "INPUT_TOO_LARGE");
}
```

- [ ] **Step 3: Run the Rust tests and verify failure**

```bash
cargo test -p convolve-core --test processor
```

Expected: FAIL because the crate and symbols are not implemented.

- [ ] **Step 4: Implement validated domain types**

`StereoAudio::new()` must enforce:

- sample rate exactly 48,000;
- non-empty channels;
- equal left/right lengths;
- all samples finite.

`ProcessOptions::default()` must match the TypeScript defaults. Convert milliseconds to samples with rounded `f64` multiplication and checked conversion.

- [ ] **Step 5: Implement the conservative allocation estimate**

For `n = a + b - 1` and `fft_len = n.checked_next_power_of_two()`, estimate:

```text
input bytes       = 2 * (a + b) * sizeof(f32)
forward output    = 2 * n * sizeof(f32)
final output      = forward output, or 2 * (2*n - crossfade) * sizeof(f32)
FFT working set   = 24 * fft_len
fixed headroom    = 16 MiB
```

Use checked arithmetic at every multiplication/addition. Return `INPUT_TOO_LARGE` when the total exceeds exactly `268_435_456` bytes.

- [ ] **Step 6: Run all Rust tests and lints**

```bash
cargo fmt --all
cargo test -p convolve-core
cargo clippy -p convolve-core --all-targets -- -D warnings
```

Expected: PASS with no warnings.

- [ ] **Step 7: Commit the Rust contract and guard**

```bash
git add crates/convolve-core Cargo.lock
git commit -m "feat: add dsp models and wasm memory guard"
```

## Task 4: Implement Correct Stereo FFT Convolution

**Files:**
- Create: `crates/convolve-core/src/convolution.rs`
- Create: `crates/convolve-core/tests/convolution.rs`
- Modify: `crates/convolve-core/src/lib.rs`

**Interfaces:**
- Produces: `convolve_stereo(a: &StereoAudio, b: &StereoAudio) -> Result<StereoAudio, ConvolveCoreError>`.
- Consumes: `StereoAudio` and memory validation from Task 3.

- [ ] **Step 1: Write impulse, known-vector, and channel-isolation tests**

Include:

```rust
#[test]
fn mono_impulse_is_identity() {
    let input = stereo(&[0.25, -0.5, 0.75], &[0.1, 0.2, 0.3]);
    let impulse = stereo(&[1.0], &[1.0]);
    let output = convolve_stereo(&input, &impulse).unwrap();
    assert_approx_eq(&output.left, &input.left, 1e-5);
    assert_approx_eq(&output.right, &input.right, 1e-5);
}

#[test]
fn computes_full_known_convolution() {
    let a = stereo(&[1.0, 2.0], &[3.0, 4.0]);
    let b = stereo(&[5.0, 6.0], &[7.0, 8.0]);
    let output = convolve_stereo(&a, &b).unwrap();
    assert_approx_eq(&output.left, &[5.0, 16.0, 12.0], 1e-4);
    assert_approx_eq(&output.right, &[21.0, 52.0, 32.0], 1e-4);
}
```

Also assert exact output length and that activity in A-left/B-left never leaks into right.

- [ ] **Step 2: Run the convolution test and verify failure**

```bash
cargo test -p convolve-core --test convolution
```

Expected: FAIL because `convolution.rs` is absent.

- [ ] **Step 3: Implement one-channel RealFFT convolution**

Use `fft_len = output_len.next_power_of_two()`. Allocate two zero-padded real buffers, transform both, multiply complex bins, inverse transform, divide every output sample by `fft_len as f32`, and truncate to `output_len`.

```rust
fn convolve_channel(a: &[f32], b: &[f32]) -> Result<Vec<f32>, ConvolveCoreError> {
    let output_len = a.len().checked_add(b.len()).and_then(|v| v.checked_sub(1))
        .ok_or(ConvolveCoreError::InputTooLarge { estimated: usize::MAX, limit: MAX_BYTES })?;
    let fft_len = output_len.checked_next_power_of_two()
        .ok_or(ConvolveCoreError::InputTooLarge {
            estimated: usize::MAX,
            limit: MAX_BYTES,
        })?;

    let mut planner = RealFftPlanner::<f32>::new();
    let forward = planner.plan_fft_forward(fft_len);
    let inverse = planner.plan_fft_inverse(fft_len);

    let mut time_a = forward.make_input_vec();
    let mut time_b = forward.make_input_vec();
    time_a[..a.len()].copy_from_slice(a);
    time_b[..b.len()].copy_from_slice(b);

    let mut spectrum_a = forward.make_output_vec();
    let mut spectrum_b = forward.make_output_vec();
    forward.process(&mut time_a, &mut spectrum_a).map_err(ConvolveCoreError::fft)?;
    forward.process(&mut time_b, &mut spectrum_b).map_err(ConvolveCoreError::fft)?;

    for (left, right) in spectrum_a.iter_mut().zip(spectrum_b) {
        *left *= right;
    }

    let mut output = inverse.make_output_vec();
    inverse.process(&mut spectrum_a, &mut output).map_err(ConvolveCoreError::fft)?;
    let scale = 1.0 / fft_len as f32;
    output.truncate(output_len);
    output.iter_mut().for_each(|sample| *sample *= scale);
    Ok(output)
}
```

Process left and right serially so FFT work buffers are not duplicated across channels. Reject any non-finite output.

- [ ] **Step 4: Run convolution tests and numerical lints**

```bash
cargo test -p convolve-core --test convolution
cargo clippy -p convolve-core --all-targets -- -D warnings
```

Expected: PASS.

- [ ] **Step 5: Commit FFT convolution**

```bash
git add crates/convolve-core/src/convolution.rs crates/convolve-core/src/lib.rs crates/convolve-core/tests/convolution.rs
git commit -m "feat: add stereo fft convolution"
```

## Task 5: Detect a Stable Beat Grid from Audio A or B

**Files:**
- Create: `crates/convolve-core/src/beats.rs`
- Create: `crates/convolve-core/tests/beat_detection.rs`
- Modify: `crates/convolve-core/src/lib.rs`

**Interfaces:**
- Produces: `BeatGrid { anchor_sample, period_samples, bpm, confidence }`.
- Produces: `detect_beat_grid(source: &StereoAudio) -> Result<BeatGrid, ConvolveCoreError>`.
- Produces: `BeatGrid::samples_until(output_frames) -> Vec<usize>`.
- Consumes: selected original input A or B, never the convolved result.

- [ ] **Step 1: Write synthetic click-track tests**

Generate eight-second stereo click tracks at 90, 120, and 160 BPM in test code. Each click is a 5 ms Hann-windowed pulse. Assert:

- estimated BPM is within 3% of target;
- median beat interval is within 20 ms;
- confidence is at least `0.15`;
- `samples_until()` extends past the original source length;
- silence returns `BEAT_DETECTION_FAILED`.

- [ ] **Step 2: Run beat tests and verify failure**

```bash
cargo test -p convolve-core --test beat_detection
```

Expected: FAIL because beat detection is not implemented.

- [ ] **Step 3: Implement the onset envelope**

Use these fixed v1 parameters:

```rust
const FRAME: usize = 2_048;
const HOP: usize = 512;
const MIN_BPM: f32 = 60.0;
const MAX_BPM: f32 = 200.0;
```

Algorithm:

1. Convert to mono with `(L + R) * 0.5`.
2. Frame with a Hann window.
3. Calculate magnitude spectra with RealFFT.
4. For each frame, sum only positive spectral-bin differences from the previous frame.
5. Subtract a centered nine-frame median threshold and clamp negative values to zero.
6. Normalize by maximum envelope value; silence or a zero envelope fails.

- [ ] **Step 4: Implement tempo and phase selection**

Compute autocorrelation over lags corresponding to 60–200 BPM. Pick the strongest lag. Confidence is `best_correlation / zero_lag_correlation`; require at least `0.15`. For every phase from `0..period_frames`, sum the onset envelope at `phase + k * period_frames`; select the maximum-scoring phase. Convert the phase and period to sample positions.

Treat a beat at sample zero as the anchor, not a pan flip. `samples_until()` returns the anchor and every integer period through `output_frames`, using checked addition.

- [ ] **Step 5: Run beat tests and inspect tolerances**

```bash
cargo test -p convolve-core --test beat_detection -- --nocapture
```

Expected: all target BPM tests PASS without widening the stated 3%/20 ms tolerances.

- [ ] **Step 6: Commit beat analysis**

```bash
git add crates/convolve-core/src/beats.rs crates/convolve-core/src/lib.rs crates/convolve-core/tests/beat_detection.rs
git commit -m "feat: detect and extend beat grids"
```

## Task 6: Apply Beat-Synchronized Equal-Power Left/Right Panning

**Files:**
- Create: `crates/convolve-core/src/pan.rs`
- Create: `crates/convolve-core/tests/effects.rs`
- Modify: `crates/convolve-core/src/lib.rs`

**Interfaces:**
- Produces: `apply_beat_pan(audio: &StereoAudio, beats: &[usize], transition_samples: usize) -> StereoAudio`.
- Consumes: convolved stereo audio and extended beat samples from Task 5.

- [ ] **Step 1: Write panning behavior tests**

Use a constant stereo signal and beat positions at one-second intervals. Assert:

- before the first nonzero beat: left contains signal, right is approximately zero;
- after the first flip: right contains signal, left is approximately zero;
- after the second flip: left is active again;
- transition samples contain finite values and no single-sample hard switch;
- output frame count equals input frame count.

- [ ] **Step 2: Run the effect test and verify failure**

```bash
cargo test -p convolve-core --test effects beat_pan
```

Expected: FAIL because `pan.rs` does not exist.

- [ ] **Step 3: Implement the pan trajectory**

Ignore beat positions equal to zero. Start with pan `-1.0`. At every later beat, interpolate pan from the current side to the opposite side over a transition centered on the beat. Cap transition length to half the minimum adjacent beat spacing.

For every sample:

```rust
let mono = 0.5 * (left + right);
let theta = (pan + 1.0) * std::f32::consts::FRAC_PI_4;
out_left = mono * theta.cos();
out_right = mono * theta.sin();
```

- [ ] **Step 4: Run effect tests and lints**

```bash
cargo test -p convolve-core --test effects beat_pan
cargo clippy -p convolve-core --all-targets -- -D warnings
```

Expected: PASS.

- [ ] **Step 5: Commit beat panning**

```bash
git add crates/convolve-core/src/pan.rs crates/convolve-core/src/lib.rs crates/convolve-core/tests/effects.rs
git commit -m "feat: add beat-synchronized stereo panning"
```

## Task 7: Append an Exact Reversal with a Click-Safe Midpoint Crossfade

**Files:**
- Create: `crates/convolve-core/src/reverse.rs`
- Modify: `crates/convolve-core/tests/effects.rs`
- Modify: `crates/convolve-core/src/lib.rs`

**Interfaces:**
- Produces: `append_reversed(audio: &StereoAudio, crossfade_samples: usize) -> Result<StereoAudio, ConvolveCoreError>`.
- Consumes: processed forward audio after optional panning.

- [ ] **Step 1: Add reverse/crossfade tests**

Test exact results for a short vector. Assert:

- zero crossfade returns `forward + exact_reverse` with `2 * n` frames;
- a crossfade of `x` returns `2 * n - x` frames;
- samples outside the overlap are exact forward/reverse copies;
- overlap gains sum to exactly `1.0` within floating-point tolerance;
- a crossfade greater than or equal to input length is clamped to `n - 1`;
- one-frame input is handled without panic.

- [ ] **Step 2: Run the reverse tests and verify failure**

```bash
cargo test -p convolve-core --test effects append_reverse
```

Expected: FAIL because the function is missing.

- [ ] **Step 3: Implement complementary linear overlap**

For overlap index `i` in `0..x`, use:

```rust
let t = (i + 1) as f32 / (x + 1) as f32;
let sample = forward[n - x + i] * (1.0 - t) + reversed[i] * t;
```

Do this independently for left/right. Concatenate `forward[..n-x]`, overlap, and `reversed[x..]`. This avoids a duplicated hard midpoint and keeps the overlap gain sum at one.

- [ ] **Step 4: Run all effect tests**

```bash
cargo test -p convolve-core --test effects
```

Expected: PASS.

- [ ] **Step 5: Commit reverse append**

```bash
git add crates/convolve-core/src/reverse.rs crates/convolve-core/src/lib.rs crates/convolve-core/tests/effects.rs
git commit -m "feat: append crossfaded reversed audio"
```

## Task 8: Add 4× Estimated True-Peak Measurement and Downward-Only Normalization

**Files:**
- Create: `crates/convolve-core/src/peak.rs`
- Modify: `crates/convolve-core/tests/effects.rs`
- Modify: `crates/convolve-core/src/lib.rs`

**Interfaces:**
- Produces: `estimate_true_peak_4x(audio: &StereoAudio) -> f32`.
- Produces: `normalize_true_peak(audio: &mut StereoAudio, target_dbtp: f32) -> PeakResult`.
- Consumes: final waveform after pan/reverse.

```rust
pub struct PeakResult {
    pub applied_gain_db: f32,
    pub estimated_true_peak_dbtp: f32,
}
```

- [ ] **Step 1: Write peak and normalization tests**

Cover:

1. silence returns zero linear peak and `-inf` dBTP metadata;
2. estimate is never below the ordinary sample peak;
3. a high-frequency sine can produce an intersample estimate above its sample peak;
4. an already-safe signal receives exactly 0 dB gain;
5. an unsafe signal is reduced to at most target + `0.05` dB;
6. both channels receive identical gain.

- [ ] **Step 2: Run the peak tests and verify failure**

```bash
cargo test -p convolve-core --test effects true_peak
```

Expected: FAIL because `peak.rs` does not exist.

- [ ] **Step 3: Implement a bounded-memory windowed-sinc estimator**

Use four phases and 32 taps per phase. Generate Blackman-windowed sinc coefficients once per call (or cache them in a pure Rust `OnceLock` on native targets if WASM support is verified). Normalize each phase for unity DC gain. Include the exact original sample peak, then evaluate phases `0.25`, `0.5`, and `0.75` between adjacent input samples with zero padding at boundaries. Do not allocate a 4× output buffer.

Use double precision for coefficient generation and accumulation, then convert the maximum to `f32`.

- [ ] **Step 4: Implement downward-only normalization**

```rust
let target_linear = 10.0_f32.powf(target_dbtp / 20.0);
let gain = if peak > target_linear { target_linear / peak } else { 1.0 };
```

Multiply every left/right sample by the same gain. Re-measure after gain and return metadata. Reject a non-finite target.

- [ ] **Step 5: Run all effect tests**

```bash
cargo test -p convolve-core --test effects
cargo clippy -p convolve-core --all-targets -- -D warnings
```

Expected: PASS.

- [ ] **Step 6: Commit true-peak safety**

```bash
git add crates/convolve-core/src/peak.rs crates/convolve-core/src/lib.rs crates/convolve-core/tests/effects.rs
git commit -m "feat: normalize estimated true peak"
```

## Task 9: Encode PCM24 WAV and Assemble the Deterministic DSP Pipeline

**Files:**
- Create: `crates/convolve-core/src/wav.rs`
- Create: `crates/convolve-core/src/processor.rs`
- Modify: `crates/convolve-core/src/lib.rs`
- Modify: `crates/convolve-core/tests/processor.rs`

**Interfaces:**
- Produces: `process_audio(a, b, append_reverse, options, progress) -> Result<ProcessedAudio, ConvolveCoreError>`.
- Produces: `ProcessedAudio { wav_bytes, metadata }`.
- Consumes: every DSP primitive from Tasks 3–8.

- [ ] **Step 1: Write end-to-end Rust pipeline tests**

Use an impulse and a short deterministic signal. Assert:

- WAV header reports two channels, 48 kHz, 24 bits;
- decoded sample count equals `a + b - 1` without reverse;
- reverse output count equals `2*n-x`;
- beat-pan metadata includes detected beats/BPM when enabled;
- final estimated true peak is at most target + `0.05` dB;
- progress stages occur in order and end with `done`.

- [ ] **Step 2: Run pipeline tests and verify failure**

```bash
cargo test -p convolve-core --test processor
```

Expected: FAIL because the pipeline and encoder are incomplete.

- [ ] **Step 3: Implement signed PCM24 WAV encoding**

Use `hound::WavWriter` with this exact specification:

```rust
hound::WavSpec {
    channels: 2,
    sample_rate: 48_000,
    bits_per_sample: 24,
    sample_format: hound::SampleFormat::Int,
}
```

Interleave left/right. Map samples as follows and write `i32` values through hound: `sample <= -1.0` maps to `-8_388_608`; otherwise clamp to `1.0 - 1.0 / 8_388_608.0`, multiply by `8_388_607.0`, and round. Do not add dither in v1.

- [ ] **Step 4: Implement the exact processing order**

`process_audio()` must execute:

1. validate options and input;
2. calculate crossfade frames and reject over the memory limit;
3. full stereo convolution;
4. if beat pan requested, detect grid from original A/B, extend through convolution output, and pan;
5. if requested, append reversed copy with overlap;
6. estimate and normalize true peak;
7. encode PCM24 WAV;
8. return metadata and emit `done`.

Use a callback generic `F: FnMut(ProgressEvent)` so native tests can capture ordered stages and the WASM binding can forward them to JavaScript.

- [ ] **Step 5: Run all Rust checks**

```bash
cargo fmt --all
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

Expected: PASS.

- [ ] **Step 6: Commit the complete native DSP pipeline**

```bash
git add crates/convolve-core/src crates/convolve-core/tests
git commit -m "feat: assemble convolve processing pipeline"
```

## Task 10: Expose the Pipeline Through wasm-bindgen

**Files:**
- Modify: `crates/convolve-core/src/lib.rs`
- Modify: `crates/convolve-core/tests/wasm_smoke.rs`
- Modify: `package.json`

**Interfaces:**
- Produces: generated `process_audio_wasm(...) -> WasmProcessResult` binding.
- Produces: `WasmProcessResult.wav_bytes(): Uint8Array` and metadata getters.
- Consumes: `process_audio()` from Task 9.

- [ ] **Step 1: Write a failing browser WASM smoke test**

Use `wasm-bindgen-test` to invoke the binding with two impulse channels. Assert the result begins with `RIFF`, metadata sample rate is 48,000, and output frames are one.

- [ ] **Step 2: Run the WASM test and verify failure**

```bash
wasm-pack test --headless --chrome crates/convolve-core
```

Expected: FAIL because the exported binding/result class does not exist.

- [ ] **Step 3: Implement the thin binding layer**

Export a function accepting four boxed float slices, `append_reverse`, a serialized options object, and an optional `js_sys::Function` progress callback. Convert JavaScript options with `serde_wasm_bindgen`, invoke the pure Rust pipeline, and map errors into a serialized object with `code`, `message`, and `details`.

Expose a `WasmProcessResult` class whose `wav_bytes()` returns a `js_sys::Uint8Array`; expose scalar metadata with getters. Do not serialize WAV bytes through JSON or a regular JavaScript number array.

- [ ] **Step 4: Build the generated package**

```bash
npm run build:wasm
```

Expected files under the gitignored `packages/convolve-wasm/src/wasm/` include:

```text
convolve_core.js
convolve_core_bg.wasm
convolve_core.d.ts
```

- [ ] **Step 5: Run native and browser WASM tests**

```bash
cargo test --workspace
wasm-pack test --headless --chrome crates/convolve-core
```

Expected: PASS.

- [ ] **Step 6: Commit only source and configuration**

```bash
git add crates/convolve-core/src/lib.rs crates/convolve-core/tests/wasm_smoke.rs package.json .gitignore
git commit -m "feat: expose convolver through wasm bindings"
```

Confirm `git status --short` does not list generated WASM files.

## Task 11: Add the Module Worker, Transfer Protocol, and Final `CONVOLVE()` API

**Files:**
- Create: `packages/convolve-wasm/src/worker-protocol.ts`
- Create: `packages/convolve-wasm/src/convolve.worker.ts`
- Create: `packages/convolve-wasm/src/worker-client.ts`
- Create: `packages/convolve-wasm/src/worker-client.test.ts`
- Modify: `packages/convolve-wasm/src/index.ts`
- Modify: `packages/convolve-wasm/src/index.test.ts`

**Interfaces:**
- Produces: the final `CONVOLVE()` implementation.
- Produces: one lazy module worker and request-ID-based response routing.
- Consumes: Task 2 decoder and Task 10 generated WASM binding.

```ts
type WorkerRequest = {
  type: "process";
  id: string;
  payload: {
    a: DecodedStereoAudio;
    b: DecodedStereoAudio;
    appendReverse: boolean;
    options: Omit<NormalizedConvolveOptions, "onProgress">;
  };
};

type WorkerResponse =
  | { type: "progress"; id: string; event: ConvolveProgress }
  | { type: "result"; id: string; wav: ArrayBuffer; metadata: ConvolveMetadata }
  | { type: "error"; id: string; error: SerializedConvolveError };
```

- [ ] **Step 1: Write worker-client tests with a fake Worker**

Cover:

- request IDs route interleaved progress/results correctly;
- decoded channel `ArrayBuffer`s appear in the transfer list;
- result buffers are converted to a Blob with `audio/wav`;
- worker errors become `ConvolveError` with original code/details;
- the worker is created lazily and reused.

- [ ] **Step 2: Run worker tests and verify failure**

```bash
npm run test -w @agunal/convolve-wasm -- src/worker-client.test.ts
```

Expected: FAIL because worker files are absent.

- [ ] **Step 3: Implement the module worker**

Create it with the Vite-supported pattern:

```ts
new Worker(new URL("./convolve.worker.ts", import.meta.url), { type: "module" });
```

Inside the worker:

1. lazily initialize `convolve_core.js` and its `.wasm` asset once;
2. emit `load-wasm` progress;
3. call the WASM binding with `Float32Array` inputs;
4. forward Rust progress callbacks;
5. copy WAV bytes into a standalone `ArrayBuffer`;
6. post the result with that buffer in the transfer list;
7. serialize all failures.

The worker event loop naturally serializes synchronous WASM jobs; retain request IDs so queued calls still resolve to the correct promise.

- [ ] **Step 4: Replace the `CONVOLVE()` stub**

Implementation sequence:

```ts
export async function CONVOLVE(
  audio: { a: File; b: File },
  appendReverse = false,
  options: ConvolveOptions = {},
): Promise<ConvolveResult> {
  validateAudioInputObject(audio);
  const normalized = normalizeOptions(options);
  const decoded = await decodeInputPair(audio, getDefaultDecodeBackend(), normalized.onProgress);
  return workerClient.process(decoded, appendReverse, normalized);
}
```

Do not send `onProgress` through structured clone; strip it before the worker request.

- [ ] **Step 5: Add API integration tests**

Inject fake decoder/worker dependencies through an internal, non-exported `createConvolver(deps)` factory. Test that `CONVOLVE()` preserves the exact public signature behavior, option defaults, progress ordering, and returned metadata/Blob.

- [ ] **Step 6: Run TypeScript tests and build**

```bash
npm run test -w @agunal/convolve-wasm
npm run build:wasm
npm run build -w @agunal/convolve-wasm
```

Expected: tests PASS; `dist/` contains the library JS, declaration file, module-worker asset, and `.wasm` asset.

- [ ] **Step 7: Commit the browser orchestration**

```bash
git add packages/convolve-wasm/src packages/convolve-wasm/vite.config.ts packages/convolve-wasm/tsconfig.build.json
git commit -m "feat: run convolve wasm in a browser worker"
```

## Task 12: Prove the Built Package Works from a Consumer

**Files:**
- Create: `packages/convolve-wasm/tests/package-consumer.test.ts`
- Modify: `packages/convolve-wasm/package.json`
- Modify: `packages/convolve-wasm/vite.config.ts`

**Interfaces:**
- Produces: package exports that a separate Vite app can consume.
- Consumes: built library, worker, and WASM assets from Task 11.

- [ ] **Step 1: Write the failing package-consumer test**

Create a test that:

1. runs `npm pack --json` for `@agunal/convolve-wasm` into a temporary directory;
2. creates a tiny temporary Vite consumer;
3. installs the tarball;
4. imports `CONVOLVE` from the package root;
5. runs `vite build`;
6. asserts that the consumer output contains a module-worker asset and a `.wasm` asset.

The temporary consumer must import only the package's documented root export; it must not reach into `dist/` or source paths.

- [ ] **Step 2: Run the consumer test and verify failure**

```bash
npm run build:wasm
npm run build -w @agunal/convolve-wasm
npm run test -w @agunal/convolve-wasm -- tests/package-consumer.test.ts
```

Expected: FAIL because the package export/files contract and asset-preserving build configuration are not finalized.

- [ ] **Step 3: Add the package manifest and asset contract**

Set:

```json
{
  "name": "@agunal/convolve-wasm",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "license": "MIT",
  "files": ["dist"],
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  }
}
```

Preserve the build/test scripts created in Task 1. Build declarations with `tsc -p tsconfig.build.json --emitDeclarationOnly`. Configure Vite library mode with ES format, `assetsInlineLimit: 0`, and `worker.format: "es"` so the WASM is emitted as a separate asset.

- [ ] **Step 4: Rebuild and verify the consumer passes**

```bash
npm run build:wasm
npm run build -w @agunal/convolve-wasm
npm run test -w @agunal/convolve-wasm -- tests/package-consumer.test.ts
```

Expected: PASS with no CDN request and no missing-WASM warning.

- [ ] **Step 5: Verify license boundaries**

```bash
npm ls @ffmpeg/core
npm pack -w @agunal/convolve-wasm --dry-run
```

Expected: the dependency tree shows `@ffmpeg/core` is absent; the dry run contains only the library JS, declarations, worker, WASM asset, package metadata, and license/readme files intended for distribution.

- [ ] **Step 6: Commit package portability**

```bash
git add packages/convolve-wasm/package.json packages/convolve-wasm/vite.config.ts packages/convolve-wasm/tests
git commit -m "test: verify packaged worker and wasm assets"
```

## Task 13: Build a Functional Demo and Automated WAV Browser Tests

**Files:**
- Create: `apps/demo/package.json`
- Create: `apps/demo/index.html`
- Create: `apps/demo/tsconfig.json`
- Create: `apps/demo/vite.config.ts`
- Create: `apps/demo/src/main.ts`
- Create: `apps/demo/src/styles.css`
- Create: `tests/e2e/fixtures.ts`
- Create: `tests/e2e/convolve.spec.ts`
- Create: `tests/e2e/playwright.config.ts`

**Interfaces:**
- Produces: manual browser UI for selecting A/B and processing.
- Produces: Playwright end-to-end proof using generated WAV fixtures.
- Consumes: public package only; demo must not import package internals.

- [ ] **Step 1: Write deterministic fixtures and failing browser tests**

`tests/e2e/fixtures.ts` must create in-memory PCM16 WAV buffers without FFmpeg:

- A: 250 ms impulse/tone;
- B: 100 ms impulse response;
- click track: 8 seconds at 120 BPM.

Write Playwright tests against these required selectors:

```text
#audio-a
#audio-b
#append-reverse
#beat-pan
#pan-transition-ms
#reverse-crossfade-ms
#target-dbtp
#run
#status
#preview
#download
```

Test in Chromium and WebKit:

1. normal convolution creates a playable/downloadable WAV;
2. WAV header is stereo/48 kHz/24-bit;
3. output frame count is `a+b-1`;
4. reverse output count is `2*n-240` frames for a 5 ms crossfade;
5. beat pan reports a nonzero detected beat count on the click track;
6. no uncaught page errors occur.

- [ ] **Step 2: Run E2E and verify the UI contract fails**

```bash
npx playwright install chromium webkit
npm run build:wasm
npm run build -w @agunal/convolve-wasm
npm run test:e2e
```

Expected: FAIL because the demo package and required controls do not exist.

- [ ] **Step 3: Implement the minimal demo UI**

Create `@agunal/convolve-demo` as a private Vite workspace package that depends on `@agunal/convolve-wasm` through the workspace. Include:

- required file inputs accepting `.wav,.m4a,audio/wav,audio/mp4`;
- append-reverse checkbox;
- beat-pan select with Off/A/B;
- numeric transition/crossfade/target controls prefilled with defaults;
- run button;
- accessible progress/status output;
- `<audio id="preview" controls>`;
- download link whose filename ends in `.wav`.

Disable the run button during processing. Revoke the previous Blob URL before creating a new one. Display `ConvolveError.code` and message without exposing a stack trace.

- [ ] **Step 4: Build and rerun E2E**

```bash
npm run build
npm run test:e2e
```

Expected: all WAV tests PASS in Chromium and WebKit.

- [ ] **Step 5: Commit the demo and E2E coverage**

```bash
git add apps/demo tests/e2e package.json package-lock.json
git commit -m "feat: add convolve wasm browser demo"
```

## Task 14: Document Browser Codec Limits and Manually Validate HE-AAC M4A

**Files:**
- Create: `docs/architecture.md`
- Create: `docs/browser-support.md`
- Modify: `README.md`

**Interfaces:**
- Produces: user-facing usage, semantics, limitations, and release checklist.
- Consumes: finalized behavior from all earlier tasks.

- [ ] **Step 1: Document the API with a complete example**

README example:

```ts
import { CONVOLVE } from "@agunal/convolve-wasm";

const result = await CONVOLVE(
  { a: fileA, b: fileB },
  true,
  {
    beatPan: "a",
    panTransitionMs: 20,
    reverseCrossfadeMs: 5,
    targetDbtp: -1,
    onProgress: ({ stage, fraction }) => {
      console.log(stage, `${Math.round(fraction * 100)}%`);
    },
  },
);

const url = URL.createObjectURL(result.wav);
```

Explain the exact effect order, hard-object pan behavior, output length formulas, memory limit, and metadata.

- [ ] **Step 2: Document codec support honestly**

`docs/browser-support.md` must state:

- WAV decoding is the portable baseline.
- M4A is passed to `decodeAudioData()` and therefore depends on codecs available to the browser and operating system.
- A decode failure returns `DECODE_FAILED`; no server fallback exists.
- The known real-world input used to shape this plan is stereo 48 kHz HE-AAC in an M4A container.
- The prebuilt GPL `@ffmpeg/core` is deliberately excluded to preserve an MIT-only v1 distribution.
- A future deterministic M4A backend must be an optional, separately licensed custom audio-only build, with legal review and separate bundle entry point.

- [ ] **Step 3: Perform the manual HE-AAC release check**

Using a known stereo 48 kHz HE-AAC `.m4a` file, validate current desktop Chrome/Edge and Safari:

1. select the HE-AAC file as A and a WAV impulse as B;
2. process without beat pan/reverse;
3. process with `beatPan: "a"` and reverse append;
4. play and download both outputs;
5. confirm metadata and absence of clipping/errors.

Record browser versions, OS, pass/fail, and the M4A profile in `docs/browser-support.md`. Do not commit private audio fixtures.

- [ ] **Step 4: Commit documentation**

```bash
git add README.md docs/architecture.md docs/browser-support.md
git commit -m "docs: explain wasm architecture and codec support"
```

## Task 15: Add CI and Run the Final Release Gate

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `README.md`

**Interfaces:**
- Produces: repeatable automated checks on every push/PR.
- Consumes: all build and test scripts.

- [ ] **Step 1: Add GitHub Actions CI**

Use Ubuntu with these ordered steps:

1. checkout;
2. setup Node satisfying `>=22.12.0`;
3. setup stable Rust with `wasm32-unknown-unknown`, rustfmt, clippy;
4. install `wasm-pack`;
5. `npm ci`;
6. `cargo fmt --all -- --check`;
7. `cargo clippy --workspace --all-targets -- -D warnings`;
8. `cargo test --workspace`;
9. `npm run build:wasm`;
10. `npm run test:ts`;
11. `npm run build`;
12. install Playwright Chromium/WebKit;
13. `npm run test:e2e`.

Cache npm and Cargo registries/target directories without caching generated package output.

- [ ] **Step 2: Run the complete local gate**

```bash
npm ci
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
npm run build:wasm
npm run test:ts
npm run build
npm run test:e2e
npm pack -w @agunal/convolve-wasm --dry-run
npm ls @ffmpeg/core
```

Expected:

- every check except `npm ls @ffmpeg/core` exits zero;
- `npm ls @ffmpeg/core` confirms the dependency is absent;
- npm pack includes JS, declarations, worker asset, and WASM asset;
- no generated WASM files are staged.

- [ ] **Step 3: Verify the definition of done**

The feature is complete only when all statements are true:

- `CONVOLVE({a,b}, appendReverse, options)` is the sole public processing entry point.
- WAV end-to-end tests pass in Chromium and WebKit.
- The manual HE-AAC check passes in at least current Chrome/Edge and Safari, or browser-specific failures are explicitly documented before merge.
- Impulse/known-vector convolution tests prove correct FFT scaling and channel isolation.
- 90/120/160 BPM synthetic tests pass within fixed tolerances.
- Reverse append length and overlap formulas are tested.
- Estimated final true peak stays at or below target + 0.05 dB.
- Requests above the 256 MiB estimate fail before large allocations.
- UI remains responsive during DSP.
- The built package works in a separate consumer and contains no GPL FFmpeg core.
- README, architecture, browser support, and license statements match behavior.

- [ ] **Step 4: Commit CI and final docs state**

```bash
git add .github/workflows/ci.yml README.md package-lock.json Cargo.lock
git commit -m "ci: verify rust wasm and browser pipeline"
```

---

# Plan Review Record

## Draft 1: Pyodide + SciPy + ffmpeg.wasm

The first browser concept reused the Python implementation inside Pyodide and delegated decode/encode to ffmpeg.wasm. Review rejected this as the primary architecture because it adds two large WASM runtimes, increases cold-start and memory pressure, complicates worker coordination, and makes the package harder to ship as a focused audio library.

## Draft 2: One Rust WASM Core with Symphonia Decoding

The second concept moved all work into Rust and considered Symphonia for WAV/M4A decoding. This substantially improved the DSP architecture, but review found a decisive compatibility gap: the actual user M4A inspected for this project is stereo 48 kHz **HE-AAC**, while Symphonia's documented AAC decoder support is AAC-LC. Shipping that design would claim `.m4a` support while failing the motivating file.

## License Review

A deterministic FFmpeg-based decoder would cover HE-AAC, but the standard prebuilt `@ffmpeg/core` package declares GPL-2.0-or-later. Bundling it into an otherwise MIT-only v1 distribution would introduce GPL distribution obligations and a materially different license story. The plan therefore excludes it rather than hiding that trade-off.

## Final Revision

The finalized design uses browser-native `decodeAudioData()` behind an injectable decode interface and puts all project-owned DSP in a single Rust/WASM worker. This revision:

- handles the motivating HE-AAC file on browsers whose native media stack supports it;
- avoids Pyodide and a second WASM runtime;
- preserves a clean MIT-only project bundle;
- provides a future decoder seam without changing the public `CONVOLVE()` API;
- makes codec dependence explicit instead of overpromising cross-browser M4A support;
- makes panning, reverse midpoint, true-peak, output-length, and memory semantics testable;
- bounds v1 scope to offline, single-threaded, batch processing.

## Final Self-Review

- **Spec coverage:** Every public option and required effect is assigned to a task and automated test. Browser-dependent HE-AAC receives an explicit manual release gate.
- **Placeholder scan:** No unfinished markers, deferred implementation language, or unspecified error-handling steps remain.
- **Type consistency:** `BeatPanSource`, progress stages, metadata names, error codes, and the `CONVOLVE()` signature are identical across the contract, worker protocol, tests, and documentation tasks.
- **Scope check:** Decoder abstraction, DSP core, worker wrapper, package proof, demo, tests, and documentation form one cohesive deliverable. Streaming, cancellation, multithreading, server fallback, and publication are explicitly excluded.
- **Risk check:** The principal risks—browser M4A codec variance, WASM memory, FFT scaling, midpoint clicks, and licensing—have concrete gates rather than assumptions.
