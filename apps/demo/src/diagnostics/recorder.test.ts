import { describe, expect, it } from "vitest";

import {
  DIAGNOSTIC_ACTIVE_KEY,
  DIAGNOSTIC_SCHEMA_VERSION,
  DIAGNOSTIC_STORE_KEY,
  type ActiveSessionMarker,
  type DiagnosticEnvironment,
  type DiagnosticSession,
  type DiagnosticSessionStatus,
  type DiagnosticStore,
} from "./model";
import {
  DiagnosticRecorder,
  type RecorderDependencies,
  type StartSessionInput,
  type StorageLike,
} from "./recorder";

class FakeStorage implements StorageLike {
  readonly operations: string[] = [];
  readonly removedUnrelatedKeys: string[] = [];
  protected readonly values = new Map<string, string>();

  constructor(
    initial: Record<string, string> = {},
    private readonly failure?: {
      get?: "SecurityError" | "QuotaExceededError";
      set?: "SecurityError" | "QuotaExceededError";
      remove?: "SecurityError" | "QuotaExceededError";
    },
  ) {
    for (const [key, value] of Object.entries(initial)) this.values.set(key, value);
  }

  getItem(key: string): string | null {
    this.operations.push(`get:${key}`);
    if (this.failure?.get) throw domError(this.failure.get);
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.operations.push(`set:${key}`);
    if (this.failure?.set) throw domError(this.failure.set);
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.operations.push(`remove:${key}`);
    if (key !== DIAGNOSTIC_STORE_KEY && key !== DIAGNOSTIC_ACTIVE_KEY) {
      this.removedUnrelatedKeys.push(key);
    }
    if (this.failure?.remove) throw domError(this.failure.remove);
    this.values.delete(key);
  }
}

class SessionQuotaStorage extends FakeStorage {
  override setItem(key: string, value: string): void {
    this.operations.push(`set:${key}`);
    if (key === DIAGNOSTIC_STORE_KEY) {
      const candidate = JSON.parse(value) as DiagnosticStore;
      if (candidate.sessions.length > 1) throw domError("QuotaExceededError");
    }
    this.values.set(key, value);
  }
}

class ToggleQuotaStorage extends FakeStorage {
  quota = false;

  override setItem(key: string, value: string): void {
    this.operations.push(`set:${key}`);
    if (this.quota && key === DIAGNOSTIC_STORE_KEY) {
      const candidate = JSON.parse(value) as DiagnosticStore;
      if (candidate.sessions.length > 0) throw domError("QuotaExceededError");
    }
    this.values.set(key, value);
  }
}

