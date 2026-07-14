import {
  decodeInputPair,
  type AudioDecodeBackend,
  type DecodedInputPair,
} from "./decode";
import { ConvolveError } from "./errors";
import { normalizeOptions, type NormalizedConvolveOptions } from "./options";
import type { ConvolveOptions, ConvolveResult } from "./types";

export interface ConvolverWorkerClient {
  process(
    decoded: DecodedInputPair,
    appendReverse: boolean,
    options: NormalizedConvolveOptions,
  ): Promise<ConvolveResult>;
}

export interface ConvolverDependencies {
  getDecodeBackend(): AudioDecodeBackend;
  workerClient: ConvolverWorkerClient;
}

function isFile(value: unknown): value is File {
  return typeof File !== "undefined" && value instanceof File;
}

export function validateAudioInputObject(
  audio: unknown,
): asserts audio is { a: File; b: File } {
  if (
    typeof audio !== "object" ||
    audio === null ||
    !("a" in audio) ||
    !("b" in audio) ||
    !isFile(audio.a) ||
    !isFile(audio.b)
  ) {
    throw new ConvolveError(
      "INVALID_INPUT",
      "audio must contain File values named a and b",
    );
  }
}

export function createConvolver(dependencies: ConvolverDependencies) {
  return async function convolve(
    audio: { a: File; b: File },
    appendReverse = false,
    options: ConvolveOptions = {},
  ): Promise<ConvolveResult> {
    validateAudioInputObject(audio);
    if (typeof appendReverse !== "boolean") {
      throw new ConvolveError(
        "INVALID_INPUT",
        "appendReverse must be a boolean",
        { appendReverse },
      );
    }

    const normalized = normalizeOptions(options);
    const decoded = await decodeInputPair(
      audio,
      dependencies.getDecodeBackend(),
      normalized.onProgress,
    );
    return dependencies.workerClient.process(
      decoded,
      appendReverse,
      normalized,
    );
  };
}
