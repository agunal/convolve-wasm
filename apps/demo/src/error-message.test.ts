import { describe, expect, it } from "vitest";

import { ConvolveError } from "@takana-labs/convolve-wasm";

import { formatConvolveError } from "./error-message";

describe("formatConvolveError", () => {
  it("turns memory rejection details into actionable MiB guidance", () => {
    const error = new ConvolveError(
      "INPUT_TOO_LARGE",
      "Estimated peak memory exceeds this browser's safe limit.",
      {
        estimatedBytes: 109_051_904,
        limitBytes: 67_108_864,
        appendReverse: true,
        beatPan: "b",
      },
    );

    expect(formatConvolveError(error)).toBe(
      "INPUT_TOO_LARGE: This render needs about 104 MiB, above this device's 64 MiB safe limit. Try shorter files, turn off beat panning, or disable reverse append.",
    );
  });

  it("only suggests enabled memory-saving options", () => {
    const error = new ConvolveError(
      "INPUT_TOO_LARGE",
      "Estimated peak memory exceeds this browser's safe limit.",
      {
        estimatedBytes: 109_051_904,
        limitBytes: 67_108_864,
        appendReverse: false,
        beatPan: null,
      },
    );

    expect(formatConvolveError(error)).toBe(
      "INPUT_TOO_LARGE: This render needs about 104 MiB, above this device's 64 MiB safe limit. Try shorter files.",
    );
  });

  it("rounds the lower-memory mobile estimate to 86 MiB", () => {
    const error = new ConvolveError(
      "INPUT_TOO_LARGE",
      "Estimated peak memory exceeds this browser's safe limit.",
      {
        estimatedBytes: 90_226_830,
        limitBytes: 67_108_864,
        appendReverse: false,
        beatPan: null,
      },
    );

    expect(formatConvolveError(error)).toBe(
      "INPUT_TOO_LARGE: This render needs about 86 MiB, above this device's 64 MiB safe limit. Try shorter files.",
    );
  });

  it("preserves the existing copy for other failures", () => {
    const error = new ConvolveError(
      "BEAT_DETECTION_FAILED",
      "No confident beat grid was found.",
    );

    expect(formatConvolveError(error)).toBe(
      "BEAT_DETECTION_FAILED: No confident beat grid was found.",
    );
  });
});
