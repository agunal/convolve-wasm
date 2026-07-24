import type { ConvolveProgress } from "@takana-labs/convolve-wasm";

import {
  DIAGNOSTIC_ACTIVE_KEY,
  DIAGNOSTIC_EXPORT_VERSION,
  DIAGNOSTIC_LIMITS,
  DIAGNOSTIC_SCHEMA_VERSION,
  DIAGNOSTIC_STORE_KEY,
  migrateDiagnosticStore,
  parseActiveMarker,
  type ActiveSessionMarker,
  type DiagnosticCheckpoint,
  type DiagnosticCheckpointType,
  type DiagnosticEnvironment,
  type DiagnosticSession,
  type DiagnosticSessionStatus,
  type DiagnosticStorageState,
  type DiagnosticStore,
} from "./model";
import {
  sanitizeCheckpointDetails,
  sanitizeBareMimeType,
  sanitizeEnvironmentText,
  sanitizePlatformText,
  sanitizeSensitiveText,
} from "./sanitize";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface DiagnosticSnapshot {
  storageState: DiagnosticStorageState;
  sessions: readonly DiagnosticSession[];
  activeSessionId: string | null;
  recoveredSessionId: string | null;
}

export interface DiagnosticExport {
  exportFormat: "convolve-wasm-diagnostics";
  exportVersion: 1;
  generatedAt: string;
  notice: string;
  privacy: {
    audioDataRecorded: false;
    fileNamesRecorded: false;
    automaticUpload: false;
  };
  limits: {
    retainedSessions: 6;
    sessionBytes: 32_768;
    checkpointsPerSession: 96;
  };
  storageState: DiagnosticStorageState;
  sessions: DiagnosticSession[];
}

export interface RecorderDependencies {
  getStorage(): StorageLike | null;
  now(): Date;
  monotonicNow(): number;
  id(): string;
  defer(task: () => void): void;
}

export interface StartSessionInput {
  id?: string;
  app: { version: string; buildCommit: string };
  environment: DiagnosticEnvironment;
  inputs: Array<{ slot: "a" | "b"; mimeType: string; encodedBytes: number }>;
  options: {
    appendReverse: boolean;
    beatPan: "a" | "b" | null;
    panTransitionMs: number;
    reverseCrossfadeMs: number;
    targetDbtp: number;
  };
}

export interface IncidentContext {
  app: { version: string; buildCommit: string };
  environment: DiagnosticEnvironment;
}

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const TERMINAL_STATUSES = new Set<DiagnosticSessionStatus>([
  "succeeded",
  "failed",
  "cancelled",
  "clean-shutdown",
  "unexpected-termination",
]);
const NORMAL_TERMINAL_CHECKPOINT_TYPES = new Set<DiagnosticCheckpointType>([
  "success",
  "cancelled",
  "clean-shutdown",
]);
type StoreLoadKind = "ok" | "corrupt" | "unsupported";
type MarkerMigration =
  | { kind: "none" }
  | { kind: "ok"; marker: ActiveSessionMarker }
  | { kind: "corrupt" }
  | { kind: "unsupported" };
const INFERENCE_STATEMENT =
  "A prior active marker was found; this does not establish out-of-memory or any exact cause.";
const MARKER_ONLY_INFERENCE_STATEMENT =
  "A prior active marker was found, but detailed checkpoints were unavailable; this does not establish out-of-memory or any exact cause.";
const EXPORT_NOTICE =
  "Local diagnostic checkpoints only. Unexpected termination is an inference and does not identify an exact cause.";
const encoder = new TextEncoder();

export class DiagnosticRecorder {
  private storage: StorageLike | null = null;
  private storageState: DiagnosticStorageState = "available";
  private sessions: DiagnosticSession[] = [];
  private activeSessionId: string | null = null;
  private recoveredSessionId: string | null = null;
  private activeStartedMonotonic = 0;
  private lastProgressStage: ConvolveProgress["stage"] | null = null;
  private readonly listeners = new Set<(snapshot: DiagnosticSnapshot) => void>();

  constructor(private readonly dependencies: RecorderDependencies) {
    this.load();
  }