describe("DiagnosticRecorder", () => {
  it("writes the retained session before its active marker", () => {
    const storage = new FakeStorage();
    const recorder = makeRecorder(storage);
    recorder.startSession(startInput());
    expect(storage.operations.slice(-2)).toEqual([
      `set:${DIAGNOSTIC_STORE_KEY}`,
      `set:${DIAGNOSTIC_ACTIVE_KEY}`,
    ]);
  });

  it("writes each active checkpoint before advancing its marker", () => {
    const storage = new FakeStorage();
    const recorder = makeRecorder(storage);
    recorder.startSession(startInput());
    recorder.checkpoint("worker-created", {});
    expect(storage.operations.slice(-2)).toEqual([
      `set:${DIAGNOSTIC_STORE_KEY}`,
      `set:${DIAGNOSTIC_ACTIVE_KEY}`,
    ]);
  });

  it("persists a terminal marker before deleting its active marker", () => {
    const storage = new FakeStorage();
    const recorder = makeRecorder(storage);
    recorder.startSession(startInput());
    recorder.finish("succeeded", "success", { outputFrames: 1 });
    expect(storage.operations.slice(-2)).toEqual([
      `set:${DIAGNOSTIC_STORE_KEY}`,
      `remove:${DIAGNOSTIC_ACTIVE_KEY}`,
    ]);
    expect(JSON.parse(storage.getItem(DIAGNOSTIC_STORE_KEY) ?? "{}"))
      .toMatchObject({ sessions: [expect.objectContaining({ status: "succeeded" })] });
  });

  it("rotates deterministically to six newest sessions", () => {
    const storage = new FakeStorage();
    const recorder = makeRecorder(storage);
    for (let index = 0; index < 8; index += 1) {
      recorder.startSession(startInput(`session-${index}`));
      recorder.finish("succeeded", "success", { outputFrames: index + 1 });
    }
    expect(recorder.snapshot().sessions.map((session) => session.id)).toEqual([
      "session-2",
      "session-3",
      "session-4",
      "session-5",
      "session-6",
      "session-7",
    ]);
  });

  it("bounds checkpoints and serialized session bytes", () => {
    const recorder = makeRecorder(new FakeStorage());
    recorder.startSession(startInput("bounded"));
    for (let index = 0; index < 200; index += 1) {
      recorder.checkpoint("error", {
        source: "processing",
        message: `message-${index}-${"x".repeat(500)}`,
      });
    }
    const [session] = recorder.snapshot().sessions;
    expect(session!.checkpoints.length).toBeLessThanOrEqual(96);
    expect(new TextEncoder().encode(JSON.stringify(session)).byteLength)
      .toBeLessThanOrEqual(32_768);
    expect(session!.checkpoints[0]?.type).toBe("session-start");
    expect(session!.checkpoints.at(-1)?.details.message).toContain("message-199");
    expect(session!.droppedCheckpoints).toBeGreaterThan(0);
  });

  it("records at most the two input slots even for oversized input arrays", () => {
    const input = startInput("bounded-inputs");
    input.inputs = Array.from({ length: 200 }, (_, index) => ({
      slot: index % 2 === 0 ? "a" as const : "b" as const,
      mimeType: "audio/wav",
      encodedBytes: index,
    }));
    const recorder = makeRecorder(new FakeStorage());
    recorder.startSession(input);
    expect(recorder.snapshot().sessions[0]?.checkpoints.filter(
      (checkpoint) => checkpoint.type === "input",
    )).toHaveLength(2);
  });

  it.each([
    ["corrupt JSON", "{not-json", "recovered-corruption"],
    [
      "invalid v1",
      JSON.stringify({ schemaVersion: 1, sessions: "bad" }),
      "recovered-corruption",
    ],
    [
      "unsupported schema",
      JSON.stringify({ schemaVersion: 99, sessions: [] }),
      "unsupported-schema",
    ],
  ])("recovers %s deterministically", (_label, raw, expectedState) => {
    const storage = new FakeStorage({ [DIAGNOSTIC_STORE_KEY]: raw });
    const recorder = makeRecorder(storage);
    expect(recorder.snapshot().storageState).toBe(expectedState);
    expect(recorder.snapshot().sessions).toEqual([]);
  });

  it("falls back to current-tab memory when storage access is disabled", () => {
    const recorder = makeRecorder(() => {
      throw new DOMException("disabled", "SecurityError");
    });
    expect(() => recorder.startSession(startInput("memory-only"))).not.toThrow();
    expect(recorder.snapshot().storageState).toBe("unavailable");
    expect(recorder.snapshot().sessions).toHaveLength(1);
  });

  it("prunes its own oldest terminal sessions before reporting quota exhaustion", () => {
    const storage = quotaStorageWithExistingSessions(3);
    const recorder = makeRecorder(storage);
    recorder.startSession(startInput("newest"));
    expect(storage.removedUnrelatedKeys).toEqual([]);
    expect(recorder.snapshot().storageState).toBe("available");
    expect(recorder.snapshot().sessions.map((session) => session.id)).toEqual(["newest"]);
  });

  it("degrades to memory-only if quota still fails after owned terminal pruning", () => {
    const recorder = makeRecorder(
      new FakeStorage({}, { set: "QuotaExceededError" }),
    );
    expect(() => recorder.startSession(startInput("memory-after-quota"))).not.toThrow();
    expect(recorder.snapshot()).toMatchObject({
      storageState: "quota-exceeded",
      activeSessionId: "memory-after-quota",
    });
  });

  it("keeps the just-finished session in memory when quota cannot retain it", () => {
    const storage = new ToggleQuotaStorage();
    const recorder = makeRecorder(storage);
    recorder.startSession(startInput("latest-terminal"));
    storage.quota = true;
    recorder.finish("succeeded", "success", { outputFrames: 1 });
    expect(recorder.snapshot()).toMatchObject({
      storageState: "quota-exceeded",
      sessions: [expect.objectContaining({
        id: "latest-terminal",
        status: "succeeded",
      })],
    });
  });

  it("infers unexpected termination only for a nonterminal active marker", () => {
    const storage = seedActiveSession({ status: "active", terminal: false });
    const recorder = makeRecorder(storage);
    expect(recorder.snapshot().recoveredSessionId).toBe("unfinished");
    expect(recorder.snapshot().sessions[0]).toMatchObject({
      status: "unexpected-termination",
      inference: {
        kind: "unexpected-termination",
        markerOnly: false,
      },
    });
    expect(recorder.snapshot().sessions[0]?.inference?.statement.toLowerCase())
      .toContain("does not establish out-of-memory or any exact cause");
    expect(storage.getItem(DIAGNOSTIC_ACTIVE_KEY)).toBeNull();
  });

  it.each(["succeeded", "failed", "cancelled", "clean-shutdown"] as const)(
    "does not infer termination after %s",
    (status) => {
      const recorder = makeRecorder(seedActiveSession({ status, terminal: true }));
      expect(recorder.snapshot().sessions[0]?.status).toBe(status);
      expect(recorder.snapshot().recoveredSessionId).toBeNull();
    },
  );

  it("creates an explicitly limited marker-only inference after ring corruption", () => {
    const recorder = makeRecorder(seedMarkerWithCorruptRing());
    expect(recorder.snapshot().sessions[0]).toMatchObject({
      status: "unexpected-termination",
      inference: { markerOnly: true },
    });
    expect(recorder.snapshot().sessions[0]?.inference?.statement.toLowerCase())
      .toContain("does not establish out-of-memory or any exact cause");
  });

  it("coalesces repeated progress fractions to one persisted stage transition", () => {
    const storage = new FakeStorage();
    const recorder = makeRecorder(storage);
    recorder.startSession(startInput("progress"));
    recorder.recordProgress({ stage: "convolve", fraction: 0.3 });
    recorder.recordProgress({ stage: "convolve", fraction: 0.4 });
    recorder.recordProgress({ stage: "convolve", fraction: 0.9 });
    recorder.recordProgress({ stage: "normalize", fraction: 0.95 });
    const progress = recorder.snapshot().sessions[0]?.checkpoints.filter(
      (checkpoint) => checkpoint.type === "progress-stage",
    );
    expect(progress?.map((checkpoint) => checkpoint.details.stage)).toEqual([
      "convolve",
      "normalize",
    ]);
    expect(storage.operations.filter(
      (operation) => operation === `set:${DIAGNOSTIC_STORE_KEY}`,
    )).toHaveLength(3);
  });

  it("exports only validated schema-v1 data in a stable formatted envelope", () => {
    const recorder = makeRecorder(new FakeStorage());
    recorder.startSession(startInput("exported"));
    recorder.finish("succeeded", "success", { outputFrames: 42 });
    const json = recorder.exportJson();
    expect(json.endsWith("\n")).toBe(true);
    expect(JSON.parse(json)).toMatchObject({
      exportFormat: "convolve-wasm-diagnostics",
      exportVersion: 1,
      privacy: {
        audioDataRecorded: false,
        fileNamesRecorded: false,
        automaticUpload: false,
      },
      limits: {
        retainedSessions: 6,
        sessionBytes: 32_768,
        checkpointsPerSession: 96,
      },
      sessions: [expect.objectContaining({ id: "exported", status: "succeeded" })],
    });
  });

  it("clears only recorder keys", () => {
    const storage = new FakeStorage({ unrelated: "keep" });
    const recorder = makeRecorder(storage);
    recorder.startSession(startInput("clear"));
    recorder.clear();
    expect(storage.getItem(DIAGNOSTIC_STORE_KEY)).toBeNull();
    expect(storage.getItem(DIAGNOSTIC_ACTIVE_KEY)).toBeNull();
    expect(storage.getItem("unrelated")).toBe("keep");
    expect(recorder.snapshot().sessions).toEqual([]);
  });

  it("allows a subsequent successful operation after every diagnostic write fails", () => {
    const recorder = makeRecorder(alwaysThrowingStorage());
    expect(() => {
      recorder.startSession(startInput("failure-isolated"));
      recorder.checkpoint("worker-created", {});
      recorder.finish("succeeded", "success", { outputFrames: 1 });
    }).not.toThrow();
    expect(recorder.snapshot().sessions.at(-1)?.status).toBe("succeeded");
  });

  it("isolates throwing subscribers and deferred notifications", () => {
    const recorder = makeRecorder(new FakeStorage(), {
      defer(task) {
        task();
        throw new Error("defer failed after running");
      },
    });
    recorder.subscribe(() => {
      throw new Error("listener failed");
    });
    expect(() => recorder.startSession(startInput("listener-isolated"))).not.toThrow();
    expect(recorder.snapshot().activeSessionId).toBe("listener-isolated");
  });
});

