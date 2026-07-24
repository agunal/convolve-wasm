import { safeDiagnosticError } from "./diagnostics";
import type { ConvolveErrorCode } from "./errors";
import type { ConvolveMetadata, ConvolveStage } from "./types";
import {
  PCM24_CHUNK_FRAMES,
  WAV_HEADER_BYTES,
  type CancelRequest,
  type PullOutputRequest,
  type SerializedConvolveError,
  type WorkerProcessRequest,
  type WorkerDiagnosticEvent,
  type WorkerRequest,
  type WorkerResponse,
} from "./worker-protocol";

interface WasmMetadataLike {
  readonly sampleRate: number;
  readonly channels: number;
  readonly durationSeconds: number;
  readonly outputFrames: number;
  readonly detectedBeats: number;
  readonly detectedBpm: number | undefined;
  readonly beatConfidence: number | undefined;
  readonly appliedGainDb: number;
  readonly estimatedTruePeakDbtp: number;
  free(): void;
}

export interface WasmProcessResultLike extends WasmMetadataLike {
  wav_bytes(): Uint8Array;
}

export interface WasmOutputSessionLike extends WasmMetadataLike {
  wav_header(): Uint8Array;
  pcm24_chunk(offset: number, frames: number): Uint8Array;
}

export interface WasmProcessJobLike {
  process(
    progress?: (stage: string, fraction: number) => void,
  ): WasmOutputSessionLike;
  free(): void;
}

export interface WasmModuleLike {
  WasmProcessJob?: new (
    aLeft: Float32Array,
    aRight: Float32Array,
    bLeft: Float32Array,
    bRight: Float32Array,
    appendReverse: boolean,
    options: unknown,
  ) => WasmProcessJobLike;
  process_audio_wasm?(
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
  return (
    typeof value === "string" && ERROR_CODES.has(value as ConvolveErrorCode)
  );
}

function errorMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message) return cause.message;
  if (isRecord(cause) && typeof cause.message === "string") {
    return cause.message;
  }
  return typeof cause === "string" && cause ? cause : fallback;
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

function metadataFromResult(result: WasmMetadataLike): ConvolveMetadata {
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

function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength &&
    bytes.buffer instanceof ArrayBuffer
    ? bytes.buffer
    : bytes.slice().buffer;
}

interface ActiveOutput {
  request: WorkerProcessRequest;
  job: WasmProcessJobLike;
  session: WasmOutputSessionLike;
  metadata: ConvolveMetadata;
  nextSequence: number;
  nextOffset: number;
}

interface StartingOutput {
  request: WorkerProcessRequest;
  cancelled: boolean;
}