  startSession(input: StartSessionInput): string {
    const requestedId = ownData(input, "id");
    const id = this.safeSessionId(typeof requestedId === "string" ? requestedId : undefined);
    try {
      const startedAt = this.safeNow();
      const app = safeApp(ownData(input, "app"));
      const environment = safeEnvironment(ownData(input, "environment"));
      this.activeStartedMonotonic = this.safeMonotonicNow();
      this.lastProgressStage = null;

      const session: DiagnosticSession = {
        schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
        id,
        startedAt,
        updatedAt: startedAt,
        status: "active",
        app,
        environment,
        checkpoints: [],
        droppedCheckpoints: 0,
      };
      this.appendToSession(session, "session-start", {
        appVersion: app.version,
        buildCommit: app.buildCommit,
        diagnosticSchemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
        userAgent: environment.userAgent,
        platform: environment.platform,
        deviceMemoryGiB: environment.deviceMemoryGiB,
        hardwareConcurrency: environment.hardwareConcurrency,
        ...environment.capabilities,
      });
      for (const inputDetails of firstTwo(ownData(input, "inputs"))) {
        this.appendToSession(session, "input", safeInputDetails(inputDetails));
      }
      this.appendToSession(session, "options", ownData(input, "options"));

      const validated = reconstructSession(session);
      this.sessions = this.sessions.filter((candidate) => candidate.id !== id);
      this.sessions.push(validated ?? minimalSession(id, startedAt, app));
      this.activeSessionId = id;
      this.sortAndRetain();
      this.persistRing();
      this.persistActiveMarker();
      this.notify();
    } catch {
      this.ensureMinimalActiveSession(id);
      this.notify();
    }
    return id;
  }

  checkpoint(type: DiagnosticCheckpointType, details?: unknown): void {
    try {
      const session = this.activeSession();
      if (!session) return;
      this.appendToSession(session, type, details);
      this.persistRing();
      this.persistActiveMarker();
      this.notify();
    } catch {
      // Diagnostics must never interrupt processing.
    }
  }

  recordProgress(event: ConvolveProgress): void {
    try {
      if (event.stage === this.lastProgressStage) return;
      this.lastProgressStage = event.stage;
      this.checkpoint("progress-stage", event);
    } catch {
      // Diagnostics must never interrupt processing.
    }
  }

  finish(
    status: Exclude<DiagnosticSessionStatus, "active" | "unexpected-termination">,
    type: DiagnosticCheckpointType,
    details?: unknown,
  ): void {
    try {
      const session = this.activeSession();
      if (!session) return;
      this.appendToSession(session, type, details);
      session.status = status;
      this.boundSession(session);
      this.persistRing();
      this.removeActiveMarker();
      this.activeSessionId = null;
      this.lastProgressStage = null;
      this.notify();
    } catch {
      const session = this.activeSession();
      if (session) session.status = status;
      this.activeSessionId = null;
      this.lastProgressStage = null;
    }
  }

  recordIncident(
    type: DiagnosticCheckpointType,
    details: unknown,
    context?: IncidentContext,
  ): void {
    try {
      const active = this.activeSession();
      if (active) {
        this.appendToSession(active, type, details);
        this.persistRing();
        this.persistActiveMarker();
        this.notify();
        return;
      }

      const terminal = [...this.sessions].reverse().find(isTerminal);
      if (terminal) {
        this.appendToSession(terminal, type, details);
        this.persistRing(terminal.id);
        this.notify();
        return;
      }

      const startedAt = this.safeNow();
      const app = safeApp(ownData(context, "app"));
      const environment = safeEnvironment(ownData(context, "environment"));
      this.activeStartedMonotonic = this.safeMonotonicNow();
      const session: DiagnosticSession = {
        schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
        id: this.safeSessionId(),
        startedAt,
        updatedAt: startedAt,
        status: "failed",
        app,
        environment,
        checkpoints: [],
        droppedCheckpoints: 0,
      };
      this.appendToSession(session, "session-start", {
        appVersion: app.version,
        buildCommit: app.buildCommit,
        diagnosticSchemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
        userAgent: environment.userAgent,
        platform: environment.platform,
        deviceMemoryGiB: environment.deviceMemoryGiB,
        hardwareConcurrency: environment.hardwareConcurrency,
        ...environment.capabilities,
      });
      this.appendToSession(session, type, details);
      this.sessions.push(session);
      this.sortAndRetain();
      this.persistRing(session.id);
      this.notify();
    } catch {
      // Incidents are observational and must never interrupt processing.
    }
  }