function domError(name: "SecurityError" | "QuotaExceededError"): DOMException {
  return new DOMException(name, name);
}

function makeRecorder(
  storage: StorageLike | (() => StorageLike | null),
  overrides: Partial<RecorderDependencies> = {},
): DiagnosticRecorder {
  let wallTime = Date.parse("2026-07-23T20:00:00.000Z");
  let monotonic = 0;
  return new DiagnosticRecorder({
    getStorage: typeof storage === "function" ? storage : () => storage,
    now: () => new Date(wallTime++),
    monotonicNow: () => monotonic++,
    id: () => "generated-id",
    defer: (task) => task(),
    ...overrides,
  });
}

function startInput(id = "session-1"): StartSessionInput {
  return {
    id,
    app: { version: "0.1.0", buildCommit: "commit-1" },
    environment: validEnvironment(),
    inputs: [
      { slot: "a", mimeType: "audio/wav", encodedBytes: 1024 },
      { slot: "b", mimeType: "audio/wav", encodedBytes: 2048 },
    ],
    options: {
      appendReverse: false,
      beatPan: null,
      panTransitionMs: 8,
      reverseCrossfadeMs: 10,
      targetDbtp: -1,
    },
  };
}

function validEnvironment(): DiagnosticEnvironment {
  return {
    userAgent: "Test Browser",
    platform: "Test Platform",
    deviceMemoryGiB: 4,
    hardwareConcurrency: 8,
    capabilities: {
      webAssembly: true,
      worker: true,
      offlineAudioContext: true,
      readableStream: true,
      responseBlob: true,
      randomUUID: true,
      localStorage: true,
      clipboard: false,
    },
  };
}

