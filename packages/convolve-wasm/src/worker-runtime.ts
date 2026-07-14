import type { ConvolveErrorCode } from "./errors";
import type {
  ConvolveMetadata,
  ConvolveStage,
} from "./types";
import type {
  SerializedConvolveError,
  WorkerRequest,
  WorkerResponse,
} from "./worker-protocol";

export interface WasmProcessResultLike {
  readonly sampleRate: number;
  readonly channels: number;
  readonly durationSeconds: number;
  readonly outputFrames: number;
  readonly detectedBeats: number;
  readonly detectedBpm: number | undefined;
  readonly beatConfidence: number | undefined;
  readonly appliedGainDb: number;
  readonly estimatedTruePeakDbtp: number;
  wav_bytes(): Uint8Array;
  free(): void;
}

export interface WasmModuleLike {
  process_audio_wasm(
    aLeft: Float32Array,
    aRight: Float32Array,
    bLeft: Float32Array,
    bRight: Float32Array,
    appendReverse: boolean,
    options: unknown,
    progressCallback?: (stage: string, fraction: number) => void,
  ): WasmProcessResultLike;
}

export interface WorkerRuntimeDependencies {
  loadWasm(): Promise<WasmModuleLike>;
  postMessage(response: WorkerResponse, transfer?: Transferable[]): void;
}

const ERROR_CODES = new Set<ConvolveErrorCode>([
  "INVALID_INPUT",
  "UNSUPPORTED_EXTENSION",
  "DECODE_FAILED",
  "UNSUPPORTED_CHANNEL_COUNT",
  "INPUT_TOO_LARGE",
  "BEAT_DETECTION_FAILED",
  "WASM_INIT_FAILED",
  "PROCESSING_FAILED",
  "ENCODE_FAILED",
]);

const PROGRESS_STAGES = new Set<ConvolveStage>([
  "decode-a",
  "decode-b",
  "load-wasm",
  "validate",
  "convolve",
  "beat-detect",
  "beat-pan",
  "append-reverse",
  "normalize",
  "encode",
  "done",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isErrorCode(value: unknown): value is ConvolveErrorCode {
  return typeof value === "string" && ERROR_CODES.has(value as ConvolveErrorCode);
}

function errorMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message) return cause.message;
  if (isRecord(cause) && typeof cause.message === "string") {
    return cause.message;
  }
  if (typeof cause === "string" && cause) return cause;
  return fallback;
}

function serializeError(
  cause: unknown,
  fallbackCode: ConvolveErrorCode,
  fallbackMessage: string,
): SerializedConvolveError {
  if (isRecord(cause) && isErrorCode(cause.code)) {
    const details = isRecord(cause.details) ? cause.details : undefined;
    return {
      code: cause.code,
      message: errorMessage(cause, fallbackMessage),
      ...(details ? { details } : {}),
    };
  }
  return {
    code: fallbackCode,
    message: errorMessage(cause, fallbackMessage),
  };
}

function metadataFromResult(result: WasmProcessResultLike): ConvolveMetadata {
  if (result.sampleRate !== 48_000 || result.channels !== 2) {
    throw new Error("WASM returned an unsupported output format");
  }
  return {
    sampleRate: 48_000,
    channels: 2,
    durationSeconds: result.durationSeconds,
    outputFrames: result.outputFrames,
    detectedBeats: result.detectedBeats,
    detectedBpm: result.detectedBpm ?? null,
    beatConfidence: result.beatConfidence ?? null,
    appliedGainDb: result.appliedGainDb,
    estimatedTruePeakDbtp: result.estimatedTruePeakDbtp,
  };
}

function asProgressStage(stage: string): ConvolveStage {
  if (!PROGRESS_STAGES.has(stage as ConvolveStage)) {
    throw new Error(`WASM emitted an unknown progress stage: ${stage}`);
  }
  return stage as ConvolveStage;
}

export function createWorkerRequestHandler(
  dependencies: WorkerRuntimeDependencies,
): (request: WorkerRequest) => Promise<void> {
  let wasmPromise: Promise<WasmModuleLike> | undefined;
  const getWasm = () => (wasmPromise ??= dependencies.loadWasm());

  return async (request: WorkerRequest): Promise<void> => {
    dependencies.postMessage({
      type: "progress",
      id: request.id,
      event: { stage: "load-wasm", fraction: 0.25 },
    });

    let wasm: WasmModuleLike;
    try {
      wasm = await getWasm();
    } catch (cause) {
      dependencies.postMessage({
        type: "error",
        id: request.id,
        error: serializeError(
          cause,
          "WASM_INIT_FAILED",
          "Could not initialize the WASM processing core",
        ),
      });
      return;
    }

    let result: WasmProcessResultLike | undefined;
    try {
      const { a, b, appendReverse, options } = request.payload;
      result = wasm.process_audio_wasm(
        a.left,
        a.right,
        b.left,
        b.right,
        appendReverse,
        options,
        (stage, fraction) => {
          dependencies.postMessage({
            type: "progress",
            id: request.id,
            event: { stage: asProgressStage(stage), fraction },
          });
        },
      );

      const wasmBytes = result.wav_bytes();
      const wavCopy = new Uint8Array(wasmBytes.byteLength);
      wavCopy.set(wasmBytes);
      const wav = wavCopy.buffer;
      const metadata = metadataFromResult(result);
      dependencies.postMessage(
        { type: "result", id: request.id, wav, metadata },
        [wav],
      );
    } catch (cause) {
      dependencies.postMessage({
        type: "error",
        id: request.id,
        error: serializeError(
          cause,
          "PROCESSING_FAILED",
          "Audio processing failed",
        ),
      });
    } finally {
      result?.free();
    }
  };
}
