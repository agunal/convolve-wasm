import { describe, expect, it } from "vitest";

import {
  MIB,
  defaultMemoryBudget,
  estimateFullPipelineMemory,
} from "./memory-plan";

describe("mobile-safe memory planning", () => {
  it("assigns a 192 MiB budget to reported 4 GB devices", () => {
    expect(defaultMemoryBudget(4)).toEqual({
      budgetBytes: 192 * MIB,
      deviceMemoryGiB: 4,
    });
  });

  it("preserves a 384 MiB budget for 8 GB and unknown desktop devices", () => {
    expect(defaultMemoryBudget(8)).toEqual({
      budgetBytes: 384 * MIB,
      deviceMemoryGiB: 8,
    });
    expect(defaultMemoryBudget(undefined)).toEqual({
      budgetBytes: 384 * MIB,
      deviceMemoryGiB: null,
    });
  });

  it("clamps very small reported devices to 64 MiB", () => {
    expect(defaultMemoryBudget(0.25).budgetBytes).toBe(64 * MIB);
  });

  it("models the exact private pair across browser, worker, WASM, and WAV copies", () => {
    const plan = estimateFullPipelineMemory({
      aFrames: 770_684,
      bFrames: 1_736_481,
      encodedInputBytes: 4_624_148 + 893_355,
      appendReverse: false,
      reverseCrossfadeFrames: 240,
      beatPan: false,
    });

    expect(plan).toMatchObject({
      outputFrames: 2_507_164,
      finalFrames: 2_507_164,
      fftFrames: 4_194_304,
      estimatedBytes: 235_793_987,
    });
  });

  it("includes virtual reverse output and two bounded PCM chunks without beat-pan scratch", () => {
    const plan = estimateFullPipelineMemory({
      aFrames: 770_684,
      bFrames: 1_736_481,
      encodedInputBytes: 4_624_148 + 893_355,
      appendReverse: true,
      reverseCrossfadeFrames: 240,
      beatPan: true,
    });

    expect(plan).toMatchObject({
      outputFrames: 2_507_164,
      finalFrames: 5_014_088,
      estimatedBytes: 250_835_531,
    });
  });

  it("does not charge beat-pan scratch memory", () => {
    const shared = {
      aFrames: 770_684,
      bFrames: 1_736_481,
      encodedInputBytes: 4_624_148 + 893_355,
      appendReverse: true,
      reverseCrossfadeFrames: 240,
    };

    expect(
      estimateFullPipelineMemory({ ...shared, beatPan: false }).estimatedBytes,
    ).toBe(250_835_531);
    expect(
      estimateFullPipelineMemory({ ...shared, beatPan: true }).estimatedBytes,
    ).toBe(250_835_531);
  });

  it("uses the extensible WAV header and two bounded PCM chunks", () => {
    const plan = estimateFullPipelineMemory({
      aFrames: 384_000,
      bFrames: 384_000,
      encodedInputBytes: 1_536_088,
      appendReverse: false,
      reverseCrossfadeFrames: 240,
      beatPan: false,
    });

    expect(plan).toMatchObject({
      outputFrames: 767_999,
      finalFrames: 767_999,
      fftFrames: 1_048_576,
      estimatedBytes: 90_226_830,
    });
  });

  it("saturates unsafe arithmetic so impossible requests are always rejected", () => {
    expect(
      estimateFullPipelineMemory({
        aFrames: Number.MAX_SAFE_INTEGER,
        bFrames: 2,
        encodedInputBytes: 2,
        appendReverse: true,
        reverseCrossfadeFrames: 0,
        beatPan: true,
      }).estimatedBytes,
    ).toBe(Number.MAX_SAFE_INTEGER);
  });
});
