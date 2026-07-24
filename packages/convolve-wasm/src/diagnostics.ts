export const CONVOLVE_DIAGNOSTIC_EVENT =
  "convolve-wasm:diagnostic" as const;

export interface SafeDiagnosticError {
  name?: string;
  code?: string;
  message: string;
  lineNumber?: number;
  columnNumber?: number;
  details?: Record<string, string | number | boolean | null>;
}

export type ConvolveDiagnosticEvent =
  | {
      type: "decode-start";
      slot: "a" | "b";
      mimeType: string;
      encodedBytes: number;
    }
  | {
      type: "decode-success";
      slot: "a" | "b";
      sampleRate: 48_000;
      channels: 2;
      frames: number;
    }
  | { type: "decode-failure"; slot: "a" | "b"; error: SafeDiagnosticError }
  | {
      type: "options";
      appendReverse: boolean;
      beatPan: "a" | "b" | null;
      panTransitionMs: number;
      reverseCrossfadeMs: number;
      targetDbtp: number;
    }
  | {
      type: "memory-plan";
      estimatedBytes: number;
      limitBytes: number;
      aFrames: number;
      bFrames: number;
      outputFrames: number;
      finalFrames: number;
      fftFrames: number;
      appendReverse: boolean;
      reverseCrossfadeFrames: number;
      beatPan: "a" | "b" | null;
      deviceMemoryGiB: number | null;
      admitted: boolean;
    }
  | { type: "request-success"; outputFrames: number; durationSeconds: number }
  | { type: "request-failure"; error: SafeDiagnosticError }
  | { type: "worker-created" }
  | { type: "worker-error"; error: SafeDiagnosticError }
  | { type: "worker-messageerror"; error: SafeDiagnosticError }
  | { type: "worker-cancelled" }
  | { type: "wasm-init-start" }
  | { type: "wasm-init-success" }
  | { type: "wasm-init-failure"; error: SafeDiagnosticError }
  | { type: "output-start"; outputFrames: number }
  | {
      type: "output-milestone";
      fraction: 0.25 | 0.5 | 0.75;
      chunkCount: number;
      pcmBytes: number;
    }
  | {
      type: "blob-complete";
      chunkCount: number;
      pcmBytes: number;
      wavBytes: number;
    };

export type DiagnosticObserver = (event: ConvolveDiagnosticEvent) => void;