  snapshot(): DiagnosticSnapshot {
    return {
      storageState: this.storageState,
      sessions: cloneSessions(this.sessions),
      activeSessionId: this.activeSessionId,
      recoveredSessionId: this.recoveredSessionId,
    };
  }

  subscribe(listener: (snapshot: DiagnosticSnapshot) => void): () => void {
    try {
      this.listeners.add(listener);
    } catch {
      // A broken listener collection must not affect processing.
    }
    return () => {
      try {
        this.listeners.delete(listener);
      } catch {
        // Unsubscription is best effort.
      }
    };
  }

  exportJson(): string {
    const validated = migrateDiagnosticStore({
      schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
      sessions: cloneSessions(this.sessions),
    });
    const sessions = validated.kind === "ok" ? validated.store.sessions : [];
    const envelope: DiagnosticExport = {
      exportFormat: "convolve-wasm-diagnostics",
      exportVersion: DIAGNOSTIC_EXPORT_VERSION,
      generatedAt: this.safeNow(),
      notice: EXPORT_NOTICE,
      privacy: {
        audioDataRecorded: false,
        fileNamesRecorded: false,
        automaticUpload: false,
      },
      limits: {
        retainedSessions: DIAGNOSTIC_LIMITS.retainedSessions,
        sessionBytes: DIAGNOSTIC_LIMITS.sessionBytes,
        checkpointsPerSession: DIAGNOSTIC_LIMITS.checkpointsPerSession,
      },
      storageState: this.storageState,
      sessions,
    };
    return `${JSON.stringify(envelope, null, 2)}\n`;
  }

  clear(): void {
    this.sessions = [];
    this.activeSessionId = null;
    this.recoveredSessionId = null;
    this.lastProgressStage = null;
    if (!this.storage) {
      try {
        this.storage = this.dependencies.getStorage();
      } catch {
        this.storageState = "unavailable";
      }
    }
    const storage = this.storage;
    if (storage) {
      let failed = false;
      for (const key of [DIAGNOSTIC_STORE_KEY, DIAGNOSTIC_ACTIVE_KEY]) {
        try {
          storage.removeItem(key);
        } catch (error) {
          failed = true;
          this.degradeFor(error);
        }
      }
      if (!failed) this.storageState = "available";
    }
    this.notify();
  }

  private load(): void {
    try {
      this.storage = this.dependencies.getStorage();
    } catch {
      this.storageState = "unavailable";
      this.storage = null;
      return;
    }
    if (!this.storage) {
      this.storageState = "unavailable";
      return;
    }

    let rawStore: string | null;
    let rawMarker: string | null;
    try {
      rawStore = this.storage.getItem(DIAGNOSTIC_STORE_KEY);
      rawMarker = this.storage.getItem(DIAGNOSTIC_ACTIVE_KEY);
    } catch {
      this.storageState = "unavailable";
      this.storage = null;
      return;
    }

    const storeKind = rawStore === null ? "ok" : this.loadStore(rawStore);
    const markerMigration = migrateMarker(rawMarker);
    if (storeKind !== "ok") {
      this.storageState = storeKind === "unsupported"
        ? "unsupported-schema"
        : "recovered-corruption";
      if (storeKind === "corrupt" && markerMigration.kind === "ok") {
        this.discardStorePreservingState();
        this.recover(markerMigration.marker);
      } else {
        this.resetRecorderKeys();
      }
      return;
    }

    if (markerMigration.kind === "corrupt") {
      this.storageState = "recovered-corruption";
      this.discardActiveMarkerPreservingState();
      return;
    }
    if (markerMigration.kind === "unsupported") {
      this.storageState = "unsupported-schema";
      this.discardActiveMarkerPreservingState();
      return;
    }
    if (markerMigration.kind === "ok") this.recover(markerMigration.marker);
  }

