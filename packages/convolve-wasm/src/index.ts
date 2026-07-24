export { ConvolveError } from "./errors";
export type { ConvolveErrorCode } from "./errors";
export { DEFAULT_OPTIONS, normalizeOptions } from "./options";
export type { NormalizedConvolveOptions } from "./options";
export type {
  BeatPanSource,
  ConvolveMetadata,
  ConvolveOptions,
  ConvolveProgress,
  ConvolveResult,
  ConvolveStage,
} from "./types";

import { createConvolver } from "./convolver";
import { getDefaultDecodeBackend } from "./decode";
import { emitBrowserDiagnostic } from "./diagnostics";
import type { ConvolveOptions, ConvolveResult } from "./types";
import { WorkerClient } from "./worker-client";

const diagnostics = emitBrowserDiagnostic;
const convolve = createConvolver({
  getDecodeBackend: getDefaultDecodeBackend,
  diagnostics,
  workerClient: new WorkerClient(undefined, diagnostics),
});

export async function CONVOLVE(
  audio: { a: File; b: File },
  appendReverse = false,
  options: ConvolveOptions = {},
): Promise<ConvolveResult> {
  return convolve(audio, appendReverse, options);
}
