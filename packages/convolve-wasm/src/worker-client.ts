import type { DecodedInputPair, DecodedStereoAudio } from "./decode";
import { ConvolveError } from "./errors";
import type { NormalizedConvolveOptions } from "./options";
import type { ConvolveProgress, ConvolveResult } from "./types";
import type {
  WorkerProcessOptions,
  WorkerRequest,
  WorkerResponse,
} from "./worker-protocol";

export interface WorkerLike {
  postMessage(message: WorkerRequest, transfer?: Transferable[]): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<WorkerResponse>) => void,
  ): void;
  addEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
}

export type WorkerFactory = () => WorkerLike;

interface PendingRequest {
  resolve: (result: ConvolveResult) => void;
  reject: (error: unknown) => void;
  onProgress?: (event: ConvolveProgress) => void;
}

function defaultWorkerFactory(): WorkerLike {
  return new Worker("__CONVOLVE_WORKER_URL__", {
    type: "module",
  }) as WorkerLike;
}

function transferableChannel(samples: Float32Array): Float32Array {
  if (
    samples.buffer instanceof ArrayBuffer &&
    samples.byteOffset === 0 &&
    samples.byteLength === samples.buffer.byteLength
  ) {
    return samples;
  }
  return new Float32Array(samples);
}

function transferableAudio(audio: DecodedStereoAudio): DecodedStereoAudio {
  return {
    sampleRate: 48_000,
    frames: audio.frames,
    left: transferableChannel(audio.left),
    right: transferableChannel(audio.right),
  };
}

function asArrayBuffer(samples: Float32Array): ArrayBuffer {
  if (!(samples.buffer instanceof ArrayBuffer)) {
    throw new ConvolveError(
      "PROCESSING_FAILED",
      "Audio channel storage is not transferable",
    );
  }
  return samples.buffer;
}

export class WorkerClient {
  private worker: WorkerLike | undefined;
  private nextRequestId = 1;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(private readonly workerFactory: WorkerFactory = defaultWorkerFactory) {}

  process(
    decoded: DecodedInputPair,
    appendReverse: boolean,
    options: NormalizedConvolveOptions,
  ): Promise<ConvolveResult> {
    const worker = this.getWorker();
    const id = `convolve-${this.nextRequestId++}`;
    const a = transferableAudio(decoded.a);
    const b = transferableAudio(decoded.b);
    const { onProgress, ...workerOptions } = options;

    const request: WorkerRequest = {
      type: "process",
      id,
      payload: {
        a,
        b,
        appendReverse,
        options: workerOptions satisfies WorkerProcessOptions,
      },
    };
    const transfer: Transferable[] = [
      asArrayBuffer(a.left),
      asArrayBuffer(a.right),
      asArrayBuffer(b.left),
      asArrayBuffer(b.right),
    ];

    return new Promise<ConvolveResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      try {
        worker.postMessage(request, transfer);
      } catch (cause) {
        this.pending.delete(id);
        reject(
          cause instanceof ConvolveError
            ? cause
            : new ConvolveError(
                "PROCESSING_FAILED",
                "Could not transfer audio to the processing worker",
                undefined,
                cause,
              ),
        );
      }
    });
  }

  private getWorker(): WorkerLike {
    if (this.worker) return this.worker;

    const worker = this.workerFactory();
    worker.addEventListener("message", (event) => {
      this.handleMessage(event.data);
    });
    worker.addEventListener("error", (event) => {
      const message = event.message || "The processing worker failed";
      this.rejectAll(
        new ConvolveError("PROCESSING_FAILED", message, {
          fileName: event.filename,
          lineNumber: event.lineno,
          columnNumber: event.colno,
        }),
      );
    });
    this.worker = worker;
    return worker;
  }

  private handleMessage(response: WorkerResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;

    if (response.type === "progress") {
      pending.onProgress?.(response.event);
      return;
    }

    this.pending.delete(response.id);
    if (response.type === "error") {
      pending.reject(
        new ConvolveError(
          response.error.code,
          response.error.message,
          response.error.details,
        ),
      );
      return;
    }

    pending.resolve({
      wav: new Blob([response.wav], { type: "audio/wav" }),
      metadata: response.metadata,
    });
  }

  private rejectAll(error: ConvolveError): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}
