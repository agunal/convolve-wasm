import {
  sanitizeCheckpointDetails,
  sanitizeSensitiveText,
} from "./sanitize";

export const DIAGNOSTIC_SCHEMA_VERSION = 1 as const;
export const DIAGNOSTIC_EXPORT_VERSION = 1 as const;
export const DIAGNOSTIC_STORE_KEY = "convolve-wasm:diagnostics:v1";
export const DIAGNOSTIC_ACTIVE_KEY = "convolve-wasm:diagnostics:active:v1";
export const DIAGNOSTIC_LIMITS = Object.freeze({
  retainedSessions: 6,
  sessionBytes: 32_768,
  checkpointsPerSession: 96,
});

export type DiagnosticStorageState =
  | "available"
  | "unavailable"
  | "quota-exceeded"
  | "recovered-corruption"
  | "unsupported-schema";
export type DiagnosticSessionStatus =
  | "active"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "clean-shutdown"
  | "unexpected-termination";
export type DiagnosticScalar = string | number | boolean | null;
export type DiagnosticDetails = Record<string, DiagnosticScalar>;

export type DiagnosticCheckpointType =
  | "session-start"
  | "input"
  | "options"
  | "decode-start"
  | "decode-success"
  | "decode-failure"
  | "memory-plan"
  | "worker-created"
  | "wasm-init-start"
  | "wasm-init-success"
  | "wasm-init-failure"
  | "progress-stage"
  | "output-start"
  | "output-milestone"
  | "blob-complete"
  | "preview-assigned"
  | "success"
  | "error"
  | "worker-error"
  | "worker-messageerror"
  | "cancelled"
  | "visibility"
  | "pagehide"
  | "clean-shutdown"
  | "unexpected-termination"
  | "audio-error";

export interface DiagnosticCheckpoint {
  sequence: number;
  type: DiagnosticCheckpointType;
  timestamp: string;
  elapsedMs: number;
  details: DiagnosticDetails;
}

export interface DiagnosticCapabilities {
  webAssembly: boolean;
  worker: boolean;
  offlineAudioContext: boolean;
  readableStream: boolean;
  responseBlob: boolean;
  randomUUID: boolean;
  localStorage: boolean;
  clipboard: boolean;
}

export interface DiagnosticEnvironment {
  userAgent: string;
  platform: string;
  deviceMemoryGiB: number | null;
  hardwareConcurrency: number | null;
  capabilities: DiagnosticCapabilities;
}

export interface DiagnosticSession {
  schemaVersion: 1;
  id: string;
  startedAt: string;
  updatedAt: string;
  status: DiagnosticSessionStatus;
  app: { version: string; buildCommit: string };
  environment: DiagnosticEnvironment | null;
  checkpoints: DiagnosticCheckpoint[];
  droppedCheckpoints: number;
  inference?: {
    kind: "unexpected-termination";
    inferredAt: string;
    markerOnly: boolean;
    statement: string;
  };
}

export interface DiagnosticStore {
  schemaVersion: 1;
  sessions: DiagnosticSession[];
}

export interface ActiveSessionMarker {
  schemaVersion: 1;
  sessionId: string;
  startedAt: string;
  updatedAt: string;
  lastCheckpointSequence: number;
  appVersion: string;
  buildCommit: string;
}

export type DiagnosticStoreMigration =
  | { kind: "ok"; store: DiagnosticStore }
  | { kind: "corrupt" }
  | { kind: "unsupported" };

const CHECKPOINT_TYPES = new Set<DiagnosticCheckpointType>([
  "session-start", "input", "options", "decode-start", "decode-success",
  "decode-failure", "memory-plan", "worker-created", "wasm-init-start",
  "wasm-init-success", "wasm-init-failure", "progress-stage", "output-start",
  "output-milestone", "blob-complete", "preview-assigned", "success", "error",
  "worker-error", "worker-messageerror", "cancelled", "visibility", "pagehide",
  "clean-shutdown", "unexpected-termination", "audio-error",
]);
const SESSION_STATUSES = new Set<DiagnosticSessionStatus>([
  "active", "succeeded", "failed", "cancelled", "clean-shutdown",
  "unexpected-termination",
]);
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

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

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  const number = finiteNumber(value);
  return number !== null && Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function timestamp(value: unknown): string | null {
  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value)) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function shortText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return sanitizeSensitiveText(value).slice(0, 120);
}

function nullablePositiveNumber(value: unknown): number | null | undefined {
  if (value === null) return null;
  const number = finiteNumber(value);
  return number !== null && number > 0 ? number : undefined;
}

function parseCapabilities(value: unknown): DiagnosticCapabilities | null {
  const webAssembly = own(value, "webAssembly");
  const worker = own(value, "worker");
  const offlineAudioContext = own(value, "offlineAudioContext");
  const readableStream = own(value, "readableStream");
  const responseBlob = own(value, "responseBlob");
  const randomUUID = own(value, "randomUUID");
  const localStorage = own(value, "localStorage");
  const clipboard = own(value, "clipboard");
  if (
    typeof webAssembly !== "boolean" || typeof worker !== "boolean" ||
    typeof offlineAudioContext !== "boolean" || typeof readableStream !== "boolean" ||
    typeof responseBlob !== "boolean" || typeof randomUUID !== "boolean" ||
    typeof localStorage !== "boolean" || typeof clipboard !== "boolean"
  ) return null;
  return {
    webAssembly, worker, offlineAudioContext, readableStream, responseBlob,
    randomUUID, localStorage, clipboard,
  };
}

