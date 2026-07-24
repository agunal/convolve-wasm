import type { DecodedStereoAudio } from "./decode";
import type { SafeDiagnosticError } from "./diagnostics";
import type { ConvolveErrorCode } from "./errors";
import type { NormalizedConvolveOptions } from "./options";
import type { ConvolveMetadata, ConvolveProgress } from "./types";

export const PCM24_CHUNK_FRAMES = 65_536;
export const WAV_HEADER_BYTES = 68;
export type WorkerProcessOptions = Omit<NormalizedConvolveOptions, "onProgress">;

export type WorkerDiagnosticEvent =
  | { type: "wasm-init-start" }
  | { type: "wasm-init-success" }
  | { type: "wasm-init-failure"; error: SafeDiagnosticError };
export interface SerializedConvolveError {
  code: ConvolveErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export interface WorkerProcessRequest {
  type: "process";
  id: string;
  payload: {
    a: DecodedStereoAudio;
    b: DecodedStereoAudio;
    appendReverse: boolean;
    options: WorkerProcessOptions;
  };
}

export interface PullOutputRequest {
  type: "pull-output";
  id: string;
  sequence: number;
  offset: number;
  frames: number;
}

export interface CancelRequest {
  type: "cancel";
  id: string;
}

export type WorkerRequest =
  | WorkerProcessRequest
  | PullOutputRequest
  | CancelRequest;

export type WorkerResponse =
  | { type: "progress"; id: string; event: ConvolveProgress }
  | { type: "diagnostic"; id: string; event: WorkerDiagnosticEvent }
  | {
      type: "output-start";
      id: string;
      header: ArrayBuffer;
      metadata: ConvolveMetadata;
    }
  | {
      type: "output-chunk";
      id: string;
      sequence: number;
      offset: number;
      frames: number;
      pcm: ArrayBuffer;
    }
  | {
      type: "result";
      id: string;
      metadata: ConvolveMetadata;
      wav?: ArrayBuffer;
    }
  | { type: "error"; id: string; error: SerializedConvolveError };
