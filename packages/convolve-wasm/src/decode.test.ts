import { describe, expect, it } from "vitest";
import { ConvolveError } from "./errors";
import {
  WebAudioDecodeBackend,
  decodeInputPair,
  stereoFromAudioBuffer,
  validateSupportedExtension,
} from "./decode";

interface AudioBufferShape {
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  copyFromChannel(destination: Float32Array, channelNumber: number): void;
}

function makeAudioBuffer(
  channels: readonly (readonly number[])[],
  sampleRate = 48_000,
): AudioBufferShape {
  const length = channels[0]?.length ?? 0;
  return {
    numberOfChannels: channels.length,
    length,
    sampleRate,
    copyFromChannel(destination, channelNumber) {
      destination.set(channels[channelNumber] ?? []);
    },
  };
}

function makeBackend(
  decoded: AudioBufferShape | PromiseLike<AudioBufferShape>,
): WebAudioDecodeBackend {
  const context = {
    decodeAudioData: async () => await decoded,
  } as unknown as BaseAudioContext;
  return new WebAudioDecodeBackend(context);
}

describe("Web Audio decoding", () => {
  it("accepts WAV and M4A extensions case-insensitively", () => {
    expect(() => validateSupportedExtension("source.WAV")).not.toThrow();
    expect(() => validateSupportedExtension("source.m4A")).not.toThrow();
  });

  it("rejects unsupported filename extensions", () => {
    expect(() => validateSupportedExtension("source.mp3")).toThrowError(
      expect.objectContaining({ code: "UNSUPPORTED_EXTENSION" }),
    );
  });

  it("duplicates mono into independent stereo arrays", async () => {
    const backend = makeBackend(makeAudioBuffer([[0.25, -0.25]]));
    const decoded = await backend.decode(
      new File([new Uint8Array([1])], "x.wav"),
    );

    expect([...decoded.left]).toEqual([0.25, -0.25]);
    expect([...decoded.right]).toEqual([0.25, -0.25]);
    expect(decoded.left).not.toBe(decoded.right);
    decoded.left[0] = 0.5;
    expect(decoded.right[0]).toBe(0.25);
  });

  it("keeps stereo channels discrete", () => {
    const decoded = stereoFromAudioBuffer(
      makeAudioBuffer([
        [0.1, 0.2],
        [-0.3, -0.4],
      ]) as AudioBuffer,
    );

    expect([...decoded.left]).toEqual([
      expect.closeTo(0.1, 6),
      expect.closeTo(0.2, 6),
    ]);
    expect([...decoded.right]).toEqual([
      expect.closeTo(-0.3, 6),
      expect.closeTo(-0.4, 6),
    ]);
  });

  it("rejects decoded audio with more than two channels", () => {
    expect(() =>
      stereoFromAudioBuffer(
        makeAudioBuffer([[0], [0], [0]]) as AudioBuffer,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "UNSUPPORTED_CHANNEL_COUNT" }),
    );
  });

  it("wraps decoder rejection with filename details", async () => {
    const backend = makeBackend(
      Promise.reject(new DOMException("unsupported codec", "EncodingError")),
    );

    await expect(
      backend.decode(new File([new Uint8Array([1])], "broken.m4a")),
    ).rejects.toMatchObject({
      code: "DECODE_FAILED",
      details: { fileName: "broken.m4a" },
    });
  });

  it("rejects empty or incorrectly resampled buffers", () => {
    expect(() =>
      stereoFromAudioBuffer(makeAudioBuffer([[]]) as AudioBuffer),
    ).toThrowError(expect.objectContaining({ code: "DECODE_FAILED" }));
    expect(() =>
      stereoFromAudioBuffer(makeAudioBuffer([[0]], 44_100) as AudioBuffer),
    ).toThrowError(expect.objectContaining({ code: "DECODE_FAILED" }));
  });

  it("decodes A then B and emits completed decode progress", async () => {
    const order: string[] = [];
    const backend = {
      async decode(file: File) {
        order.push(file.name);
        return {
          sampleRate: 48_000 as const,
          frames: 1,
          left: new Float32Array([1]),
          right: new Float32Array([1]),
        };
      },
    };

    const result = await decodeInputPair(
      {
        a: new File([new Uint8Array([1])], "a.wav"),
        b: new File([new Uint8Array([1])], "b.wav"),
      },
      backend,
      (event) => order.push(`${event.stage}:${event.fraction}`),
    );

    expect(order).toEqual([
      "a.wav",
      "decode-a:0.1",
      "b.wav",
      "decode-b:0.2",
    ]);
    expect(result.a.frames).toBe(1);
    expect(result.b.frames).toBe(1);
  });

  it("does not double-wrap typed decoding errors", async () => {
    const typed = new ConvolveError("UNSUPPORTED_CHANNEL_COUNT", "too many");
    const backend = makeBackend(Promise.reject(typed));
    await expect(
      backend.decode(new File([new Uint8Array([1])], "x.wav")),
    ).rejects.toBe(typed);
  });
});
