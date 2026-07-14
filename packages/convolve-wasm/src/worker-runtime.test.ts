import { describe, expect, it, vi } from "vitest";

import type { WorkerRequest, WorkerResponse } from "./worker-protocol";
import { createWorkerRequestHandler } from "./worker-runtime";

const request = (id: string): WorkerRequest => ({
  type: "process",
  id,
  payload: {
    a: {
      sampleRate: 48_000,
      frames: 1,
      left: new Float32Array([1]),
      right: new Float32Array([1]),
    },
    b: {
      sampleRate: 48_000,
      frames: 1,
      left: new Float32Array([1]),
      right: new Float32Array([1]),
    },
    appendReverse: false,
    options: {
      beatPan: null,
      panTransitionMs: 20,
      reverseCrossfadeMs: 5,
      targetDbtp: -1,
    },
  },
});

describe("worker request runtime", () => {
  it("loads WASM once, forwards progress, copies bytes, and frees results", async () => {
    const free = vi.fn();
    const processAudio = vi.fn(
      (
        _aLeft: Float32Array,
        _aRight: Float32Array,
        _bLeft: Float32Array,
        _bRight: Float32Array,
        _appendReverse: boolean,
        _options: unknown,
        progress?: (stage: string, fraction: number) => void,
      ) => {
        progress?.("validate", 0.3);
        return {
          sampleRate: 48_000,
          channels: 2,
          durationSeconds: 1 / 48_000,
          outputFrames: 1,
          detectedBeats: 0,
          detectedBpm: undefined,
          beatConfidence: undefined,
          appliedGainDb: 0,
          estimatedTruePeakDbtp: -1,
          wav_bytes: () => Uint8Array.from([82, 73, 70, 70]),
          free,
        };
      },
    );
    const loadWasm = vi.fn(async () => ({ process_audio_wasm: processAudio }));
    const posts: Array<{ response: WorkerResponse; transfer: Transferable[] }> = [];
    const handle = createWorkerRequestHandler({
      loadWasm,
      postMessage: (response, transfer = []) => posts.push({ response, transfer }),
    });

    await handle(request("one"));
    await handle(request("two"));

    expect(loadWasm).toHaveBeenCalledTimes(1);
    expect(processAudio).toHaveBeenCalledTimes(2);
    expect(free).toHaveBeenCalledTimes(2);
    expect(posts[0]?.response).toEqual({
      type: "progress",
      id: "one",
      event: { stage: "load-wasm", fraction: 0.25 },
    });
    expect(posts[1]?.response).toEqual({
      type: "progress",
      id: "one",
      event: { stage: "validate", fraction: 0.3 },
    });
    const firstResult = posts[2];
    expect(firstResult?.response).toMatchObject({
      type: "result",
      id: "one",
      metadata: {
        sampleRate: 48_000,
        channels: 2,
        outputFrames: 1,
        detectedBpm: null,
        beatConfidence: null,
      },
    });
    if (firstResult?.response.type !== "result") {
      throw new Error("expected a result response");
    }
    expect(firstResult.transfer).toEqual([firstResult.response.wav]);
    expect(Array.from(new Uint8Array(firstResult.response.wav))).toEqual([
      82, 73, 70, 70,
    ]);
  });

  it("preserves structured processing failures and classifies init failures", async () => {
    const structuredPosts: WorkerResponse[] = [];
    const structured = createWorkerRequestHandler({
      loadWasm: async () => ({
        process_audio_wasm: () => {
          throw {
            code: "INPUT_TOO_LARGE",
            message: "too large",
            details: { limitBytes: 268_435_456 },
          };
        },
      }),
      postMessage: (response) => structuredPosts.push(response),
    });
    await structured(request("structured"));
    expect(structuredPosts.at(-1)).toEqual({
      type: "error",
      id: "structured",
      error: {
        code: "INPUT_TOO_LARGE",
        message: "too large",
        details: { limitBytes: 268_435_456 },
      },
    });

    const initPosts: WorkerResponse[] = [];
    const initFailure = createWorkerRequestHandler({
      loadWasm: async () => {
        throw new Error("network blocked");
      },
      postMessage: (response) => initPosts.push(response),
    });
    await initFailure(request("init"));
    expect(initPosts.at(-1)).toEqual({
      type: "error",
      id: "init",
      error: {
        code: "WASM_INIT_FAILED",
        message: "network blocked",
      },
    });
  });
});
