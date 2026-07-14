import { ConvolveError } from "./errors";
import type { ConvolveOptions } from "./types";

export type NormalizedConvolveOptions = Required<
  Omit<ConvolveOptions, "onProgress">
> &
  Pick<ConvolveOptions, "onProgress">;

export const DEFAULT_OPTIONS: Required<
  Omit<ConvolveOptions, "onProgress">
> = Object.freeze({
  beatPan: null,
  panTransitionMs: 20,
  reverseCrossfadeMs: 5,
  targetDbtp: -1,
});

function invalidOption(
  option: keyof ConvolveOptions,
  value: unknown,
  message: string,
): never {
  throw new ConvolveError("INVALID_INPUT", message, { option, value });
}

function requireFinite(
  option: "panTransitionMs" | "reverseCrossfadeMs" | "targetDbtp",
  value: number,
): void {
  if (!Number.isFinite(value)) {
    invalidOption(option, value, `${option} must be a finite number`);
  }
}

export function normalizeOptions(
  options: ConvolveOptions = {},
): NormalizedConvolveOptions {
  const normalized: NormalizedConvolveOptions = {
    ...DEFAULT_OPTIONS,
    ...options,
  };

  if (
    normalized.beatPan !== null &&
    normalized.beatPan !== "a" &&
    normalized.beatPan !== "b"
  ) {
    invalidOption(
      "beatPan",
      normalized.beatPan,
      'beatPan must be null, "a", or "b"',
    );
  }

  requireFinite("panTransitionMs", normalized.panTransitionMs);
  requireFinite("reverseCrossfadeMs", normalized.reverseCrossfadeMs);
  requireFinite("targetDbtp", normalized.targetDbtp);

  if (normalized.panTransitionMs < 0) {
    invalidOption(
      "panTransitionMs",
      normalized.panTransitionMs,
      "panTransitionMs must be non-negative",
    );
  }
  if (normalized.reverseCrossfadeMs < 0) {
    invalidOption(
      "reverseCrossfadeMs",
      normalized.reverseCrossfadeMs,
      "reverseCrossfadeMs must be non-negative",
    );
  }
  if (normalized.targetDbtp < -24 || normalized.targetDbtp > 0) {
    invalidOption(
      "targetDbtp",
      normalized.targetDbtp,
      "targetDbtp must be between -24 and 0 dBTP",
    );
  }

  return normalized;
}
