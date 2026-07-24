import { describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  createConvolver,
  type ConvolverWorkerClient,
} from "./convolver";
import type {
  AudioDecodeBackend,
  DecodedInputPair,
} from "./decode";
import type { ConvolveDiagnosticEvent } from "./diagnostics";
import { ConvolveError } from "./errors";
import { CONVOLVE } from "./index";
import { MIB } from "./memory-plan";
import type { NormalizedConvolveOptions } from "./options";
import type {
  ConvolveOptions,
  ConvolveProgress,
  ConvolveResult,
} from "./types";

type ConvolveAudioInput = { a: File; b: File };

const files = (): ConvolveAudioInput => ({
  a: new File([new Uint8Array([1])], "a.wav", { type: "audio/wav" }),
  b: new File([new Uint8Array([2])], "b.wav", { type: "audio/wav" }),
});

const decoded: DecodedInputPair = {
  a: {
    sampleRate: 48_000,
    frames: 1,
    left: new Float32Array([1]),
    right: new Float32Array([1]),
  },
  b: {
    sampleRate: 48_000,
    frames: 1,
    left: new Float32Array([0.5]),
    right: new Float32Array([0.5]),
  },
};

describe("CONVOLVE", () => {
  it("retains the promised public signature", () => {
    expectTypeOf(CONVOLVE).toEqualTypeOf<
      (
        audio: ConvolveAudioInput,
        appendReverse?: boolean,
        options?: ConvolveOptions,
      ) => Promise<ConvolveResult>
    >();
  });

  it("normalizes options, decodes A/B, forwards progress, and delegates to the worker", async () => {
    const progress: ConvolveProgress[] = [];
    const diagnostics: ConvolveDiagnosticEvent[] = [];
    const decode = vi
      .fn<AudioDecodeBackend["decode"]>()
      .mockResolvedValueOnce(decoded.a)
      .mockResolvedValueOnce(decoded.b);
    const process = vi.fn(
      async (
        input: DecodedInputPair,
        appendReverse: boolean,
        options: NormalizedConvolveOptions,
      ): Promise<ConvolveResult> => {
        options.onProgress?.({ stage: "done", fraction: 1 });
        return {
          wav: new Blob([new Uint8Array([82, 73, 70, 70])], {
            type: "audio/wav",
          }),
          metadata: {
            sampleRate: 48_000,
            channels: 2,
            durationSeconds: 1 / 48_000,
            outputFrames: 1,
            detectedBeats: 0,
            detectedBpm: null,
            beatConfidence: null,
            appliedGainDb: 0,
            estimatedTruePeakDbtp: -1,
          },
        };
      },
    );
    const convolve = createConvolver({
      getDecodeBackend: () => ({ decode }),
      getMemoryBudget: () => ({
        budgetBytes: 192 * MIB,
        deviceMemoryGiB: 4,
      }),
      diagnostics: (event) => diagnostics.push(event),
      workerClient: { process },
    });
    const audio = files();

    const result = await convolve(audio, true, {
      beatPan: "b",
      onProgress: (event) => progress.push(event),
    });

    expect(decode).toHaveBeenNthCalledWith(1, audio.a);
    expect(decode).toHaveBeenNthCalledWith(2, audio.b);
    expect(process).toHaveBeenCalledWith(
      decoded,
      true,
      expect.objectContaining({
        beatPan: "b",
        panTransitionMs: 20,
        reverseCrossfadeMs: 5,
        targetDbtp: -1,
      }),
    );
    expect(progress).toEqual([
      { stage: "decode-a", fraction: 0.1 },
      { stage: "decode-b", fraction: 0.2 },
      { stage: "done", fraction: 1 },
    ]);
    expect(diagnostics).toEqual([
      {
        type: "options",
        appendReverse: true,
        beatPan: "b",
        panTransitionMs: 20,
        reverseCrossfadeMs: 5,
        targetDbtp: -1,
      },
      { type: "decode-start", slot: "a", mimeType: "audio/wav", encodedBytes: 1 },
      { type: "decode-success", slot: "a", sampleRate: 48_000, channels: 2, frames: 1 },
      { type: "decode-start", slot: "b", mimeType: "audio/wav", encodedBytes: 1 },
      { type: "decode-success", slot: "b", sampleRate: 48_000, channels: 2, frames: 1 },
      {
        type: "memory-plan",
        estimatedBytes: 34_341_026,
        limitBytes: 201_326_592,
        aFrames: 1,
        bFrames: 1,
        outputFrames: 1,
        finalFrames: 2,
        fftFrames: 1,
        appendReverse: true,
        reverseCrossfadeFrames: 240,
        beatPan: "b",
        deviceMemoryGiB: 4,
        admitted: true,
      },
      { type: "request-success", outputFrames: 1, durationSeconds: 1 / 48_000 },
    ]);
    expect(result.wav.type).toBe("audio/wav");
  });

  it("reports one sanitized request failure without changing its identity", async () => {
    const failure = new ConvolveError(
      "PROCESSING_FAILED",
      "failed C:\\private\\take.wav",
      { estimatedBytes: 123, secret: "SECRET" },
    );
    const diagnostics: ConvolveDiagnosticEvent[] = [];
    const convolve = createConvolver({
      getDecodeBackend: () => ({
        decode: vi.fn().mockResolvedValue(decoded.a),
      }),
      diagnostics: (event) => diagnostics.push(event),
      workerClient: { process: vi.fn().mockRejectedValue(failure) },
    });

    await expect(convolve(files())).rejects.toBe(failure);
    expect(diagnostics.filter(({ type }) => type === "request-failure")).toEqual([
      {
        type: "request-failure",
        error: {
          name: "ConvolveError",
          code: "PROCESSING_FAILED",
          message: "failed [redacted-path]",
          details: { estimatedBytes: 123 },
        },
      },
    ]);
  });

  it("rejects malformed input before decoding or starting the worker", async () => {
    const decode = vi.fn<AudioDecodeBackend["decode"]>();
    const process = vi.fn();
    const convolve = createConvolver({
      getDecodeBackend: () => ({ decode }),
      workerClient: { process },
    });

    await expect(
      convolve({ a: files().a } as ConvolveAudioInput),
    ).rejects.toEqual(
      expect.objectContaining({ code: "INVALID_INPUT" } satisfies Partial<ConvolveError>),
    );
    expect(decode).not.toHaveBeenCalled();
    expect(process).not.toHaveBeenCalled();
  });

  it("rejects a risky decoded request before starting the worker", async () => {
    const decode = vi
      .fn<AudioDecodeBackend["decode"]>()
      .mockResolvedValueOnce({
        ...decoded.a,
        frames: 770_684,
      })
      .mockResolvedValueOnce({
        ...decoded.b,
        frames: 1_736_481,
      });
    const process = vi.fn();
    const convolve = createConvolver({
      getDecodeBackend: () => ({ decode }),
      getMemoryBudget: () => ({
        budgetBytes: 192 * MIB,
        deviceMemoryGiB: 4,
      }),
      workerClient: { process },
    });

    const audio = {
      a: new File([new Uint8Array(4_624_148)], "a.wav", {
        type: "audio/wav",
      }),
      b: new File([new Uint8Array(893_355)], "b.wav", {
        type: "audio/wav",
      }),
    };

    await expect(convolve(audio)).rejects.toMatchObject({
      code: "INPUT_TOO_LARGE",
      details: {
        estimatedBytes: 235_793_987,
        limitBytes: 201_326_592,
        aFrames: 770_684,
        bFrames: 1_736_481,
        outputFrames: 2_507_164,
        finalFrames: 2_507_164,
        fftFrames: 4_194_304,
        appendReverse: false,
        reverseCrossfadeFrames: 240,
        beatPan: null,
        deviceMemoryGiB: 4,
      },
    });
    expect(decode).toHaveBeenCalledTimes(2);
    expect(process).not.toHaveBeenCalled();
  });

  it("rejects the private reverse beat-pan shape at the reported 4 GB budget", async () => {
    const decode = vi
      .fn<AudioDecodeBackend["decode"]>()
      .mockResolvedValueOnce({
        ...decoded.a,
        frames: 770_684,
      })
      .mockResolvedValueOnce({
        ...decoded.b,
        frames: 1_736_481,
      });
    const process = vi.fn();
    const convolve = createConvolver({
      getDecodeBackend: () => ({ decode }),
      getMemoryBudget: () => ({
        budgetBytes: 192 * MIB,
        deviceMemoryGiB: 4,
      }),
      workerClient: { process },
    });
    const audio = {
      a: new File([new Uint8Array(4_624_148)], "a.wav", {
        type: "audio/wav",
      }),
      b: new File([new Uint8Array(893_355)], "b.wav", {
        type: "audio/wav",
      }),
    };

    await expect(
      convolve(audio, true, { beatPan: "a" }),
    ).rejects.toMatchObject({
      code: "INPUT_TOO_LARGE",
      details: {
        estimatedBytes: 250_835_531,
        limitBytes: 192 * MIB,
        finalFrames: 5_014_088,
        appendReverse: true,
        beatPan: "a",
        deviceMemoryGiB: 4,
      },
    });
    expect(process).not.toHaveBeenCalled();
  });

  it("reserves the initiating queue slot before a reentrant options observer", async () => {
    const order: string[] = [];
    const decode = vi.fn(async (file: File) => {
      order.push(file.name);
      return decoded.a;
    });
    const result: ConvolveResult = {
      wav: new Blob([], { type: "audio/wav" }),
      metadata: {
        sampleRate: 48_000,
        channels: 2,
        durationSeconds: 1 / 48_000,
        outputFrames: 1,
        detectedBeats: 0,
        detectedBpm: null,
        beatConfidence: null,
        appliedGainDb: 0,
        estimatedTruePeakDbtp: -1,
      },
    };
    const outer = {
      a: new File([], "outer-a.wav"),
      b: new File([], "outer-b.wav"),
    };
    const nested = {
      a: new File([], "nested-a.wav"),
      b: new File([], "nested-b.wav"),
    };
    let nestedPromise: Promise<ConvolveResult> | undefined;
    let submittedNested = false;
    let convolve!: ReturnType<typeof createConvolver>;
    convolve = createConvolver({
      getDecodeBackend: () => ({ decode }),
      diagnostics: (event) => {
        if (event.type === "options" && !submittedNested) {
          submittedNested = true;
          nestedPromise = convolve(nested);
          void nestedPromise.catch(() => undefined);
        }
      },
      workerClient: { process: vi.fn().mockResolvedValue(result) },
    });

    await convolve(outer);
    await nestedPromise;

    expect(order).toEqual([
      "outer-a.wav",
      "outer-b.wav",
      "nested-a.wav",
      "nested-b.wav",
    ]);
  });

  it("snapshots audio before an options observer can mutate it", async () => {
    const order: string[] = [];
    const decode = vi.fn(async (file: File) => {
      order.push(file.name);
      return decoded.a;
    });
    const audio = {
      a: new File([], "submitted-a.wav"),
      b: new File([], "submitted-b.wav"),
    };
    const convolve = createConvolver({
      getDecodeBackend: () => ({ decode }),
      diagnostics: (event) => {
        if (event.type === "options") {
          audio.a = new File([], "replacement-a.wav");
          audio.b = new File([], "replacement-b.wav");
        }
      },
      workerClient: {
        process: vi.fn().mockResolvedValue({
          wav: new Blob([], { type: "audio/wav" }),
          metadata: {
            sampleRate: 48_000,
            channels: 2,
            durationSeconds: 1 / 48_000,
            outputFrames: 1,
            detectedBeats: 0,
            detectedBpm: null,
            beatConfidence: null,
            appliedGainDb: 0,
            estimatedTruePeakDbtp: -1,
          },
        }),
      },
    });

    await convolve(audio);

    expect(order).toEqual(["submitted-a.wav", "submitted-b.wav"]);
  });
  it("serializes concurrent renders so their memory peaks cannot overlap", async () => {
    let finishFirst: ((result: ConvolveResult) => void) | undefined;
    const firstResult = new Promise<ConvolveResult>((resolve) => {
      finishFirst = resolve;
    });
    const result: ConvolveResult = {
      wav: new Blob([], { type: "audio/wav" }),
      metadata: {
        sampleRate: 48_000,
        channels: 2,
        durationSeconds: 1 / 48_000,
        outputFrames: 1,
        detectedBeats: 0,
        detectedBpm: null,
        beatConfidence: null,
        appliedGainDb: 0,
        estimatedTruePeakDbtp: -1,
      },
    };
    const decode = vi.fn<AudioDecodeBackend["decode"]>().mockResolvedValue(
      decoded.a,
    );
    const process = vi
      .fn<ConvolverWorkerClient["process"]>()
      .mockReturnValueOnce(firstResult)
      .mockResolvedValueOnce(result);
    const convolve = createConvolver({
      getDecodeBackend: () => ({ decode }),
      workerClient: { process },
    });

    const first = convolve(files());
    await vi.waitFor(() => expect(process).toHaveBeenCalledTimes(1));
    const second = convolve(files());

    await Promise.resolve();
    expect(decode).toHaveBeenCalledTimes(2);
    expect(process).toHaveBeenCalledTimes(1);

    finishFirst?.(result);
    await first;
    await second;
    expect(decode).toHaveBeenCalledTimes(4);
    expect(process).toHaveBeenCalledTimes(2);
  });

  it("snapshots mutable request arguments when submitted", async () => {
    const decode = vi
      .fn<AudioDecodeBackend["decode"]>()
      .mockResolvedValue(decoded.a);
    const process = vi.fn<ConvolverWorkerClient["process"]>().mockResolvedValue({
      wav: new Blob([], { type: "audio/wav" }),
      metadata: {
        sampleRate: 48_000,
        channels: 2,
        durationSeconds: 1 / 48_000,
        outputFrames: 1,
        detectedBeats: 0,
        detectedBpm: null,
        beatConfidence: null,
        appliedGainDb: 0,
        estimatedTruePeakDbtp: -1,
      },
    });
    const convolve = createConvolver({
      getDecodeBackend: () => ({ decode }),
      workerClient: { process },
    });
    const options: ConvolveOptions = { beatPan: null };
    const audio = files();
    const submittedA = audio.a;
    const submittedB = audio.b;

    const pending = convolve(audio, false, options);
    audio.a = new File([], "replacement-a.wav");
    audio.b = new File([], "replacement-b.wav");
    options.beatPan = "a";
    await pending;

    expect(decode).toHaveBeenNthCalledWith(1, submittedA);
    expect(decode).toHaveBeenNthCalledWith(2, submittedB);
    expect(process).toHaveBeenCalledWith(
      expect.anything(),
      false,
      expect.objectContaining({ beatPan: null }),
    );
  });
});
