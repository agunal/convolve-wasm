import {
  notifyDiagnostic,
  safeDiagnosticError,
  type DiagnosticObserver,
} from "./diagnostics";
import { ConvolveError } from "./errors";
import type { ConvolveProgress } from "./types";

export interface DecodedStereoAudio {
  sampleRate: 48_000;
  frames: number;
  left: Float32Array;
  right: Float32Array;
}

export interface AudioDecodeBackend {
  decode(file: File): Promise<DecodedStereoAudio>;
}

export type DecodedInputPair = {
  a: DecodedStereoAudio;
  b: DecodedStereoAudio;
};

const SUPPORTED_EXTENSIONS = new Set([".wav", ".m4a"]);
const DIAGNOSTIC_MIME_TYPES = new Set([
  "audio/mp4",
  "audio/vnd.wave",
  "audio/wav",
  "audio/wave",
  "audio/x-m4a",
  "audio/x-wav",
]);

export function validateSupportedExtension(fileName: string): void {
  const dot = fileName.lastIndexOf(".");
  const extension = dot >= 0 ? fileName.slice(dot).toLowerCase() : "";
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    throw new ConvolveError(
      "UNSUPPORTED_EXTENSION",
      `Unsupported audio extension for ${fileName}`,
      { fileName, extension },
    );
  }
}

export function stereoFromAudioBuffer(
  decoded: AudioBuffer,
): DecodedStereoAudio {
  if (decoded.sampleRate !== 48_000) {
    throw new ConvolveError(
      "DECODE_FAILED",
      "Decoded audio was not resampled to 48 kHz",
      { sampleRate: decoded.sampleRate },
    );
  }
  if (decoded.length <= 0 || decoded.numberOfChannels <= 0) {
    throw new ConvolveError("DECODE_FAILED", "Decoded audio is empty", {
      frames: decoded.length,
      channels: decoded.numberOfChannels,
    });
  }
  if (decoded.numberOfChannels > 2) {
    throw new ConvolveError(
      "UNSUPPORTED_CHANNEL_COUNT",
      "Only mono and stereo inputs are supported",
      { channels: decoded.numberOfChannels },
    );
  }

  const left = new Float32Array(decoded.length);
  const right = new Float32Array(decoded.length);
  decoded.copyFromChannel(left, 0);
  if (decoded.numberOfChannels === 1) {
    right.set(left);
  } else {
    decoded.copyFromChannel(right, 1);
  }

  return {
    sampleRate: 48_000,
    frames: decoded.length,
    left,
    right,
  };
}

export class WebAudioDecodeBackend implements AudioDecodeBackend {
  constructor(private readonly context: BaseAudioContext) {}

  async decode(file: File): Promise<DecodedStereoAudio> {
    validateSupportedExtension(file.name);
    try {
      const bytes = await file.arrayBuffer();
      const decoded = await this.context.decodeAudioData(bytes);
      return stereoFromAudioBuffer(decoded);
    } catch (cause) {
      if (cause instanceof ConvolveError) {
        throw cause;
      }
      throw new ConvolveError(
        "DECODE_FAILED",
        `Could not decode ${file.name}`,
        { fileName: file.name },
        cause,
      );
    }
  }
}

let defaultBackend: WebAudioDecodeBackend | undefined;

export function getDefaultDecodeBackend(): WebAudioDecodeBackend {
  if (typeof OfflineAudioContext === "undefined") {
    throw new ConvolveError(
      "DECODE_FAILED",
      "Web Audio decoding is unavailable",
    );
  }
  return (defaultBackend ??= new WebAudioDecodeBackend(
    new OfflineAudioContext(2, 1, 48_000),
  ));
}

function diagnosticMimeType(value: string): string {
  const essence = value
    .slice(0, 120)
    .split(";", 1)[0]!
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .trim()
    .toLowerCase();
  return DIAGNOSTIC_MIME_TYPES.has(essence) ? essence : "";
}
async function decodeInput(
  slot: "a" | "b",
  file: File,
  backend: AudioDecodeBackend,
  diagnostics: DiagnosticObserver | undefined,
): Promise<DecodedStereoAudio> {
  notifyDiagnostic(diagnostics, {
    type: "decode-start",
    slot,
    mimeType: diagnosticMimeType(file.type),
    encodedBytes: file.size,
  });
  try {
    const decoded = await backend.decode(file);
    notifyDiagnostic(diagnostics, {
      type: "decode-success",
      slot,
      sampleRate: decoded.sampleRate,
      channels: 2,
      frames: decoded.frames,
    });
    return decoded;
  } catch (cause) {
    notifyDiagnostic(diagnostics, {
      type: "decode-failure",
      slot,
      error: safeDiagnosticError(cause),
    });
    throw cause;
  }
}

export async function decodeInputPair(
  audio: { a: File; b: File },
  backend: AudioDecodeBackend,
  onProgress?: (event: ConvolveProgress) => void,
  diagnostics?: DiagnosticObserver,
): Promise<DecodedInputPair> {
  const a = await decodeInput("a", audio.a, backend, diagnostics);
  onProgress?.({ stage: "decode-a", fraction: 0.1 });
  const b = await decodeInput("b", audio.b, backend, diagnostics);
  onProgress?.({ stage: "decode-b", fraction: 0.2 });
  return { a, b };
}
