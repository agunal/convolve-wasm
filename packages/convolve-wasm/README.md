<p align="center">
  <img src="https://raw.githubusercontent.com/agunal/convolve-wasm/main/docs/assets/convolve-wasm-logo.png" alt="convolve-wasm logo" width="192" />
</p>

# @agunal/convolve-wasm

Browser-side stereo audio convolution backed by a Rust/WebAssembly DSP core and a dedicated module worker.

```ts
import { CONVOLVE } from "@agunal/convolve-wasm";

const result = await CONVOLVE({ a: fileA, b: fileB });
const url = URL.createObjectURL(result.wav);
```

The public package includes its worker and WebAssembly assets. Consumers should import only from the package root; no CDN or server-side audio processing is required.