const MAX_INPUT_TEXT = 4_096;
const MAX_ERROR_TEXT = 512;
const MAX_SHORT_TEXT = 120;
const AUDIO_FILE_EXTENSION = /\.(?:wav|m4a)\b/iu;
const QUOTED_FILE_NAME = /(["'])[^"'<>\r\n]+\.[A-Za-z0-9]{1,16}\1/gu;
const FILE_NAME_TOKEN = /(^|[\s("'=])[^\s"'<>\\/:]+\.[A-Za-z0-9]{1,16}\b/gu;
const BLOB_URL = /\bblob:[^\s"'<>]+/giu;
const HTTP_URL = /\bhttps?:\/\/[^\s"'<>]+/giu;
const SOURCE_URL = /\b[A-Za-z][A-Za-z0-9+.-]*:(?=[^\s"'<>])[^\s"'<>]*/gu;
const FILE_URL = /\bfile:\/\/[^\s"'<>]+/giu;
const WINDOWS_PATH = /\b[A-Za-z]:[\\/][^\r\n"'<>]*/gu;
const UNC_PATH = /\\\\[^\r\n"'<>]*/gu;
const RELATIVE_PATH = /(^|[\s("'=])(?:\.\.?[\\/])[^\r\n"'<>]*/gu;
const SEPARATOR_PATH = /(^|[\s("'=])(?:~[\\/]|(?:[^\s"'<>\\/:]+[\\/])+)[^\r\n"'<>]*/gu;
const POSIX_PATH = /(^|[\s("'=])\/[^\r\n"'<>]*/gu;

const ERROR_DETAIL_KEYS = [
  "estimatedBytes",
  "limitBytes",
  "aFrames",
  "bFrames",
  "outputFrames",
  "finalFrames",
  "fftFrames",
  "appendReverse",
  "reverseCrossfadeFrames",
  "beatPan",
  "deviceMemoryGiB",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  try {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

function own(value: unknown, key: string): unknown {
  if (!isRecord(value)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function sanitizeSensitiveText(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  if (text.length > MAX_INPUT_TEXT) return "[redacted-oversized-text]";
  const locationRedacted = text
    .replace(BLOB_URL, "[redacted-blob-url]")
    .replace(WINDOWS_PATH, "[redacted-path]")
    .replace(HTTP_URL, "[redacted-source-url]")
    .replace(FILE_URL, "[redacted-file-url]")
    .replace(SOURCE_URL, "[redacted-url]")
    .replace(UNC_PATH, "[redacted-path]")
    .replace(RELATIVE_PATH, "$1[redacted-path]")
    .replace(SEPARATOR_PATH, "$1[redacted-path]")
    .replace(POSIX_PATH, "$1[redacted-path]");
  if (AUDIO_FILE_EXTENSION.test(locationRedacted)) {
    return "[redacted-audio-file-message]";
  }
  return locationRedacted
    .replace(QUOTED_FILE_NAME, "[redacted-file-name]")
    .replace(FILE_NAME_TOKEN, "$1[redacted-file-name]")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_ERROR_TEXT);
}

function safeText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return sanitizeSensitiveText(value).slice(0, MAX_SHORT_TEXT);
}

function safeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function finiteDetail(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function safeDetails(
  value: unknown,
): Record<string, string | number | boolean | null> | undefined {
  const details: Record<string, string | number | boolean | null> = {};
  for (const key of ERROR_DETAIL_KEYS.slice(0, 7)) {
    const candidate = finiteDetail(own(value, key));
    if (candidate !== undefined) details[key] = candidate;
  }
  const appendReverse = own(value, "appendReverse");
  if (typeof appendReverse === "boolean") {
    details.appendReverse = appendReverse;
  }
  const reverseCrossfadeFrames = finiteDetail(
    own(value, "reverseCrossfadeFrames"),
  );
  if (reverseCrossfadeFrames !== undefined) {
    details.reverseCrossfadeFrames = reverseCrossfadeFrames;
  }
  const beatPan = own(value, "beatPan");
  if (beatPan === "a" || beatPan === "b" || beatPan === null) {
    details.beatPan = beatPan;
  }
  const deviceMemoryGiB = own(value, "deviceMemoryGiB");
  if (deviceMemoryGiB === null) {
    details.deviceMemoryGiB = null;
  } else {
    const memory = finiteDetail(deviceMemoryGiB);
    if (memory !== undefined) details.deviceMemoryGiB = memory;
  }
  return Object.keys(details).length > 0 ? details : undefined;
}

export function safeDiagnosticError(value: unknown): SafeDiagnosticError {
  const name = safeText(own(value, "name"));
  const code = safeText(own(value, "code"));
  const lineNumber =
    safeNumber(own(value, "lineNumber")) ?? safeNumber(own(value, "line"));
  const columnNumber =
    safeNumber(own(value, "columnNumber")) ?? safeNumber(own(value, "column"));
  const details = safeDetails(own(value, "details"));
  return {
    ...(name ? { name } : {}),
    ...(code ? { code } : {}),
    message: sanitizeSensitiveText(own(value, "message")),
    ...(lineNumber === undefined ? {} : { lineNumber }),
    ...(columnNumber === undefined ? {} : { columnNumber }),
    ...(details ? { details } : {}),
  };
}

export function notifyDiagnostic(
  observer: DiagnosticObserver | undefined,
  event: ConvolveDiagnosticEvent,
): void {
  try {
    observer?.(event);
  } catch {
    // Diagnostics are never part of processing success or failure.
  }
}

export const emitBrowserDiagnostic: DiagnosticObserver = (event) => {
  try {
    if (
      typeof globalThis.dispatchEvent !== "function" ||
      typeof CustomEvent !== "function"
    ) return;
    globalThis.dispatchEvent(
      new CustomEvent(CONVOLVE_DIAGNOSTIC_EVENT, { detail: event }),
    );
  } catch {
    // A browser observer or unavailable event API cannot affect CONVOLVE().
  }
};