  private loadStore(raw: string): StoreLoadKind {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return "corrupt";
    }
    const migration = migrateDiagnosticStore(parsed);
    if (migration.kind === "unsupported") return "unsupported";
    if (migration.kind === "corrupt") return "corrupt";
    this.sessions = migration.store.sessions;
    for (const session of this.sessions) this.boundSession(session);
    this.sortAndRetain();
    return "ok";
  }

  private discardStorePreservingState(): void {
    if (!this.storage) return;
    try {
      this.storage.removeItem(DIAGNOSTIC_STORE_KEY);
    } catch {
      this.storage = null;
    }
  }

  private resetRecorderKeys(): void {
    const storage = this.storage;
    if (!storage) return;
    let failed = false;
    for (const key of [DIAGNOSTIC_STORE_KEY, DIAGNOSTIC_ACTIVE_KEY]) {
      try {
        storage.removeItem(key);
      } catch {
        failed = true;
      }
    }
    if (failed) this.storage = null;
  }

  private discardActiveMarkerPreservingState(): void {
    if (!this.storage) return;
    try {
      this.storage.removeItem(DIAGNOSTIC_ACTIVE_KEY);
    } catch {
      this.storage = null;
    }
  }

  private recover(marker: ActiveSessionMarker): void {
    const existing = this.sessions.find((session) => session.id === marker.sessionId);
    if (existing && (
      existing.status !== "active" || hasNormalTerminalCheckpoint(existing)
    )) {
      this.removeActiveMarker();
      return;
    }

    const markerOnly = !existing;
    const recovered = existing ?? this.markerOnlySession(marker);
    recovered.status = "unexpected-termination";
    const inferredAt = this.safeNow();
    recovered.inference = {
      kind: "unexpected-termination",
      inferredAt,
      markerOnly,
      statement: markerOnly ? MARKER_ONLY_INFERENCE_STATEMENT : INFERENCE_STATEMENT,
    };
    this.appendToSession(recovered, "unexpected-termination", { markerOnly });
    if (markerOnly) this.sessions.push(recovered);
    this.recoveredSessionId = recovered.id;
    this.sortAndRetain();
    this.persistRing();
    this.removeActiveMarker();
  }

  private markerOnlySession(marker: ActiveSessionMarker): DiagnosticSession {
    return {
      schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
      id: marker.sessionId,
      startedAt: marker.startedAt,
      updatedAt: marker.updatedAt,
      status: "unexpected-termination",
      app: {
        version: marker.appVersion,
        buildCommit: marker.buildCommit,
      },
      environment: null,
      checkpoints: [],
      droppedCheckpoints: 0,
    };
  }

  private appendToSession(
    session: DiagnosticSession,
    type: DiagnosticCheckpointType,
    details: unknown,
  ): void {
    const timestamp = this.safeNow();
    const previousSequence = session.checkpoints.at(-1)?.sequence ?? -1;
    const checkpoint: DiagnosticCheckpoint = {
      sequence: previousSequence + 1,
      type,
      timestamp,
      elapsedMs: Math.max(0, this.safeMonotonicNow() - this.activeStartedMonotonic),
      details: sanitizeCheckpointDetails(type, details),
    };
    session.checkpoints.push(checkpoint);
    session.updatedAt = timestamp;
    this.boundSession(session);
  }

  private boundSession(session: DiagnosticSession): void {
    while (
      session.checkpoints.length > DIAGNOSTIC_LIMITS.checkpointsPerSession ||
      serializedBytes(session) > DIAGNOSTIC_LIMITS.sessionBytes
    ) {
      const removableIndex = session.checkpoints.length > 1 ? 1 : -1;
      if (removableIndex < 0) break;
      session.checkpoints.splice(removableIndex, 1);
      session.droppedCheckpoints += 1;
    }
  }

  private sortAndRetain(): void {
    this.sessions.sort(compareSessions);
    while (this.sessions.length > DIAGNOSTIC_LIMITS.retainedSessions) {
      const terminalIndex = this.sessions.findIndex(
        (session) => isTerminal(session) &&
          session.id !== this.activeSessionId &&
          session.id !== this.recoveredSessionId,
      );
      const unprotectedIndex = this.sessions.findIndex(
        (session) => session.id !== this.activeSessionId &&
          session.id !== this.recoveredSessionId,
      );
      const index = terminalIndex >= 0 ? terminalIndex : unprotectedIndex;
      this.sessions.splice(index >= 0 ? index : 0, 1);
    }
  }

  private persistRing(protectedSessionId?: string): boolean {
    while (this.storage) {
      try {
        const store: DiagnosticStore = {
          schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
          sessions: this.sessions,
        };
        this.storage.setItem(DIAGNOSTIC_STORE_KEY, JSON.stringify(store));
        return true;
      } catch (error) {
        if (isQuotaError(error) && this.pruneOldestTerminal(protectedSessionId)) continue;
        this.degradeFor(error);
        return false;
      }
    }
    return false;
  }

  private persistActiveMarker(): void {
    const session = this.activeSession();
    if (!session || !this.storage) return;
    const marker: ActiveSessionMarker = {
      schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
      sessionId: session.id,
      startedAt: session.startedAt,
      updatedAt: session.updatedAt,
      lastCheckpointSequence: session.checkpoints.at(-1)?.sequence ?? 0,
      appVersion: session.app.version,
      buildCommit: session.app.buildCommit,
    };
    while (this.storage) {
      try {
        this.storage.setItem(DIAGNOSTIC_ACTIVE_KEY, JSON.stringify(marker));
        return;
      } catch (error) {
        if (isQuotaError(error) && this.pruneOldestTerminal()) {
          if (!this.persistRing()) return;
          continue;
        }
        this.degradeFor(error);
        return;
      }
    }
  }

  private removeActiveMarker(): void {
    if (!this.storage) return;
    try {
      this.storage.removeItem(DIAGNOSTIC_ACTIVE_KEY);
    } catch (error) {
      this.degradeFor(error);
    }
  }

  private pruneOldestTerminal(protectedSessionId?: string): boolean {
    this.sessions.sort(compareSessions);
    const index = this.sessions.findIndex(
      (session) =>
        isTerminal(session) &&
        session.id !== this.activeSessionId &&
        session.id !== this.recoveredSessionId &&
        session.id !== protectedSessionId,
    );
    if (index < 0) return false;
    this.sessions.splice(index, 1);
    return true;
  }

  private activeSession(): DiagnosticSession | undefined {
    if (this.activeSessionId === null) return undefined;
    return this.sessions.find((session) => session.id === this.activeSessionId);
  }

  private safeSessionId(requested?: string): string {
    if (requested && SESSION_ID.test(requested)) return requested;
    try {
      const generated = this.dependencies.id();
      if (SESSION_ID.test(generated)) return generated;
    } catch {
      // Fall through to a schema-valid local identifier.
    }
    return `session-${Date.now().toString(36)}`;
  }

  private safeNow(): string {
    try {
      const date = this.dependencies.now();
      if (Number.isFinite(date.getTime())) return date.toISOString();
    } catch {
      // Fall through to a schema-valid timestamp.
    }
    return new Date(0).toISOString();
  }

  private safeMonotonicNow(): number {
    try {
      const value = this.dependencies.monotonicNow();
      if (Number.isFinite(value)) return value;
    } catch {
      // Fall through.
    }
    return 0;
  }

  private ensureMinimalActiveSession(id: string): void {
    if (this.sessions.some((session) => session.id === id)) return;
    const timestamp = this.safeNow();
    this.sessions.push({
      schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
      id,
      startedAt: timestamp,
      updatedAt: timestamp,
      status: "active",
      app: { version: "", buildCommit: "" },
      environment: null,
      checkpoints: [{
        sequence: 0,
        type: "session-start",
        timestamp,
        elapsedMs: 0,
        details: {},
      }],
      droppedCheckpoints: 0,
    });
    this.activeSessionId = id;
    this.sortAndRetain();
  }

  private notify(): void {
    if (this.listeners.size === 0) return;
    try {
      this.dependencies.defer(() => {
        const snapshot = this.snapshot();
        for (const listener of [...this.listeners]) {
          try {
            listener(snapshot);
          } catch {
            // Subscriber failures are isolated.
          }
        }
      });
    } catch {
      // Deferred notification failures are isolated.
    }
  }

  private degradeFor(error: unknown): void {
    this.storageState = isQuotaError(error) ? "quota-exceeded" : "unavailable";
    this.storage = null;
  }
}

