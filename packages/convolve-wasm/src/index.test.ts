import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { createConvolver } from "./convolver";
import type {
  AudioDecodeBackend,
  DecodedInputPair,
} from "./decode";
import { ConvolveError } from "./errors";
import { CONVOLVE } from "./index";
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
    expect(result.wav.type).toBe("audio/wav");
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
});
