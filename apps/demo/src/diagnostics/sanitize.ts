import type {
  DiagnosticCheckpointType,
  DiagnosticDetails,
  DiagnosticScalar,
} from "./model";

const MAX_ERROR_TEXT = 512;
const MAX_INPUT_TEXT = 4_096;
const MAX_SHORT_TEXT = 120;
const AUDIO_NAME = /(?:["'][^"'<>\r\n]+\.(?:wav|m4a)["'])|(?:^|[\s("'=])(?:[^\s"'<>\\/:]+(?:[ \t]+[^\s"'<>\\/:]+)*)\.(?:wav|m4a)\b/giu;
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

const ERROR_SOURCES = new Set([
  "decode", "worker", "window", "promise", "audio", "processing", "wasm",
]);
const MIME_TYPE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:\s*;\s*[A-Za-z0-9!#$&^_.+-]+=[A-Za-z0-9!#$&^_.+-]+)*$/u;
const STAGES = new Set([
  "decode-a", "decode-b", "load-wasm", "validate", "convolve", "beat-detect",
  "beat-pan", "append-reverse", "normalize", "encode", "done",
]);

export function sanitizeSensitiveText(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  if (text.length > MAX_INPUT_TEXT) return "[redacted-oversized-text]";
  return text
    .replace(BLOB_URL, "[redacted-blob-url]")
    .replace(WINDOWS_PATH, "[redacted-path]")
    .replace(HTTP_URL, "[redacted-source-url]")
    .replace(FILE_URL, "[redacted-file-url]")
    .replace(SOURCE_URL, "[redacted-url]")
    .replace(UNC_PATH, "[redacted-path]")
    .replace(RELATIVE_PATH, "$1[redacted-path]")
    .replace(SEPARATOR_PATH, "$1[redacted-path]")
    .replace(POSIX_PATH, "$1[redacted-path]")
    .replace(AUDIO_NAME, "[redacted-audio-name]")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_ERROR_TEXT);
}