function ownData(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function safeShortText(value: unknown): string {
  return typeof value === "string"
    ? sanitizeSensitiveText(value).slice(0, 120)
    : "";
}

function safeApp(value: unknown): DiagnosticSession["app"] {
  return {
    version: safeShortText(ownData(value, "version")),
    buildCommit: safeShortText(ownData(value, "buildCommit")),
  };
}

function safePositiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function safeEnvironment(value: unknown): DiagnosticEnvironment {
  const capabilities = ownData(value, "capabilities");
  return {
    userAgent: sanitizeEnvironmentText(ownData(value, "userAgent")),
    platform: sanitizePlatformText(ownData(value, "platform")),
    deviceMemoryGiB: safePositiveNumber(ownData(value, "deviceMemoryGiB")),
    hardwareConcurrency: safePositiveNumber(ownData(value, "hardwareConcurrency")),
    capabilities: {
      webAssembly: ownData(capabilities, "webAssembly") === true,
      worker: ownData(capabilities, "worker") === true,
      offlineAudioContext: ownData(capabilities, "offlineAudioContext") === true,
      readableStream: ownData(capabilities, "readableStream") === true,
      responseBlob: ownData(capabilities, "responseBlob") === true,
      randomUUID: ownData(capabilities, "randomUUID") === true,
      localStorage: ownData(capabilities, "localStorage") === true,
      clipboard: ownData(capabilities, "clipboard") === true,
    },
  };
}

function firstTwo(value: unknown): unknown[] {
  try {
    if (!Array.isArray(value)) return [];
    const result: unknown[] = [];
    for (const index of ["0", "1"]) {
      const item = ownData(value, index);
      if (item !== undefined) result.push(item);
    }
    return result;
  } catch {
    return [];
  }
}

function safeBareMimeType(value: unknown): string | undefined {
  const mimeType = sanitizeBareMimeType(value);
  return mimeType === "" ? undefined : mimeType;
}

function safeInputDetails(value: unknown): Record<string, unknown> {
  const slot = ownData(value, "slot");
  const mimeType = ownData(value, "mimeType");
  const encodedBytes = ownData(value, "encodedBytes");
  return {
    slot: slot === "a" || slot === "b" ? slot : undefined,
    mimeType: safeBareMimeType(mimeType),
    encodedBytes: typeof encodedBytes === "number" &&
      Number.isFinite(encodedBytes) && encodedBytes >= 0
      ? encodedBytes
      : undefined,
  };
}

function minimalSession(
  id: string,
  timestamp: string,
  app: DiagnosticSession["app"],
): DiagnosticSession {
  return {
    schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
    id,
    startedAt: timestamp,
    updatedAt: timestamp,
    status: "active",
    app,
    environment: null,
    checkpoints: [{
      sequence: 0,
      type: "session-start",
      timestamp,
      elapsedMs: 0,
      details: {},
    }],
    droppedCheckpoints: 0,
  };
}

function compareSessions(left: DiagnosticSession, right: DiagnosticSession): number {
  return left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id);
}

