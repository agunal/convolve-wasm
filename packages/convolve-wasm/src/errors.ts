export type ConvolveErrorCode =
  | "INVALID_INPUT"
  | "UNSUPPORTED_EXTENSION"
  | "DECODE_FAILED"
  | "UNSUPPORTED_CHANNEL_COUNT"
  | "INPUT_TOO_LARGE"
  | "BEAT_DETECTION_FAILED"
  | "WASM_INIT_FAILED"
  | "PROCESSING_FAILED"
  | "ENCODE_FAILED";

export class ConvolveError extends Error {
  readonly code: ConvolveErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ConvolveErrorCode,
    message: string,
    details?: Record<string, unknown>,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ConvolveError";
    this.code = code;
    this.details = details;
  }
}