function parseEnvironment(value: unknown): DiagnosticEnvironment | null {
  if (value === null) return null;
  const userAgent = shortText(own(value, "userAgent"));
  const platform = shortText(own(value, "platform"));
  const deviceMemoryGiB = nullablePositiveNumber(own(value, "deviceMemoryGiB"));
  const hardwareConcurrency = nullablePositiveNumber(own(value, "hardwareConcurrency"));
  const capabilities = parseCapabilities(own(value, "capabilities"));
  if (
    userAgent === null || platform === null || deviceMemoryGiB === undefined ||
    hardwareConcurrency === undefined || capabilities === null
  ) return null;
  return { userAgent, platform, deviceMemoryGiB, hardwareConcurrency, capabilities };
}

function parseCheckpoint(value: unknown): DiagnosticCheckpoint | null {
  const sequence = nonNegativeInteger(own(value, "sequence"));
  const type = own(value, "type");
  const checkpointTimestamp = timestamp(own(value, "timestamp"));
  const elapsedMs = finiteNumber(own(value, "elapsedMs"));
  if (
    sequence === null || typeof type !== "string" || !CHECKPOINT_TYPES.has(type as DiagnosticCheckpointType) ||
    checkpointTimestamp === null || elapsedMs === null || elapsedMs < 0
  ) return null;
  return {
    sequence,
    type: type as DiagnosticCheckpointType,
    timestamp: checkpointTimestamp,
    elapsedMs,
    details: sanitizeCheckpointDetails(type as DiagnosticCheckpointType, own(value, "details")),
  };
}

function parseSession(value: unknown): DiagnosticSession | null {
  if (own(value, "schemaVersion") !== DIAGNOSTIC_SCHEMA_VERSION) return null;
  const id = own(value, "id");
  const startedAt = timestamp(own(value, "startedAt"));
  const updatedAt = timestamp(own(value, "updatedAt"));
  const status = own(value, "status");
  const app = own(value, "app");
  const version = shortText(own(app, "version"));
  const buildCommit = shortText(own(app, "buildCommit"));
  const environment = parseEnvironment(own(value, "environment"));
  const checkpointsValue = own(value, "checkpoints");
  const droppedCheckpoints = nonNegativeInteger(own(value, "droppedCheckpoints"));
  if (
    typeof id !== "string" || !SESSION_ID.test(id) || startedAt === null || updatedAt === null ||
    typeof status !== "string" || !SESSION_STATUSES.has(status as DiagnosticSessionStatus) ||
    version === null || buildCommit === null || environment === null && own(value, "environment") !== null ||
    !Array.isArray(checkpointsValue) || checkpointsValue.length > DIAGNOSTIC_LIMITS.checkpointsPerSession ||
    droppedCheckpoints === null
  ) return null;
  const checkpoints: DiagnosticCheckpoint[] = [];
  for (const checkpointValue of checkpointsValue) {
    const checkpoint = parseCheckpoint(checkpointValue);
    if (checkpoint === null) return null;
    checkpoints.push(checkpoint);
  }
  const inferenceValue = own(value, "inference");
  const inference = parseInference(inferenceValue);
  if (inferenceValue !== undefined && inference === null) return null;
  return {
    schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
    id,
    startedAt,
    updatedAt,
    status: status as DiagnosticSessionStatus,
    app: { version, buildCommit },
    environment,
    checkpoints,
    droppedCheckpoints,
    ...(inference === null ? {} : { inference }),
  };
}

function parseInference(value: unknown): DiagnosticSession["inference"] | null {
  if (!isRecord(value)) return null;
  const inferredAt = timestamp(own(value, "inferredAt"));
  const markerOnly = own(value, "markerOnly");
  const statement = shortText(own(value, "statement"));
  if (
    own(value, "kind") !== "unexpected-termination" || inferredAt === null ||
    typeof markerOnly !== "boolean" || statement === null
  ) return null;
  return { kind: "unexpected-termination", inferredAt, markerOnly, statement };
}

export function migrateDiagnosticStore(value: unknown): DiagnosticStoreMigration {
  if (!isRecord(value)) return { kind: "corrupt" };
  const schemaVersion = own(value, "schemaVersion");
  if (schemaVersion !== DIAGNOSTIC_SCHEMA_VERSION) {
    return typeof schemaVersion === "number" ? { kind: "unsupported" } : { kind: "corrupt" };
  }
  const sessionsValue = own(value, "sessions");
  if (!Array.isArray(sessionsValue) || sessionsValue.length > DIAGNOSTIC_LIMITS.retainedSessions) {
    return { kind: "corrupt" };
  }
  const sessions: DiagnosticSession[] = [];
  for (const sessionValue of sessionsValue) {
    const session = parseSession(sessionValue);
    if (session === null) return { kind: "corrupt" };
    sessions.push(session);
  }
  return { kind: "ok", store: { schemaVersion: DIAGNOSTIC_SCHEMA_VERSION, sessions } };
}

export function parseActiveMarker(value: unknown): ActiveSessionMarker | null {
  if (!isRecord(value) || own(value, "schemaVersion") !== DIAGNOSTIC_SCHEMA_VERSION) return null;
  const sessionId = own(value, "sessionId");
  const startedAt = timestamp(own(value, "startedAt"));
  const updatedAt = timestamp(own(value, "updatedAt"));
  const lastCheckpointSequence = nonNegativeInteger(own(value, "lastCheckpointSequence"));
  const appVersion = shortText(own(value, "appVersion"));
  const buildCommit = shortText(own(value, "buildCommit"));
  if (
    typeof sessionId !== "string" || !SESSION_ID.test(sessionId) || startedAt === null ||
    updatedAt === null || lastCheckpointSequence === null || appVersion === null || buildCommit === null
  ) return null;
  return {
    schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
    sessionId,
    startedAt,
    updatedAt,
    lastCheckpointSequence,
    appVersion,
    buildCommit,
  };
}