function isTerminal(session: DiagnosticSession): boolean {
  return TERMINAL_STATUSES.has(session.status);
}

function hasNormalTerminalCheckpoint(session: DiagnosticSession): boolean {
  return session.checkpoints.some((checkpoint) => NORMAL_TERMINAL_CHECKPOINT_TYPES.has(checkpoint.type));
}

function isQuotaError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  try {
    return "name" in error && error.name === "QuotaExceededError";
  } catch {
    return false;
  }
}

function serializedBytes(session: DiagnosticSession): number {
  try {
    return encoder.encode(JSON.stringify(session)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function migrateMarker(raw: string | null): MarkerMigration {
  if (raw === null) return { kind: "none" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "corrupt" };
  }
  const schemaVersion = ownData(parsed, "schemaVersion");
  if (typeof schemaVersion === "number" && schemaVersion !== DIAGNOSTIC_SCHEMA_VERSION) {
    return { kind: "unsupported" };
  }
  const marker = parseActiveMarker(parsed);
  return marker ? { kind: "ok", marker } : { kind: "corrupt" };
}

function reconstructSession(session: DiagnosticSession): DiagnosticSession | null {
  const result = migrateDiagnosticStore({
    schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
    sessions: [session],
  });
  return result.kind === "ok" ? result.store.sessions[0] ?? null : null;
}

function cloneSessions(sessions: readonly DiagnosticSession[]): DiagnosticSession[] {
  try {
    const result = migrateDiagnosticStore({
      schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
      sessions: JSON.parse(JSON.stringify(sessions)),
    });
    return result.kind === "ok" ? result.store.sessions : [];
  } catch {
    return [];
  }
}