type SafeError = {
  source: string;
  name?: string;
  code?: string;
  message?: string;
  line?: number;
  column?: number;
  details?: DiagnosticDetails;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonNegative(value: unknown): number | undefined {
  const number = finite(value);
  return number !== undefined && number >= 0 ? number : undefined;
}

function shortText(value: unknown): string | undefined {
  return typeof value === "string"
    ? sanitizeSensitiveText(value).slice(0, MAX_SHORT_TEXT)
    : undefined;
}

function slot(value: unknown): "a" | "b" | undefined {
  return value === "a" || value === "b" ? value : undefined;
}

function beatPan(value: unknown): "a" | "b" | null | undefined {
  return value === "a" || value === "b" || value === null ? value : undefined;
}

function mimeType(value: unknown): string | undefined {
  if (value === "") return "";
  const text = typeof value === "string"
    ? value.slice(0, MAX_SHORT_TEXT).replace(/[\u0000-\u001f\u007f]/gu, " ").trim()
    : undefined;
  return text !== undefined && MIME_TYPE.test(text) ? text : undefined;
}

function add(output: DiagnosticDetails, key: string, value: DiagnosticScalar | undefined): void {
  if (value !== undefined) output[key] = value;
}

function errorSource(value: unknown): string {
  return typeof value === "string" && ERROR_SOURCES.has(value) ? value : "processing";
}

function errorDetails(value: unknown): DiagnosticDetails {
  const result: DiagnosticDetails = {};
  add(result, "estimatedBytes", finite(own(value, "estimatedBytes")));
  add(result, "limitBytes", finite(own(value, "limitBytes")));
  add(result, "aFrames", finite(own(value, "aFrames")));
  add(result, "bFrames", finite(own(value, "bFrames")));
  add(result, "outputFrames", finite(own(value, "outputFrames")));
  add(result, "finalFrames", finite(own(value, "finalFrames")));
  add(result, "fftFrames", finite(own(value, "fftFrames")));
  add(result, "appendReverse", typeof own(value, "appendReverse") === "boolean" ? own(value, "appendReverse") as boolean : undefined);
  add(result, "reverseCrossfadeFrames", finite(own(value, "reverseCrossfadeFrames")));
  add(result, "beatPan", beatPan(own(value, "beatPan")));
  const deviceMemoryGiB = own(value, "deviceMemoryGiB");
  add(result, "deviceMemoryGiB", deviceMemoryGiB === null ? null : finite(deviceMemoryGiB));
  return result;
}

export function sanitizeError(value: unknown, source: string): SafeError {
  const result: SafeError = { source: errorSource(source) };
  const name = shortText(own(value, "name"));
  const code = shortText(own(value, "code"));
  const message = sanitizeSensitiveText(own(value, "message"));
  const line = nonNegative(own(value, "line")) ?? nonNegative(own(value, "lineNumber"));
  const column = nonNegative(own(value, "column")) ?? nonNegative(own(value, "columnNumber"));
  const details = errorDetails(own(value, "details"));
  if (name !== undefined) result.name = name;
  if (code !== undefined) result.code = code;
  if (message !== "") result.message = message;
  if (line !== undefined) result.line = line;
  if (column !== undefined) result.column = column;
  if (Object.keys(details).length > 0) result.details = details;
  return result;
}

function addError(output: DiagnosticDetails, value: unknown, fallbackSource: string): void {
  const source = own(value, "source");
  const error = sanitizeError(
    value,
    typeof source === "string" && ERROR_SOURCES.has(source) ? source : fallbackSource,
  );
  output.source = error.source;
  add(output, "name", error.name);
  add(output, "code", error.code);
  add(output, "message", error.message);
  add(output, "line", error.line);
  add(output, "column", error.column);
  if (error.details) {
    add(output, "estimatedBytes", error.details.estimatedBytes);
    add(output, "limitBytes", error.details.limitBytes);
    add(output, "aFrames", error.details.aFrames);
    add(output, "bFrames", error.details.bFrames);
    add(output, "outputFrames", error.details.outputFrames);
    add(output, "finalFrames", error.details.finalFrames);
    add(output, "fftFrames", error.details.fftFrames);
    add(output, "appendReverse", error.details.appendReverse);
    add(output, "reverseCrossfadeFrames", error.details.reverseCrossfadeFrames);
    add(output, "beatPan", error.details.beatPan);
    add(output, "deviceMemoryGiB", error.details.deviceMemoryGiB);
  }
}

function inputDetails(value: unknown): DiagnosticDetails {
  const result: DiagnosticDetails = {};
  add(result, "slot", slot(own(value, "slot")));
  add(result, "mimeType", mimeType(own(value, "mimeType")));
  add(result, "encodedBytes", nonNegative(own(value, "encodedBytes")));
  return result;
}

function optionsDetails(value: unknown): DiagnosticDetails {
  const result: DiagnosticDetails = {};
  add(result, "appendReverse", typeof own(value, "appendReverse") === "boolean" ? own(value, "appendReverse") as boolean : undefined);
  add(result, "beatPan", beatPan(own(value, "beatPan")));
  add(result, "panTransitionMs", nonNegative(own(value, "panTransitionMs")));
  add(result, "reverseCrossfadeMs", nonNegative(own(value, "reverseCrossfadeMs")));
  add(result, "targetDbtp", finite(own(value, "targetDbtp")));
  return result;
}

function memoryPlanDetails(value: unknown): DiagnosticDetails {
  const result = errorDetails(value);
  add(result, "admitted", typeof own(value, "admitted") === "boolean" ? own(value, "admitted") as boolean : undefined);
  return result;
}

export function sanitizeCheckpointDetails(
  type: DiagnosticCheckpointType,
  value: unknown,
): DiagnosticDetails {
  switch (type) {
    case "session-start": {
      const result: DiagnosticDetails = {};
      add(result, "appVersion", shortText(own(value, "appVersion")));
      add(result, "buildCommit", shortText(own(value, "buildCommit")));
      add(result, "diagnosticSchemaVersion", own(value, "diagnosticSchemaVersion") === 1 ? 1 : undefined);
      add(result, "userAgent", shortText(own(value, "userAgent")));
      add(result, "platform", shortText(own(value, "platform")));
      add(result, "deviceMemoryGiB", finite(own(value, "deviceMemoryGiB")));
      add(result, "hardwareConcurrency", finite(own(value, "hardwareConcurrency")));
      add(result, "webAssembly", typeof own(value, "webAssembly") === "boolean" ? own(value, "webAssembly") as boolean : undefined);
      add(result, "worker", typeof own(value, "worker") === "boolean" ? own(value, "worker") as boolean : undefined);
      add(result, "offlineAudioContext", typeof own(value, "offlineAudioContext") === "boolean" ? own(value, "offlineAudioContext") as boolean : undefined);
      add(result, "readableStream", typeof own(value, "readableStream") === "boolean" ? own(value, "readableStream") as boolean : undefined);
      add(result, "responseBlob", typeof own(value, "responseBlob") === "boolean" ? own(value, "responseBlob") as boolean : undefined);
      add(result, "randomUUID", typeof own(value, "randomUUID") === "boolean" ? own(value, "randomUUID") as boolean : undefined);
      add(result, "localStorage", typeof own(value, "localStorage") === "boolean" ? own(value, "localStorage") as boolean : undefined);
      add(result, "clipboard", typeof own(value, "clipboard") === "boolean" ? own(value, "clipboard") as boolean : undefined);
      return result;
    }
    case "input": return inputDetails(value);
    case "options": return optionsDetails(value);
    case "decode-start": return inputDetails(value);
    case "decode-success": {
      const result = inputDetails(value);
      add(result, "sampleRate", finite(own(value, "sampleRate")));
      add(result, "channels", finite(own(value, "channels")));
      add(result, "frames", nonNegative(own(value, "frames")));
      return result;
    }
    case "decode-failure": {
      const result: DiagnosticDetails = {};
      add(result, "slot", slot(own(value, "slot")));
      addError(result, own(value, "error"), "decode");
      return result;
    }
    case "memory-plan": return memoryPlanDetails(value);
    case "worker-created": return {};
    case "wasm-init-start": return {};
    case "wasm-init-success": return {};
    case "wasm-init-failure": {
      const result: DiagnosticDetails = {};
      addError(result, own(value, "error"), "wasm");
      return result;
    }
    case "progress-stage": {
      const result: DiagnosticDetails = {};
      const stage = own(value, "stage");
      add(result, "stage", typeof stage === "string" && STAGES.has(stage) ? stage : undefined);
      add(result, "fraction", finite(own(value, "fraction")));
      return result;
    }
    case "output-start": {
      const result: DiagnosticDetails = {};
      add(result, "outputFrames", nonNegative(own(value, "outputFrames")));
      return result;
    }
    case "output-milestone": {
      const result: DiagnosticDetails = {};
      const fraction = own(value, "fraction");
      add(result, "fraction", fraction === 0.25 || fraction === 0.5 || fraction === 0.75 ? fraction : undefined);
      add(result, "chunkCount", nonNegative(own(value, "chunkCount")));
      add(result, "pcmBytes", nonNegative(own(value, "pcmBytes")));
      return result;
    }
    case "blob-complete": {
      const result: DiagnosticDetails = {};
      add(result, "chunkCount", nonNegative(own(value, "chunkCount")));
      add(result, "pcmBytes", nonNegative(own(value, "pcmBytes")));
      add(result, "wavBytes", nonNegative(own(value, "wavBytes")));
      return result;
    }
    case "preview-assigned": {
      const result: DiagnosticDetails = {};
      add(result, "wavBytes", nonNegative(own(value, "wavBytes")));
      return result;
    }
    case "success": {
      const result: DiagnosticDetails = {};
      add(result, "outputFrames", nonNegative(own(value, "outputFrames")));
      add(result, "durationSeconds", nonNegative(own(value, "durationSeconds")));
      add(result, "detectedBeats", nonNegative(own(value, "detectedBeats")));
      add(result, "detectedBpm", finite(own(value, "detectedBpm")));
      add(result, "beatConfidence", finite(own(value, "beatConfidence")));
      add(result, "appliedGainDb", finite(own(value, "appliedGainDb")));
      add(result, "estimatedTruePeakDbtp", finite(own(value, "estimatedTruePeakDbtp")));
      return result;
    }
    case "error": {
      const result: DiagnosticDetails = {};
      addError(result, value, "processing");
      return result;
    }
    case "worker-error": {
      const result: DiagnosticDetails = {};
      addError(result, own(value, "error"), "worker");
      return result;
    }
    case "worker-messageerror": {
      const result: DiagnosticDetails = {};
      addError(result, own(value, "error"), "worker");
      return result;
    }
    case "cancelled": return {};
    case "visibility": {
      const result: DiagnosticDetails = {};
      const state = own(value, "state");
      add(result, "state", state === "visible" || state === "hidden" ? state : undefined);
      return result;
    }
    case "pagehide": {
      const result: DiagnosticDetails = {};
      add(result, "persisted", typeof own(value, "persisted") === "boolean" ? own(value, "persisted") as boolean : undefined);
      return result;
    }
    case "clean-shutdown": return {};
    case "unexpected-termination": {
      const result: DiagnosticDetails = {};
      add(result, "markerOnly", typeof own(value, "markerOnly") === "boolean" ? own(value, "markerOnly") as boolean : undefined);
      return result;
    }
    case "audio-error": {
      const result: DiagnosticDetails = {};
      addError(result, own(value, "error"), "audio");
      return result;
    }
  }
}

export { ERROR_DETAIL_KEYS };
