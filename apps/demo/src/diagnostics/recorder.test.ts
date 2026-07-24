import { describe, expect, it } from "vitest";

import {
  DIAGNOSTIC_ACTIVE_KEY,
  DIAGNOSTIC_SCHEMA_VERSION,
  DIAGNOSTIC_STORE_KEY,
  type ActiveSessionMarker,
  type DiagnosticCheckpointType,
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
class ToggleFailureStorage extends FakeStorage {
  setFailure: "SecurityError" | "QuotaExceededError" | null = null;

  constructor() {
    super({ unrelated: "keep" });
  }

  override setItem(key: string, value: string): void {
    this.operations.push(`set:${key}`);
    if (this.setFailure) throw domError(this.setFailure);
    this.values.set(key, value);
  }
}

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

  it("appends an incident to an active session and advances its marker", () => {
    const storage = new FakeStorage();
    const recorder = makeRecorder(storage);
    recorder.startSession(startInput("active-incident"));
    const operationBoundary = storage.operations.length;

    recorder.recordIncident("visibility", { state: "hidden" });

    expect(recorder.snapshot()).toMatchObject({
      activeSessionId: "active-incident",
      sessions: [expect.objectContaining({
        id: "active-incident",
        status: "active",
        checkpoints: expect.arrayContaining([
          expect.objectContaining({
            type: "visibility",
            details: { state: "hidden" },
          }),
        ]),
      })],
    });
    expect(storage.operations.slice(operationBoundary)).toEqual([
      `set:${DIAGNOSTIC_STORE_KEY}`,
      `set:${DIAGNOSTIC_ACTIVE_KEY}`,
    ]);
    expect(storage.getItem(DIAGNOSTIC_ACTIVE_KEY)).not.toBeNull();
  });
  it("appends a late incident to the latest terminal session without reopening it", () => {
    const storage = new FakeStorage();
    const recorder = makeRecorder(storage);
    recorder.startSession(startInput("late-incident"));
    recorder.finish("succeeded", "success", { outputFrames: 1 });
    const operationBoundary = storage.operations.length;

    recorder.recordIncident("audio-error", {
      error: {
        source: "audio",
        code: "MEDIA_ERR_DECODE",
        message: "preview decode failed",
      },
    });

    const [session] = recorder.snapshot().sessions;
    expect(session).toMatchObject({
      id: "late-incident",
      status: "succeeded",
    });
    expect(session?.checkpoints.at(-1)).toMatchObject({
      type: "audio-error",
      details: {
        source: "audio",
        code: "MEDIA_ERR_DECODE",
        message: "preview decode failed",
      },
    });
    expect(storage.operations.slice(operationBoundary)).toEqual([
      `set:${DIAGNOSTIC_STORE_KEY}`,
    ]);
    expect(storage.getItem(DIAGNOSTIC_ACTIVE_KEY)).toBeNull();
    expect(JSON.parse(storage.getItem(DIAGNOSTIC_STORE_KEY) ?? "{}"))
      .toMatchObject({
        sessions: [expect.objectContaining({
          id: "late-incident",
          status: "succeeded",
          checkpoints: expect.arrayContaining([
            expect.objectContaining({ type: "audio-error" }),
          ]),
        })],
      });
    expect(JSON.parse(recorder.exportJson())).toMatchObject({
      sessions: [expect.objectContaining({
        id: "late-incident",
        status: "succeeded",
      })],
    });
  });

  it("creates a failed incident-only session without an active marker when idle", () => {
    const storage = new FakeStorage();
    const recorder = makeRecorder(storage);

    recorder.recordIncident(
      "error",
      { source: "window", message: "idle failure" },
      {
        app: { version: "0.1.0", buildCommit: "incident-build" },
        environment: validEnvironment(),
      },
    );

    const snapshot = recorder.snapshot();
    expect(snapshot.activeSessionId).toBeNull();
    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.sessions[0]).toMatchObject({
      status: "failed",
      app: { version: "0.1.0", buildCommit: "incident-build" },
      environment: validEnvironment(),
      checkpoints: [
        expect.objectContaining({ type: "session-start" }),
        expect.objectContaining({
          type: "error",
          details: {
            source: "window",
            message: "idle failure",
          },
        }),
      ],
    });
    expect(storage.getItem(DIAGNOSTIC_ACTIVE_KEY)).toBeNull();
    expect(JSON.parse(storage.getItem(DIAGNOSTIC_STORE_KEY) ?? "{}"))
      .toMatchObject({
        sessions: [expect.objectContaining({ status: "failed" })],
      });
    expect(JSON.parse(recorder.exportJson())).toMatchObject({
      sessions: [expect.objectContaining({ status: "failed" })],
    });
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

  it("never persists caller-owned or sensitive runtime input data", () => {
    const storage = new FakeStorage();
    const recorder = makeRecorder(storage);
    const privateSentinels = [
      "PRIVATE_UNKNOWN_FIELD",
      "PRIVATE_STACK",
      "PRIVATE_BINARY",
      "PRIVATE_FILE_NAME",
      "PRIVATE_BARE_NAME.wav",
      "PRIVATE_PATH_SEGMENT",
      "PRIVATE_URL_SEGMENT",
      "PRIVATE_AUDIO_SAMPLE",
      "PRIVATE_ACCESSOR",
    ];
    const throwingUnknown = Object.defineProperty({}, "private", {
      enumerable: true,
      get() {
        throw new Error("PRIVATE_ACCESSOR");
      },
    });
    const runtimeInput = {
      id: "private-safe",
      app: {
        version: "file:///PRIVATE_PATH_SEGMENT/private.wav",
        buildCommit: 42,
        unknown: "PRIVATE_UNKNOWN_FIELD",
      },
      environment: {
        userAgent: "https://example.test/PRIVATE_URL_SEGMENT/private.wav",
        platform: "C:\\PRIVATE_PATH_SEGMENT\\private.wav",
        deviceMemoryGiB: -1,
        hardwareConcurrency: Number.NaN,
        capabilities: {
          webAssembly: "yes",
          worker: true,
          offlineAudioContext: false,
          readableStream: true,
          responseBlob: true,
          randomUUID: true,
          localStorage: true,
          clipboard: false,
          unknown: "PRIVATE_UNKNOWN_FIELD",
        },
        fileName: "PRIVATE_FILE_NAME.wav",
        stack: "PRIVATE_STACK",
        samples: new Float32Array([0.123456]),
        bytes: new TextEncoder().encode("PRIVATE_BINARY"),
        audioData: { sample: "PRIVATE_AUDIO_SAMPLE" },
        throwingUnknown,
      },
      inputs: [{
        slot: "bad",
        mimeType: "audio/private; name=PRIVATE_FILE_NAME.wav",
        encodedBytes: -1,
        fileName: "PRIVATE_FILE_NAME.wav",
        bytes: new TextEncoder().encode("PRIVATE_BINARY"),
      }, {
        slot: "b",
        mimeType: "audio/PRIVATE_BARE_NAME.wav",
        encodedBytes: 1,
      }],
      options: {
        appendReverse: "yes",
        beatPan: "private",
        panTransitionMs: -1,
        reverseCrossfadeMs: -1,
        targetDbtp: Number.NaN,
        stack: "PRIVATE_STACK",
      },
      unknown: "PRIVATE_UNKNOWN_FIELD",
    } as unknown as StartSessionInput;

    expect(() => recorder.startSession(runtimeInput)).not.toThrow();
    expect(() => recorder.checkpoint("error", {
      source: "processing",
      message: "C:\\PRIVATE_PATH_SEGMENT\\PRIVATE_FILE_NAME.wav",
      stack: "PRIVATE_STACK",
      bytes: new TextEncoder().encode("PRIVATE_BINARY"),
    })).not.toThrow();

    const raw = storage.getItem(DIAGNOSTIC_STORE_KEY) ?? "";
    const exported = recorder.exportJson();
    for (const sentinel of privateSentinels) {
      expect(raw).not.toContain(sentinel);
      expect(exported).not.toContain(sentinel);
    }
    const stored = JSON.parse(raw) as DiagnosticStore;
    const [session] = stored.sessions;
    expect(session?.environment).toMatchObject({
      deviceMemoryGiB: null,
      hardwareConcurrency: null,
      capabilities: { webAssembly: false, worker: true },
    });
    expect(session?.checkpoints.length).toBeLessThanOrEqual(96);
    expect(new TextEncoder().encode(JSON.stringify(session)).byteLength)
      .toBeLessThanOrEqual(32_768);
  });

  it("preserves realistic browser environment tokens in storage and export", () => {
    const storage = new FakeStorage();
    const recorder = makeRecorder(storage);
    const input = startInput("android-environment");
    const userAgent = "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro Build/UQ1A.240105.004) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";
    input.environment = {
      ...validEnvironment(),
      userAgent,
      platform: "Linux armv8l home/private/PRIVATE_PLATFORM_PATH.txt",
    };

    recorder.startSession(input);

    const raw = storage.getItem(DIAGNOSTIC_STORE_KEY) ?? "";
    const stored = JSON.parse(raw) as DiagnosticStore;
    const [session] = stored.sessions;
    expect(session?.environment?.userAgent).toBe(userAgent);
    expect(session?.environment?.platform).toContain("Linux armv8l");
    expect(session?.environment?.platform).not.toContain("PRIVATE_PLATFORM_PATH");
    expect(session?.checkpoints[0]?.details.userAgent).toBe(userAgent);
    const exported = recorder.exportJson();
    expect(exported).toContain("Mozilla/5.0");
    expect(exported).toContain("Chrome/126.0.0.0");
    expect(exported).not.toContain("PRIVATE_PLATFORM_PATH");
  });
  it.each(["audio/wav", "audio/x-wav", "audio/mp4", "audio/m4a"])(
    "retains legitimate bare MIME type %s",
    (mimeType) => {
      const recorder = makeRecorder(new FakeStorage());
      const input = startInput(`mime-${mimeType.replaceAll("/", "-")}`);
      input.inputs = [{ slot: "a", mimeType, encodedBytes: 1 }];
      recorder.startSession(input);
      expect(recorder.snapshot().sessions[0]?.checkpoints.find(
        (checkpoint) => checkpoint.type === "input",
      )?.details.mimeType).toBe(mimeType);
    },
  );

  it.each(["audio/private-recording.mp3", "audio/private-recording.flac", "audio/private-recording.7z"])(
    "does not retain filename-shaped MIME essence %s in storage or export",
    (mimeType) => {
      const storage = new FakeStorage();
      const recorder = makeRecorder(storage);
      const input = startInput("bare-mime-privacy");
      input.inputs = [{ slot: "a", mimeType, encodedBytes: 1 }];
      recorder.startSession(input);
      const raw = storage.getItem(DIAGNOSTIC_STORE_KEY) ?? "";
      const exported = recorder.exportJson();
      expect(raw).not.toContain("private-recording");
      expect(exported).not.toContain("private-recording");
    },
  );

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
    const storage = new FakeStorage({
      [DIAGNOSTIC_STORE_KEY]: raw,
      [DIAGNOSTIC_ACTIVE_KEY]: "{bad-marker",
      unrelated: "keep",
    });
    const recorder = makeRecorder(storage);
    expect(recorder.snapshot().storageState).toBe(expectedState);
    expect(recorder.snapshot().sessions).toEqual([]);
    expect(storage.getItem(DIAGNOSTIC_STORE_KEY)).toBeNull();
    expect(storage.getItem(DIAGNOSTIC_ACTIVE_KEY)).toBeNull();
    expect(storage.getItem("unrelated")).toBe("keep");
    expect(storage.operations).toContain(`remove:${DIAGNOSTIC_STORE_KEY}`);
    expect(storage.operations).toContain(`remove:${DIAGNOSTIC_ACTIVE_KEY}`);
  });

  it("attempts both recorder-key resets and preserves corruption state when removal fails", () => {
    const storage = new FakeStorage({
      [DIAGNOSTIC_STORE_KEY]: "{not-json",
      [DIAGNOSTIC_ACTIVE_KEY]: "{bad-marker",
      unrelated: "keep",
    }, { remove: "SecurityError" });
    const recorder = makeRecorder(storage);
    expect(recorder.snapshot().storageState).toBe("recovered-corruption");
    expect(storage.operations.filter((operation) => operation.startsWith("remove:"))).toEqual([
      `remove:${DIAGNOSTIC_STORE_KEY}`,
      `remove:${DIAGNOSTIC_ACTIVE_KEY}`,
    ]);
    recorder.startSession(startInput("memory-after-reset-failure"));
    expect(storage.getItem(DIAGNOSTIC_STORE_KEY)).toBe("{not-json");
    expect(storage.getItem("unrelated")).toBe("keep");
    expect(recorder.snapshot().storageState).toBe("recovered-corruption");
  });

  it("does not infer from a valid v1 marker paired with an unsupported ring", () => {
    const storage = new FakeStorage({
      [DIAGNOSTIC_STORE_KEY]: JSON.stringify({ schemaVersion: 99, sessions: [] }),
      [DIAGNOSTIC_ACTIVE_KEY]: JSON.stringify(activeMarker()),
    });
    const recorder = makeRecorder(storage);
    expect(recorder.snapshot()).toMatchObject({
      storageState: "unsupported-schema",
      sessions: [],
      recoveredSessionId: null,
    });
    expect(storage.getItem(DIAGNOSTIC_STORE_KEY)).toBeNull();
    expect(storage.getItem(DIAGNOSTIC_ACTIVE_KEY)).toBeNull();
  });

  it.each([
    ["corrupt", "{not-json", "recovered-corruption"],
    [
      "unsupported",
      JSON.stringify({ schemaVersion: 99, sessionId: "future" }),
      "unsupported-schema",
    ],
  ])("classifies and removes a %s active marker", (_label, rawMarker, expectedState) => {
    const initialStore = JSON.stringify({
      schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
      sessions: [],
    });
    const storage = new FakeStorage({
      [DIAGNOSTIC_STORE_KEY]: initialStore,
      [DIAGNOSTIC_ACTIVE_KEY]: rawMarker,
    });
    const recorder = makeRecorder(storage);
    expect(recorder.snapshot().storageState).toBe(expectedState);
    expect(storage.getItem(DIAGNOSTIC_STORE_KEY)).toBe(initialStore);
    expect(storage.getItem(DIAGNOSTIC_ACTIVE_KEY)).toBeNull();
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

  it("keeps the updated terminal incident in memory when quota rejects it", () => {
    const storage = new ToggleQuotaStorage();
    const recorder = makeRecorder(storage);
    recorder.startSession(startInput("late-incident-quota"));
    recorder.finish("succeeded", "success", { outputFrames: 1 });
    storage.quota = true;

    recorder.recordIncident("audio-error", {
      error: { source: "audio", code: "MEDIA_ERR_DECODE" },
    });

    expect(recorder.snapshot()).toMatchObject({
      storageState: "quota-exceeded",
      sessions: [expect.objectContaining({
        id: "late-incident-quota",
        status: "succeeded",
        checkpoints: expect.arrayContaining([
          expect.objectContaining({ type: "audio-error" }),
        ]),
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
    expect(recorder.snapshot().sessions[0]?.checkpoints.some(
      (checkpoint) => isTerminalCheckpoint(checkpoint.type),
    )).toBe(false);
    expect(storage.getItem(DIAGNOSTIC_ACTIVE_KEY)).toBeNull();
  });

  it.each(["succeeded", "failed", "cancelled", "clean-shutdown"] as const)(
    "does not infer termination after %s",
    (status) => {
      const recorder = makeRecorder(seedActiveSession({ status, terminal: true }));
      expect(recorder.snapshot().sessions[0]?.status).toBe(status);
      expect(recorder.snapshot().recoveredSessionId).toBeNull();
      expect(recorder.snapshot().sessions[0]?.checkpoints.some(
        (checkpoint) => isTerminalCheckpoint(checkpoint.type),
      )).toBe(true);
    },
  );

  it.each(["success", "cancelled", "clean-shutdown"] as const)(
    "does not infer termination for an active session with explicit %s boundary",
    (type) => {
      const storage = seedActiveSession({ status: "active", terminal: false });
      const raw = JSON.parse(storage.getItem(DIAGNOSTIC_STORE_KEY) ?? "{}") as DiagnosticStore;
      raw.sessions[0]!.checkpoints.push({
        sequence: 1, type, timestamp: raw.sessions[0]!.updatedAt, elapsedMs: 1, details: {},
      });
      storage.setItem(DIAGNOSTIC_STORE_KEY, JSON.stringify(raw));
      const recorder = makeRecorder(storage);
      expect(recorder.snapshot().sessions[0]?.status).toBe("active");
      expect(recorder.snapshot().recoveredSessionId).toBeNull();
      expect(storage.getItem(DIAGNOSTIC_ACTIVE_KEY)).toBeNull();
    },
  );

  it.each(["window", "promise"] as const)(
    "recovers an active session with only session-start and incidental %s error",
    (errorSource) => {
      const storage = seedActiveSession({ status: "active", terminal: false });
      const raw = JSON.parse(storage.getItem(DIAGNOSTIC_STORE_KEY) ?? "{}") as DiagnosticStore;
      raw.sessions[0]!.checkpoints.push({
        sequence: 1, type: "error", timestamp: raw.sessions[0]!.updatedAt,
        elapsedMs: 1, details: { source: errorSource },
      });
      expect(raw.sessions[0]!.checkpoints.map((checkpoint) => checkpoint.type)).toEqual([
        "session-start", "error",
      ]);
      storage.setItem(DIAGNOSTIC_STORE_KEY, JSON.stringify(raw));
      const recorder = makeRecorder(storage);
      expect(recorder.snapshot()).toMatchObject({ recoveredSessionId: "unfinished" });
      expect(recorder.snapshot().sessions[0]).toMatchObject({
        status: "unexpected-termination", inference: { markerOnly: false },
      });
    },
  );

  it("creates an explicitly limited marker-only inference after ring corruption", () => {
    const storage = seedMarkerWithCorruptRing();
    const recorder = makeRecorder(storage);
    expect(recorder.snapshot().sessions[0]).toMatchObject({
      status: "unexpected-termination",
      inference: { markerOnly: true },
    });
    expect(recorder.snapshot().sessions[0]?.inference?.statement.toLowerCase())
      .toContain("detailed checkpoints were unavailable");
    expect(storage.operations.slice(-3)).toEqual([
      `remove:${DIAGNOSTIC_STORE_KEY}`,
      `set:${DIAGNOSTIC_STORE_KEY}`,
      `remove:${DIAGNOSTIC_ACTIVE_KEY}`,
    ]);
  });

  it("retains a marker-only recovered subject when the ring already has six sessions", () => {
    const sessions = Array.from(
      { length: 6 },
      (_, index) => terminalSession(`retained-${index}`, "succeeded", index + 1_000),
    );
    const storage = new FakeStorage({
      [DIAGNOSTIC_STORE_KEY]: JSON.stringify({
        schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
        sessions,
      }),
      [DIAGNOSTIC_ACTIVE_KEY]: JSON.stringify(activeMarker("marker-only")),
    });
    const recorder = makeRecorder(storage);
    expect(recorder.snapshot().recoveredSessionId).toBe("marker-only");
    expect(recorder.snapshot().sessions).toHaveLength(6);
    expect(recorder.snapshot().sessions.map((session) => session.id))
      .toContain("marker-only");
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

  it.each(["QuotaExceededError", "SecurityError"] as const)(
    "reacquires storage and clears both owned keys after transient %s degradation",
    (failure) => {
      const storage = new ToggleFailureStorage();
      const recorder = makeRecorder(() => storage);
      recorder.startSession(startInput("clear-after-degradation"));
      storage.setFailure = failure;
      recorder.checkpoint("worker-created", {});
      storage.setFailure = null;
      expect(() => recorder.clear()).not.toThrow();
      expect(storage.getItem(DIAGNOSTIC_STORE_KEY)).toBeNull();
      expect(storage.getItem(DIAGNOSTIC_ACTIVE_KEY)).toBeNull();
      expect(storage.getItem("unrelated")).toBe("keep");
      const reloaded = makeRecorder(() => storage);
      reloaded.startSession(startInput("after-clear"));
      expect(reloaded.snapshot().activeSessionId).toBe("after-clear");
    },
  );

  it("allows a subsequent successful operation after every diagnostic write fails", () => {
    const recorder = makeRecorder(alwaysThrowingStorage());
    expect(() => {
      recorder.startSession(startInput("failure-isolated"));
      recorder.checkpoint("worker-created", {});
      recorder.finish("succeeded", "success", { outputFrames: 1 });
    }).not.toThrow();
    expect(recorder.snapshot().sessions.at(-1)?.status).toBe("succeeded");
  });

  it("isolates throwing runtime accessors and allows a subsequent normal operation", () => {
    const recorder = makeRecorder(new FakeStorage());
    const throwingInput = new Proxy({}, {
      get() {
        throw new Error("input getter");
      },
      getOwnPropertyDescriptor() {
        throw new Error("input descriptor");
      },
    }) as StartSessionInput;
    const throwingDetails = new Proxy({}, {
      get() {
        throw new Error("details getter");
      },
      getOwnPropertyDescriptor() {
        throw new Error("details descriptor");
      },
    });
    expect(() => recorder.startSession(throwingInput)).not.toThrow();
    expect(() => recorder.checkpoint("error", throwingDetails)).not.toThrow();
    expect(() => recorder.recordIncident("worker-error", throwingDetails)).not.toThrow();
    expect(() => recorder.recordProgress(throwingDetails as never)).not.toThrow();

    expect(() => {
      recorder.startSession(startInput("after-throwing-input"));
      recorder.finish("succeeded", "success", { outputFrames: 1 });
    }).not.toThrow();
    expect(recorder.snapshot().sessions.at(-1)).toMatchObject({
      id: "after-throwing-input",
      status: "succeeded",
    });
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
  if (input.terminal) {
    const type = terminalCheckpointType(input.status);
    session.checkpoints.push({
      sequence: 1,
      type,
      timestamp: session.updatedAt,
      elapsedMs: 1,
      details: type === "error" ? { source: "processing" } : {},
    });
  }
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

function terminalCheckpointType(status: DiagnosticSessionStatus): DiagnosticCheckpointType {
  switch (status) {
    case "failed": return "error";
    case "cancelled": return "cancelled";
    case "active": return "clean-shutdown";
    case "clean-shutdown": return "clean-shutdown";
    case "unexpected-termination": return "unexpected-termination";
    case "succeeded": return "success";
  }
}

function isTerminalCheckpoint(type: DiagnosticCheckpointType): boolean {
  return type === "success" || type === "error" || type === "cancelled" ||
    type === "clean-shutdown";
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
