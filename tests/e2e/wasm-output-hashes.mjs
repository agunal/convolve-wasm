import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { WasmProcessJob, initSync } from "../../packages/convolve-wasm/src/wasm/convolve_core.js";
import {
  clickTrackPcm16,
  impulseResponsePcm16,
  sourceAPcm16,
} from "./fixture-pcm.mjs";

const PCM24_CHUNK_FRAMES = 65_536;
const expected = {
  plain: "301846c1872c07cf8dbc71d62d524cd2a9c7aa3d9aab921ff8c475702b707a3c",
  reverse: "85ba256457e2ec737e0418f31fdcd5347a8d92d1acc1b2b81d556fbd786b8074",
  "beat-pan": "c393693260a14edf78536cb0535a439cd9a57c59f0520f2bc5270f2f58b06162",
};

initSync({
  module: readFileSync(
    new URL("../../packages/convolve-wasm/src/wasm/convolve_core_bg.wasm", import.meta.url),
  ),
});

function decodedMono(pcm) {
  // Web Audio decodes signed PCM16 WAV samples to s / 32768. The browser fixture
  // writes these exact PCM frames; duplicate mono to stereo exactly as decode.ts.
  const left = Float32Array.from(pcm, (sample) => sample / 32_768);
  return { left, right: left.slice() };
}

function streamingWav(aPcm, bPcm, appendReverse, beatPan) {
  const a = decodedMono(aPcm);
  const b = decodedMono(bPcm);
  const job = new WasmProcessJob(a.left, a.right, b.left, b.right, appendReverse, {
    beatPan,
    panTransitionMs: 20,
    reverseCrossfadeMs: 5,
    targetDbtp: -1,
  });
  try {
    const session = job.process();
    try {
      const chunks = [session.wav_header()];
      for (let offset = 0; offset < session.outputFrames; offset += PCM24_CHUNK_FRAMES) {
        chunks.push(
          session.pcm24_chunk(
            offset,
            Math.min(PCM24_CHUNK_FRAMES, session.outputFrames - offset),
          ),
        );
      }
      return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    } finally {
      session.free();
    }
  } finally {
    job.free();
  }
}

const cases = {
  plain: () => streamingWav(sourceAPcm16(), impulseResponsePcm16(), false, null),
  reverse: () => streamingWav(sourceAPcm16(), impulseResponsePcm16(), true, null),
  "beat-pan": () => streamingWav(clickTrackPcm16(), impulseResponsePcm16(), false, "a"),
};

const hashes = Object.fromEntries(
  Object.entries(cases).map(([name, makeWav]) => [
    name,
    createHash("sha256").update(makeWav()).digest("hex"),
  ]),
);

for (const [name, hash] of Object.entries(expected)) {
  if (hashes[name] !== hash) {
    throw new Error(`${name} generated-WASM streamed WAV SHA-256 changed: ${hashes[name]}`);
  }
}
console.log("generated-WASM streamed E2E fixture hashes match");