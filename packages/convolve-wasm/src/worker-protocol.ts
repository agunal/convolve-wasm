import type { DecodedStereoAudio } from "./decode";
import type { ConvolveErrorCode } from "./errors";
import type { NormalizedConvolveOptions } from "./options";
import type { ConvolveMetadata, ConvolveProgress } from "./types";

export type WorkerProcessOptions = Omit<
  NormalizedConvolveOptions,
  "onProgress"
>;

export interface SerializedConvolveError {
  code: ConvolveErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export type WorkerRequest = {
  type: "process";
  id: string;
  payload: {
    a: DecodedStereoAudio;
    b: DecodedStereoAudio;
    appendReverse: boolean;
    options: WorkerProcessOptions;
  };
};

export type WorkerResponse =
  | { type: "progress"; id: string; event: ConvolveProgress }
  | {
      type: "result";
      id: string;
      wav: ArrayBuffer;
      metadata: ConvolveMetadata;
    }
  | { type: "error"; id: string; error: SerializedConvolveError };