function terminalSession(
  id: string,
  status: Exclude<DiagnosticSessionStatus, "active" | "unexpected-termination"> = "succeeded",
  offset = 0,
): DiagnosticSession {
  const timestamp = new Date(Date.parse("2026-07-23T19:00:00.000Z") + offset).toISOString();
  return {
    schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
    id,
    startedAt: timestamp,
    updatedAt: timestamp,
    status,
    app: { version: "0.1.0", buildCommit: "commit-1" },
    environment: validEnvironment(),
    checkpoints: [{
      sequence: 0,
      type: "session-start",
      timestamp,
      elapsedMs: 0,
      details: {
        appVersion: "0.1.0",
        buildCommit: "commit-1",
        diagnosticSchemaVersion: 1,
      },
    }],
    droppedCheckpoints: 0,
  };
}

function activeMarker(id = "unfinished"): ActiveSessionMarker {
  return {
    schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
    sessionId: id,
    startedAt: "2026-07-23T19:00:00.000Z",
    updatedAt: "2026-07-23T19:00:01.000Z",
    lastCheckpointSequence: 0,
    appVersion: "0.1.0",
    buildCommit: "commit-1",
  };
}

function seedActiveSession(input: {
  status: DiagnosticSessionStatus;
  terminal: boolean;
}): FakeStorage {
  const session = terminalSession(
    "unfinished",
    input.status === "active" || input.status === "unexpected-termination"
      ? "succeeded"
      : input.status,
  );
  session.status = input.status;
  return new FakeStorage({
    [DIAGNOSTIC_STORE_KEY]: JSON.stringify({
      schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
      sessions: [session],
    }),
    [DIAGNOSTIC_ACTIVE_KEY]: JSON.stringify(activeMarker()),
  });
}

function seedMarkerWithCorruptRing(): FakeStorage {
  return new FakeStorage({
    [DIAGNOSTIC_STORE_KEY]: "{not-json",
    [DIAGNOSTIC_ACTIVE_KEY]: JSON.stringify(activeMarker()),
  });
}

function quotaStorageWithExistingSessions(count: number): SessionQuotaStorage {
  const sessions = Array.from(
    { length: count },
    (_, index) => terminalSession(`old-${index}`, "succeeded", index),
  );
  return new SessionQuotaStorage({
    [DIAGNOSTIC_STORE_KEY]: JSON.stringify({
      schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
      sessions,
    }),
    unrelated: "keep",
  });
}

function alwaysThrowingStorage(): FakeStorage {
  return new FakeStorage({}, {
    set: "SecurityError",
    remove: "SecurityError",
  });
}