export function createWorkerRequestHandler(
  dependencies: WorkerRuntimeDependencies,
): (request: WorkerRequest) => Promise<void> {
  let wasmPromise: Promise<WasmModuleLike> | undefined;

  function reportDiagnostic(id: string, event: WorkerDiagnosticEvent): void {
    try {
      dependencies.postMessage({ type: "diagnostic", id, event });
    } catch {
      // Diagnostic delivery cannot affect worker processing.
    }
  }

  function getWasm(id: string): Promise<WasmModuleLike> {
    if (wasmPromise) return wasmPromise;

    reportDiagnostic(id, { type: "wasm-init-start" });
    try {
      const loading = dependencies.loadWasm();
      wasmPromise = loading.then(
        (module) => {
          reportDiagnostic(id, { type: "wasm-init-success" });
          return module;
        },
        (cause) => {
          reportDiagnostic(id, {
            type: "wasm-init-failure",
            error: safeDiagnosticError(cause),
          });
          throw cause;
        },
      );
    } catch (cause) {
      reportDiagnostic(id, {
        type: "wasm-init-failure",
        error: safeDiagnosticError(cause),
      });
      throw cause;
    }
    return wasmPromise;
  }
  const queued: WorkerProcessRequest[] = [];
  let active: ActiveOutput | undefined;
  let starting: StartingOutput | undefined;
  let draining = false;

  function cleanup(state: ActiveOutput | undefined): void {
    if (!state) return;
    try {
      state.session.free();
    } catch {
      // Cleanup is best effort after a terminal state transition.
    }
    try {
      state.job.free();
    } catch {
      // Cleanup is best effort after a terminal state transition.
    }
  }

  function fail(
    id: string,
    cause: unknown,
    code: ConvolveErrorCode = "PROCESSING_FAILED",
    message = "Audio processing failed",
  ): void {
    try {
      dependencies.postMessage({
        type: "error",
        id,
        error: serializeError(cause, code, message),
      });
    } catch {
      // There is no remaining delivery path after postMessage fails.
    }
  }

  async function startNext(): Promise<void> {
    if (active || draining) return;

    const request = queued.shift();
    if (!request) return;

    const start: StartingOutput = { request, cancelled: false };
    starting = start;
    draining = true;

    try {
      dependencies.postMessage({
        type: "progress",
        id: request.id,
        event: { stage: "load-wasm", fraction: 0.25 },
      });

      let wasm: WasmModuleLike;
      try {
        wasm = await getWasm(request.id);
      } catch (cause) {
        if (!start.cancelled) {
          fail(
            request.id,
            cause,
            "WASM_INIT_FAILED",
            "Could not initialize the WASM processing core",
          );
        }
        return;
      }
      if (start.cancelled) return;

      if (!wasm.WasmProcessJob) {
        // Compatibility only for older generated assets; never selected by the
        // current build.
        if (!wasm.process_audio_wasm) {
          throw new Error("WASM module does not export WasmProcessJob");
        }
        const { a, b, appendReverse, options } = request.payload;
        const legacy = wasm.process_audio_wasm(
          a.left,
          a.right,
          b.left,
          b.right,
          appendReverse,
          options,
          (stage, fraction) =>
            dependencies.postMessage({
              type: "progress",
              id: request.id,
              event: { stage: asProgressStage(stage), fraction },
            }),
        );
        if (start.cancelled) {
          legacy.free();
          return;
        }
        const wav = exactBuffer(legacy.wav_bytes());
        const metadata = metadataFromResult(legacy);
        legacy.free();
        dependencies.postMessage(
          { type: "result", id: request.id, wav, metadata },
          [wav],
        );
        return;
      }

      const { a, b, appendReverse, options } = request.payload;
      const job = new wasm.WasmProcessJob(
        a.left,
        a.right,
        b.left,
        b.right,
        appendReverse,
        options,
      );

      // The JS channels are no longer needed after the wasm-bindgen constructor
      // copied them.
      request.payload.a.left = new Float32Array(0);
      request.payload.a.right = new Float32Array(0);
      request.payload.b.left = new Float32Array(0);
      request.payload.b.right = new Float32Array(0);

      if (start.cancelled) {
        job.free();
        return;
      }

      let session: WasmOutputSessionLike;
      try {
        session = job.process((stage, fraction) =>
          dependencies.postMessage({
            type: "progress",
            id: request.id,
            event: { stage: asProgressStage(stage), fraction },
          }),
        );
      } catch (cause) {
        job.free();
        throw cause;
      }
      if (start.cancelled) {
        session.free();
        job.free();
        return;
      }

      let metadata: ConvolveMetadata;
      let header: ArrayBuffer;
      try {
        metadata = metadataFromResult(session);
        header = exactBuffer(session.wav_header());
        if (header.byteLength !== WAV_HEADER_BYTES) {
          throw new Error("WASM returned an invalid WAV header");
        }
      } catch (cause) {
        session.free();
        job.free();
        throw cause;
      }
      if (start.cancelled) {
        session.free();
        job.free();
        return;
      }

      active = {
        request,
        job,
        session,
        metadata,
        nextSequence: 0,
        nextOffset: 0,
      };
      dependencies.postMessage(
        { type: "output-start", id: request.id, header, metadata },
        [header],
      );
    } catch (cause) {
      const state = active;
      if (state?.request === request) {
        active = undefined;
        cleanup(state);
      }
      if (!start.cancelled) fail(request.id, cause);
    } finally {
      if (starting === start) starting = undefined;
      draining = false;
      if (!active) void startNext();
    }
  }

  function finish(state: ActiveOutput): void {
    dependencies.postMessage({
      type: "progress",
      id: state.request.id,
      event: { stage: "encode", fraction: 0.97 },
    });
    dependencies.postMessage({
      type: "progress",
      id: state.request.id,
      event: { stage: "done", fraction: 1 },
    });
    dependencies.postMessage({
      type: "result",
      id: state.request.id,
      metadata: state.metadata,
    });
    cleanup(state);
    active = undefined;
    void startNext();
  }

  async function handleProcess(request: WorkerProcessRequest): Promise<void> {
    queued.push(request);
    await startNext();
  }

  function handleCancel(request: CancelRequest): void {
    if (active?.request.id === request.id) {
      const state = active;
      active = undefined;
      cleanup(state);
      fail(request.id, new Error("Processing cancelled"));
      void startNext();
      return;
    }

    if (starting?.request.id === request.id) {
      starting.cancelled = true;
      fail(request.id, new Error("Processing cancelled"));
      return;
    }

    const index = queued.findIndex((item) => item.id === request.id);
    if (index >= 0) {
      queued.splice(index, 1);
      fail(request.id, new Error("Processing cancelled"));
    }
  }

  function handlePull(request: PullOutputRequest): void {
    const state = active;
    if (!state || state.request.id !== request.id) return;

    try {
      if (
        request.sequence !== state.nextSequence ||
        request.offset !== state.nextOffset ||
        request.frames <= 0 ||
        request.frames > PCM24_CHUNK_FRAMES ||
        request.frames > state.metadata.outputFrames - state.nextOffset
      ) {
        throw new Error("Invalid output pull sequence");
      }

      const pcm = exactBuffer(
        state.session.pcm24_chunk(request.offset, request.frames),
      );
      if (pcm.byteLength !== request.frames * 6) {
        throw new Error("WASM returned an invalid PCM chunk length");
      }

      dependencies.postMessage(
        {
          type: "output-chunk",
          id: request.id,
          sequence: request.sequence,
          offset: request.offset,
          frames: request.frames,
          pcm,
        },
        [pcm],
      );
      state.nextSequence += 1;
      state.nextOffset += request.frames;

      if (state.nextOffset === state.metadata.outputFrames) {
        finish(state);
      }
    } catch (cause) {
      active = undefined;
      cleanup(state);
      fail(request.id, cause);
      void startNext();
    }
  }

  return async (request: WorkerRequest): Promise<void> => {
    switch (request.type) {
      case "process":
        await handleProcess(request);
        break;
      case "cancel":
        handleCancel(request);
        break;
      case "pull-output":
        handlePull(request);
        break;
    }
  };
}
