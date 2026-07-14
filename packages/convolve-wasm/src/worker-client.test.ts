import { describe, expect, it, vi } from "vitest";

import type { DecodedInputPair } from "./decode";
import { normalizeOptions } from "./options";
import type { ConvolveMetadata, ConvolveProgress } from "./types";
import { WorkerClient } from "./worker-client";
import type {
  WorkerRequest,
  WorkerResponse,
} from "./worker-protocol";

interface PostedMessage {
  message: WorkerRequest;
  transfer: Transferable[];
}

class FakeWorker {
  readonly posts: PostedMessage[] = [];
  readonly messageListeners = new Set<
    (event: MessageEvent<WorkerResponse>) => void
  >();
  readonly errorListeners = new Set<(event: ErrorEvent) => void>();

  postMessage(message: WorkerRequest, transfer: Transferable[] = []): void {
    this.posts.push({ message, transfer });
  }

  addEventListener(
    type: "message",
    listener: (event: MessageEvent<WorkerResponse>) => void,
  ): void;
  addEventListener(
    type: "error",
    listener: (event: ErrorEvent) => void,
  ): void;
  addEventListener(
    type: "message" | "error",
    listener:
      | ((event: MessageEvent<WorkerResponse>) => void)
      | ((event: ErrorEvent) => void),
  ): void {
    if (type === "message") {
      this.messageListeners.add(
        listener as (event: MessageEvent<WorkerResponse>) => void,
      );
    } else {
      this.errorListeners.add(listener as (event: ErrorEvent) => void);
    }
  }

  emitMessage(data: WorkerResponse): void {
    const event = { data } as MessageEvent<WorkerResponse>;
    for (const listener of this.messageListeners) listener(event);
  }
}

const metadata = (outputFrames: number): ConvolveMetadata => ({
  sampleRate: 48_000,
  channels: 2,
  durationSeconds: outputFrames / 48_000,
  outputFrames,
  detectedBeats: 0,
  detectedBpm: null,
  beatConfidence: null,
  appliedGainDb: 0,
  estimatedTruePeakDbtp: -1,
});

const decodedPair = (): DecodedInputPair => ({
  a: {
    sampleRate: 48_000,
    frames: 2,
    left: new Float32Array([1, 2]),
    right: new Float32Array([3, 4]),
  },
  b: {
    sampleRate: 48_000,
    frames: 2,
    left: new Float32Array([5, 6]),
    right: new Float32Array([7, 8]),
  },
});

describe("WorkerClient", () => {
  it("creates one worker lazily and routes interleaved responses by request id", async () => {
    const worker = new FakeWorker();
    const factory = vi.fn(() => worker);
    const client = new WorkerClient(factory);
    const firstProgress: ConvolveProgress[] = [];
    const secondProgress: ConvolveProgress[] = [];

    expect(factory).not.toHaveBeenCalled();
    const first = client.process(decodedPair(), false, {
      ...normalizeOptions(),
      onProgress: (event) => firstProgress.push(event),
    });
    const second = client.process(decodedPair(), true, {
      ...normalizeOptions(),
      onProgress: (event) => secondProgress.push(event),
    });

    expect(factory).toHaveBeenCalledTimes(1);
    const firstId = worker.posts[0]?.message.id;
    const secondId = worker.posts[1]?.message.id;
    expect(firstId).toBeTruthy();
    expect(secondId).toBeTruthy();
    expect(firstId).not.toBe(secondId);

    worker.emitMessage({
      type: "progress",
      id: secondId!,
      event: { stage: "convolve", fraction: 0.55 },
    });
    worker.emitMessage({
      type: "progress",
      id: firstId!,
      event: { stage: "validate", fraction: 0.3 },
    });
    worker.emitMessage({
      type: "result",
      id: firstId!,
      wav: Uint8Array.from([82, 73, 70, 70]).buffer,
      metadata: metadata(3),
    });
    worker.emitMessage({
      type: "result",
      id: secondId!,
      wav: Uint8Array.from([87, 65, 86, 69]).buffer,
      metadata: metadata(4),
    });

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstProgress).toEqual([{ stage: "validate", fraction: 0.3 }]);
    expect(secondProgress).toEqual([{ stage: "convolve", fraction: 0.55 }]);
    expect(firstResult.metadata.outputFrames).toBe(3);
    expect(secondResult.metadata.outputFrames).toBe(4);
  });

  it("transfers every decoded channel buffer and returns an audio/wav Blob", async () => {
    const worker = new FakeWorker();
    const client = new WorkerClient(() => worker);
    const decoded = decodedPair();
    const promise = client.process(decoded, false, normalizeOptions());
    const post = worker.posts[0];

    expect(post?.transfer).toEqual([
      decoded.a.left.buffer,
      decoded.a.right.buffer,
      decoded.b.left.buffer,
      decoded.b.right.buffer,
    ]);
    expect(post?.message.payload.options).toEqual({
      beatPan: null,
      panTransitionMs: 20,
      reverseCrossfadeMs: 5,
      targetDbtp: -1,
    });
    expect("onProgress" in (post?.message.payload.options ?? {})).toBe(false);

    worker.emitMessage({
      type: "result",
      id: post!.message.id,
      wav: Uint8Array.from([82, 73, 70, 70]).buffer,
      metadata: metadata(3),
    });
    const result = await promise;
    expect(result.wav.type).toBe("audio/wav");
    expect(Array.from(new Uint8Array(await result.wav.arrayBuffer()))).toEqual([
      82, 73, 70, 70,
    ]);
  });

  it("reconstructs stable worker errors as ConvolveError", async () => {
    const worker = new FakeWorker();
    const client = new WorkerClient(() => worker);
    const promise = client.process(decodedPair(), false, normalizeOptions());
    const id = worker.posts[0]!.message.id;

    worker.emitMessage({
      type: "error",
      id,
      error: {
        code: "INPUT_TOO_LARGE",
        message: "request exceeds the fixed limit",
        details: { estimatedBytes: 300_000_000, limitBytes: 268_435_456 },
      },
    });

    await expect(promise).rejects.toMatchObject({
      code: "INPUT_TOO_LARGE",
      details: { estimatedBytes: 300_000_000, limitBytes: 268_435_456 },
    });
  });
});
