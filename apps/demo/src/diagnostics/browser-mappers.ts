import type { DiagnosticEnvironment } from "./model";
import {
  sanitizeEnvironmentText,
  sanitizeError,
  sanitizeSensitiveText,
} from "./sanitize";

const MAX_META_LENGTH = 120;
const MEDIA_ERROR_CODES = new Map<number, string>([
  [1, "MEDIA_ERR_ABORTED"],
  [2, "MEDIA_ERR_NETWORK"],
  [3, "MEDIA_ERR_DECODE"],
  [4, "MEDIA_ERR_SRC_NOT_SUPPORTED"],
]);

export interface BrowserAttemptInput {
  inputs: Array<{
    slot: "a" | "b";
    mimeType: string;
    encodedBytes: number;
  }>;
  options: {
    appendReverse: boolean;
    beatPan: "a" | "b" | null;
    panTransitionMs: number;
    reverseCrossfadeMs: number;
    targetDbtp: number;
  };
}

export function field(value: unknown, key: string): unknown {
  if (
    (typeof value !== "object" || value === null) &&
    typeof value !== "function"
  ) return undefined;
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

export function stringField(
  value: unknown,
  key: string,
): string | undefined {
  const candidate = field(value, key);
  return typeof candidate === "string" ? candidate : undefined;
}

export function numberField(
  value: unknown,
  key: string,
): number | undefined {
  const candidate = finite(field(value, key));
  return candidate === null ? undefined : candidate;
}

export function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function nonNegative(value: unknown): number | null {
  const number = finite(value);
  return number !== null && number >= 0 ? number : null;
}

export function positive(value: unknown): number | null {
  const number = finite(value);
  return number !== null && number > 0 ? number : null;
}

export function safeMetaText(value: unknown): string {
  return typeof value === "string"
    ? sanitizeSensitiveText(value).slice(0, MAX_META_LENGTH)
    : "";
}

export function copyInputs(value: unknown): BrowserAttemptInput["inputs"] {
  if (!Array.isArray(value)) return [];
  const result: BrowserAttemptInput["inputs"] = [];
  for (let index = 0; index < Math.min(value.length, 2); index += 1) {
    const candidate = value[index];
    const slot = field(candidate, "slot");
    const mimeType = field(candidate, "mimeType");
    const encodedBytes = nonNegative(field(candidate, "encodedBytes"));
    if (
      (slot === "a" || slot === "b") &&
      typeof mimeType === "string" &&
      encodedBytes !== null
    ) {
      result.push({
        slot,
        mimeType: safeMimeType(mimeType),
        encodedBytes,
      });
    }
  }
  return result;
}

function safeMimeType(value: string): string {
  const bounded = value.slice(0, MAX_META_LENGTH)
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .trim();
  return /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u.test(bounded)
    ? bounded
    : "";
}

export function copyOptions(value: unknown): BrowserAttemptInput["options"] {
  const beatPan = field(value, "beatPan");
  return {
    appendReverse: field(value, "appendReverse") === true,
    beatPan: beatPan === "a" || beatPan === "b" ? beatPan : null,
    panTransitionMs: nonNegative(field(value, "panTransitionMs")) ?? 0,
    reverseCrossfadeMs:
      nonNegative(field(value, "reverseCrossfadeMs")) ?? 0,
    targetDbtp: finite(field(value, "targetDbtp")) ?? 0,
  };
}

export function copyEnvironment(
  value: DiagnosticEnvironment,
): DiagnosticEnvironment {
  const capabilities = field(value, "capabilities");
  return {
    userAgent: sanitizeEnvironmentText(field(value, "userAgent")),
    platform: sanitizeEnvironmentText(field(value, "platform")),
    deviceMemoryGiB: positive(field(value, "deviceMemoryGiB")),
    hardwareConcurrency: positive(field(value, "hardwareConcurrency")),
    capabilities: {
      webAssembly: field(capabilities, "webAssembly") === true,
      worker: field(capabilities, "worker") === true,
      offlineAudioContext:
        field(capabilities, "offlineAudioContext") === true,
      readableStream: field(capabilities, "readableStream") === true,
      responseBlob: field(capabilities, "responseBlob") === true,
      randomUUID: field(capabilities, "randomUUID") === true,
      localStorage: field(capabilities, "localStorage") === true,
      clipboard: field(capabilities, "clipboard") === true,
    },
  };
}

export function mapMediaError(
  value: unknown,
): ReturnType<typeof sanitizeError> {
  const numericCode = finite(field(value, "code"));
  const message = field(value, "message");
  return sanitizeError({
    code: numericCode === null ? undefined : MEDIA_ERROR_CODES.get(numericCode),
    message: typeof message === "string" ? message : undefined,
  }, "audio");
}
