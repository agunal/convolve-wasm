import { describe, expect, it, vi } from "vitest";
import type { ConvolveMetadata } from "@takana-labs/convolve-wasm";

import {
  createBrowserDiagnostics,
  type BrowserDiagnosticRecorder,
  type BrowserDiagnosticsDependencies,
} from "./browser";
import {
  DIAGNOSTIC_ACTIVE_KEY,
  DIAGNOSTIC_STORE_KEY,
  type DiagnosticStore,
} from "./model";
import {
  DiagnosticRecorder,
  type DiagnosticSnapshot,
  type RecorderDependencies,
  type StorageLike,
} from "./recorder";

class BrowserStorage implements StorageLike {
  readonly values = new Map<string, string>();
  failWrites = false;

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) throw new DOMException("blocked", "SecurityError");
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

class FakeElement extends EventTarget {
  hidden = false;
  textContent: string | null = "";
}

class FakeAnchor extends FakeElement {
  href = "";
  download = "";
  click = vi.fn();
  remove = vi.fn();
}

function emptySnapshot(): DiagnosticSnapshot {
  return {
    storageState: "available",
    sessions: [],
    activeSessionId: null,
    recoveredSessionId: null,
  };
}

function fakeRecorder(
  snapshot: DiagnosticSnapshot = emptySnapshot(),
) {
  return {
    startSession: vi.fn(),
    checkpoint: vi.fn(),
    recordProgress: vi.fn(),
    finish: vi.fn(),
    recordIncident: vi.fn(),
    snapshot: vi.fn(() => snapshot),
    subscribe: vi.fn((listener: (value: DiagnosticSnapshot) => void) => {
      listener(snapshot);
      return vi.fn();
    }),
    exportJson: vi.fn(() => '{\n  "safe": true\n}\n'),
    clear: vi.fn(),
  };
}

function validAttempt() {
  return {
    inputs: [
      { slot: "a" as const, mimeType: "audio/wav", encodedBytes: 44 },
      { slot: "b" as const, mimeType: "audio/mp4", encodedBytes: 88 },
    ],
    options: {
      appendReverse: false,
      beatPan: null,
      panTransitionMs: 20,
      reverseCrossfadeMs: 5,
      targetDbtp: -1,
    },
  };
}

function browserDependencies(
  recorder: BrowserDiagnosticRecorder = fakeRecorder(),
): BrowserDiagnosticsDependencies & {
  windowTarget: EventTarget;
  documentTarget: EventTarget & { visibilityState: DocumentVisibilityState };
  previewTarget: EventTarget & { error: unknown };
  anchor: FakeAnchor;
  ui: {
    storage: FakeElement;
    recovered: FakeElement;
    summary: FakeElement;
    download: FakeElement;
    copy: FakeElement;
    clear: FakeElement;
    failureDownload: FakeElement;
  };
} {
  const anchor = new FakeAnchor();
  const ui = {
    storage: new FakeElement(),
    recovered: new FakeElement(),
    summary: new FakeElement(),
    download: new FakeElement(),
    copy: new FakeElement(),
    clear: new FakeElement(),
    failureDownload: new FakeElement(),
  };
  return {
    recorder,
    windowTarget: new EventTarget(),
    documentTarget: Object.assign(new EventTarget(), {
      visibilityState: "visible" as DocumentVisibilityState,
    }),
    previewTarget: Object.assign(new EventTarget(), { error: null as unknown }),
    app: { version: "0.1.0", buildCommit: "test-build" },
    environment: {
      userAgent: "Test Browser",
      platform: "Test OS",
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
        clipboard: true,
      },
    },
    clipboardWrite: vi.fn(async () => undefined),
    createJsonBlob: vi.fn(() => new Blob()),
    createObjectUrl: vi.fn(() => "blob:diagnostics"),
    revokeObjectUrl: vi.fn(),
    createDownloadAnchor: vi.fn(() => anchor),
    attachDownloadAnchor: vi.fn(),
    confirmClear: vi.fn(() => true),
    defer: vi.fn((task: () => void) => task()),
    ui,
    anchor,
  };
}

function actualRecorder(
  storage: BrowserStorage,
  overrides: Partial<RecorderDependencies> = {},
): DiagnosticRecorder {
  let wallTime = Date.parse("2026-07-23T20:00:00.000Z");
  let monotonic = 0;
  return new DiagnosticRecorder({
    getStorage: () => storage,
    now: () => new Date(wallTime++),
    monotonicNow: () => monotonic++,
    id: () => `browser-${wallTime}`,
    defer: (task) => task(),
    ...overrides,
  });
}

function validMetadata(): ConvolveMetadata {
  return {
    sampleRate: 48_000,
    channels: 2,
    durationSeconds: 1,
    outputFrames: 48_000,
    detectedBeats: 1,
    detectedBpm: 120,
    beatConfidence: 0.9,
    appliedGainDb: -2,
    estimatedTruePeakDbtp: -1,
  };
}
function allThrowingDependencies(): BrowserDiagnosticsDependencies {
  const throwing = () => {
    throw new Error("diagnostic dependency failed");
  };
  const recorder = fakeRecorder();
  recorder.startSession.mockImplementation(throwing);
  recorder.checkpoint.mockImplementation(throwing);
  recorder.recordProgress.mockImplementation(throwing);
  recorder.finish.mockImplementation(throwing);
  recorder.recordIncident.mockImplementation(throwing);
  recorder.snapshot.mockImplementation(throwing);
  recorder.subscribe.mockImplementation(throwing);
  recorder.exportJson.mockImplementation(throwing);
  recorder.clear.mockImplementation(throwing);
  const dependencies = browserDependencies(recorder);
  return {
    ...dependencies,
    clipboardWrite: vi.fn(async () => {
      throw new Error("clipboard failed");
    }),
    createJsonBlob: throwing,
    createObjectUrl: throwing,
    revokeObjectUrl: throwing,
    createDownloadAnchor: throwing,
    attachDownloadAnchor: throwing,
    confirmClear: throwing,
    defer: throwing,
  };
}

describe("browser diagnostics", () => {
  it.each([
    ["worker-error", "worker-error"],
    ["worker-messageerror", "worker-messageerror"],
    ["wasm-init-failure", "wasm-init-failure"],
  ] as const)(
    "maps %s package events to approved %s checkpoints",
    (eventType, checkpoint) => {
      const recorder = fakeRecorder();
      const diagnostics = createBrowserDiagnostics(
        browserDependencies(recorder),
      );

      diagnostics.handlePackageEvent({
        type: eventType,
        error: { message: "worker failed", unknownErrorSecret: "DROP" },
        unknownSecret: "DROP",
      });

      expect(recorder.checkpoint).toHaveBeenCalledWith(
        checkpoint,
        expect.not.objectContaining({ unknownSecret: expect.anything() }),
      );
      expect(JSON.stringify(recorder.checkpoint.mock.calls)).not.toContain(
        "unknownErrorSecret",
      );
    },
  );

  it("defers package request outcomes to the application completion boundary", () => {
    const recorder = fakeRecorder();
    const diagnostics = createBrowserDiagnostics(browserDependencies(recorder));

    diagnostics.handlePackageEvent({
      type: "request-success",
      outputFrames: 48_000,
      durationSeconds: 1,
    });
    diagnostics.handlePackageEvent({
      type: "request-failure",
      error: { message: "worker failed" },
    });

    expect(recorder.checkpoint).not.toHaveBeenCalled();
    expect(recorder.finish).not.toHaveBeenCalled();
  });

  it("defers worker cancellation cleanup to the application failure boundary", () => {
    const recorder = fakeRecorder();
    const diagnostics = createBrowserDiagnostics(browserDependencies(recorder));

    diagnostics.handlePackageEvent({ type: "worker-cancelled" });

    expect(recorder.finish).not.toHaveBeenCalled();

    diagnostics.finishFailure({ message: "render failed" });

    expect(recorder.finish).toHaveBeenCalledTimes(1);
    expect(recorder.finish).toHaveBeenCalledWith(
      "failed",
      "error",
      expect.objectContaining({ message: "render failed" }),
    );
  });

  it("persists a post-success preview incident without changing terminal status", () => {
    const storage = new BrowserStorage();
    const recorder = actualRecorder(storage);
    const dependencies = browserDependencies(recorder);
    const diagnostics = createBrowserDiagnostics(dependencies);

    diagnostics.startAttempt(validAttempt());
    diagnostics.finishSuccess(validMetadata());
    dependencies.previewTarget.error = { message: "preview decode failed" };
    dependencies.previewTarget.dispatchEvent(new Event("error"));

    const [session] = recorder.snapshot().sessions;
    expect(session).toMatchObject({ status: "succeeded" });
    expect(session?.checkpoints.at(-1)?.type).toBe("audio-error");
    expect(storage.getItem(DIAGNOSTIC_ACTIVE_KEY)).toBeNull();
    expect(JSON.parse(storage.getItem(DIAGNOSTIC_STORE_KEY) ?? "{}"))
      .toMatchObject({
        sessions: [expect.objectContaining({
          status: "succeeded",
          checkpoints: expect.arrayContaining([
            expect.objectContaining({ type: "audio-error" }),
          ]),
        })],
      });
    expect(JSON.parse(recorder.exportJson())).toMatchObject({
      sessions: [expect.objectContaining({ status: "succeeded" })],
    });
  });

  it("persists idle global incidents as one failed incident-only session", () => {
    const storage = new BrowserStorage();
    const recorder = actualRecorder(storage);
    const dependencies = browserDependencies(recorder);
    const diagnostics = createBrowserDiagnostics(dependencies);

    diagnostics.handleWindowError({ message: "idle window failure" });
    diagnostics.handleUnhandledRejection({
      reason: { message: "idle promise failure" },
    });

    const snapshot = recorder.snapshot();
    expect(snapshot.activeSessionId).toBeNull();
    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.sessions[0]).toMatchObject({
      status: "failed",
      app: dependencies.app,
      environment: dependencies.environment,
    });
    expect(snapshot.sessions[0]?.checkpoints.filter(
      (checkpoint) => checkpoint.type === "error",
    )).toHaveLength(2);
    expect(storage.getItem(DIAGNOSTIC_ACTIVE_KEY)).toBeNull();
    const rawStore = JSON.parse(
      storage.getItem(DIAGNOSTIC_STORE_KEY) ?? "{}",
    ) as DiagnosticStore;
    expect(rawStore.sessions[0]).toMatchObject({
      status: "failed",
      app: dependencies.app,
      checkpoints: expect.arrayContaining([
        expect.objectContaining({ type: "error" }),
      ]),
    });
    expect(JSON.parse(recorder.exportJson())).toMatchObject({
      sessions: [expect.objectContaining({
        status: "failed",
        app: dependencies.app,
      })],
    });
  });

  it("keeps later processing successful after incident persistence fails", () => {
    const storage = new BrowserStorage();
    storage.failWrites = true;
    const recorder = actualRecorder(storage);
    const dependencies = browserDependencies(recorder);
    const diagnostics = createBrowserDiagnostics(dependencies);

    expect(() => {
      diagnostics.handleWindowError({ message: "storage write failed" });
      diagnostics.startAttempt(validAttempt());
      diagnostics.finishSuccess(validMetadata());
    }).not.toThrow();

    expect(recorder.snapshot()).toMatchObject({
      storageState: "unavailable",
      sessions: [
        expect.objectContaining({ status: "failed" }),
        expect.objectContaining({ status: "succeeded" }),
      ],
    });
  });
  it("captures window and promise errors without preventing defaults", () => {
    const recorder = fakeRecorder();
    const diagnostics = createBrowserDiagnostics(
      browserDependencies(recorder),
    );

    diagnostics.handleWindowError({
      message: "C:\\private\\secret.wav failed",
      lineno: 9,
      colno: 2,
      error: { stack: "DROP_STACK" },
    });
    diagnostics.handleUnhandledRejection({
      reason: { message: "/private/secret.wav", unknown: "DROP" },
    });

    expect(recorder.recordIncident).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(recorder.recordIncident.mock.calls)).not.toContain(
      "secret.wav",
    );
    expect(JSON.stringify(recorder.recordIncident.mock.calls)).not.toContain(
      "DROP_STACK",
    );
  });

  it("swallows recorder, clipboard, URL, and download failures", async () => {
    const diagnostics = createBrowserDiagnostics(allThrowingDependencies());

    expect(() => diagnostics.startAttempt(validAttempt())).not.toThrow();
    await expect(diagnostics.copy()).resolves.toBe(false);
    expect(() => diagnostics.download()).not.toThrow();
    expect(() => diagnostics.clear()).not.toThrow();
  });

  it("records page lifecycle events and keeps bfcache sessions active", () => {
    const recorder = fakeRecorder();
    const dependencies = browserDependencies(recorder);
    const diagnostics = createBrowserDiagnostics(dependencies);

    const cached = new Event("pagehide");
    Object.defineProperty(cached, "persisted", { value: true });
    dependencies.windowTarget.dispatchEvent(cached);
    expect(recorder.recordIncident).toHaveBeenLastCalledWith(
      "pagehide",
      { persisted: true },
      expect.objectContaining({
        app: dependencies.app,
        environment: dependencies.environment,
      }),
    );
    expect(recorder.finish).not.toHaveBeenCalled();

    const closed = new Event("pagehide");
    Object.defineProperty(closed, "persisted", { value: false });
    dependencies.windowTarget.dispatchEvent(closed);
    expect(recorder.recordIncident).toHaveBeenLastCalledWith(
      "pagehide",
      { persisted: false },
      expect.objectContaining({
        app: dependencies.app,
        environment: dependencies.environment,
      }),
    );
    expect(recorder.finish).toHaveBeenCalledWith(
      "clean-shutdown",
      "clean-shutdown",
    );

    diagnostics.dispose();
    dependencies.windowTarget.dispatchEvent(closed);
    expect(recorder.finish).toHaveBeenCalledTimes(1);
  });

  it("copies and downloads the same formatted recorder export", async () => {
    const recorder = fakeRecorder();
    const dependencies = browserDependencies(recorder);
    const diagnostics = createBrowserDiagnostics(dependencies);

    expect(await diagnostics.copy()).toBe(true);
    diagnostics.download();

    expect(dependencies.clipboardWrite).toHaveBeenCalledWith(
      '{\n  "safe": true\n}\n',
    );
    expect(dependencies.createJsonBlob).toHaveBeenCalledWith(
      '{\n  "safe": true\n}\n',
    );
    expect(recorder.exportJson).toHaveBeenCalledTimes(1);
    expect(dependencies.revokeObjectUrl).toHaveBeenCalledWith(
      "blob:diagnostics",
    );
  });

  it("refreshes the shared export after a recording mutation", async () => {
    const recorder = fakeRecorder();
    const dependencies = browserDependencies(recorder);
    const diagnostics = createBrowserDiagnostics(dependencies);

    await diagnostics.copy();
    recorder.exportJson.mockReturnValue('{"revision":2}\n');
    diagnostics.startAttempt(validAttempt());
    diagnostics.download();

    expect(recorder.exportJson).toHaveBeenCalledTimes(2);
    expect(dependencies.createJsonBlob).toHaveBeenLastCalledWith(
      '{"revision":2}\n',
    );
  });

  it.each([
    ["active", "progress-stage", false],
    ["unexpected-termination", "unexpected-termination", true],
    ["succeeded", "success", false],
  ] as const)(
    "renders %s latest-session status, boundary, and updated time",
    (status, boundary, recovered) => {
      const updatedAt = "2026-07-23T20:00:03.000Z";
      const snapshot: DiagnosticSnapshot = {
        ...emptySnapshot(),
        activeSessionId: status === "active" ? "summary-session" : null,
        recoveredSessionId: recovered ? "summary-session" : null,
        sessions: [{
          schemaVersion: 1,
          id: "summary-session",
          startedAt: "2026-07-23T20:00:00.000Z",
          updatedAt,
          status,
          app: { version: "0.1.0", buildCommit: "test" },
          environment: null,
          checkpoints: [{
            sequence: 0,
            type: boundary,
            timestamp: updatedAt,
            elapsedMs: 3,
            details: {},
          }],
          droppedCheckpoints: 0,
        }],
      };
      const dependencies = browserDependencies(fakeRecorder(snapshot));

      createBrowserDiagnostics(dependencies);

      expect(dependencies.ui.summary.textContent).toContain(status);
      expect(dependencies.ui.summary.textContent).toContain(
        `last boundary ${boundary}`,
      );
      expect(dependencies.ui.summary.textContent).toContain(
        `updated ${updatedAt}`,
      );
      expect(dependencies.ui.summary.textContent?.length).toBeLessThan(300);
    },
  );
  it("renders recovery, storage, summaries, clipboard support, and confirmed clear", () => {
    const recovered = {
      ...emptySnapshot(),
      storageState: "quota-exceeded" as const,
      recoveredSessionId: "recovered",
      sessions: [
        {
          schemaVersion: 1 as const,
          id: "recovered",
          startedAt: "2026-07-23T20:00:00.000Z",
          updatedAt: "2026-07-23T20:00:03.000Z",
          status: "unexpected-termination" as const,
          app: { version: "0.1.0", buildCommit: "test" },
          environment: null,
          checkpoints: [],
          droppedCheckpoints: 0,
        },
      ],
    };
    const recorder = fakeRecorder(recovered);
    const dependencies = browserDependencies(recorder);
    const diagnostics = createBrowserDiagnostics(dependencies);

    expect(dependencies.ui.storage.textContent).toMatch(/quota|current tab/i);
    expect(dependencies.ui.recovered.hidden).toBe(false);
    expect(dependencies.ui.summary.textContent).toContain(
      "unexpected-termination",
    );
    expect(dependencies.ui.copy.hidden).toBe(false);

    dependencies.ui.clear.dispatchEvent(new Event("click"));
    expect(dependencies.confirmClear).toHaveBeenCalledWith(
      "Clear all crash diagnostics stored by convolve-wasm on this device?",
    );
    expect(recorder.clear).toHaveBeenCalledOnce();
    diagnostics.showFailureAction(true);
    expect(dependencies.ui.failureDownload.hidden).toBe(false);
  });

  it.each([
    [1, "MEDIA_ERR_ABORTED"],
    [2, "MEDIA_ERR_NETWORK"],
    [3, "MEDIA_ERR_DECODE"],
    [4, "MEDIA_ERR_SRC_NOT_SUPPORTED"],
  ] as const)(
    "maps prototype-backed MediaError code %s to %s",
    (numericCode, category) => {
      const recorder = fakeRecorder();
      const dependencies = browserDependencies(recorder);
      createBrowserDiagnostics(dependencies);
      dependencies.previewTarget.error = Object.create({
        code: numericCode,
        message: "decoder rejected preview",
        privateField: "DROP",
      });

      dependencies.previewTarget.dispatchEvent(new Event("error"));

      expect(recorder.recordIncident).toHaveBeenLastCalledWith(
        "audio-error",
        {
          error: {
            source: "audio",
            code: category,
            message: "decoder rejected preview",
          },
        },
        expect.any(Object),
      );
      expect(JSON.stringify(recorder.recordIncident.mock.calls)).not.toContain(
        "privateField",
      );
    },
  );

  it("isolates hostile MediaError accessors", () => {
    const recorder = fakeRecorder();
    const dependencies = browserDependencies(recorder);
    createBrowserDiagnostics(dependencies);
    const hostilePrototype = Object.defineProperties({}, {
      code: {
        get() {
          throw new Error("PRIVATE_CODE_ACCESSOR");
        },
      },
      message: {
        get() {
          throw new Error("PRIVATE_MESSAGE_ACCESSOR");
        },
      },
    });
    dependencies.previewTarget.error = Object.create(hostilePrototype);

    expect(() => {
      dependencies.previewTarget.dispatchEvent(new Event("error"));
    }).not.toThrow();
    expect(recorder.recordIncident).toHaveBeenLastCalledWith(
      "audio-error",
      { error: { source: "audio" } },
      expect.any(Object),
    );
    expect(JSON.stringify(recorder.recordIncident.mock.calls)).not.toContain(
      "PRIVATE_",
    );
  });
  it("maps attempt, progress, metadata, and audio failures through fresh allowlists", () => {
    const recorder = fakeRecorder();
    const dependencies = browserDependencies(recorder);
    const diagnostics = createBrowserDiagnostics(dependencies);

    diagnostics.startAttempt(validAttempt());
    diagnostics.recordProgress({ stage: "decode-a", fraction: 0.1 });
    diagnostics.previewAssigned(1_024);
    diagnostics.finishSuccess({
      sampleRate: 48_000,
      channels: 2,
      durationSeconds: 1,
      outputFrames: 48_000,
      detectedBeats: 1,
      detectedBpm: 120,
      beatConfidence: 0.9,
      appliedGainDb: -2,
      estimatedTruePeakDbtp: -1,
    });

    expect(recorder.startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        app: { version: "0.1.0", buildCommit: "test-build" },
        inputs: validAttempt().inputs,
        options: validAttempt().options,
      }),
    );
    expect(recorder.recordProgress).toHaveBeenCalledWith({
      stage: "decode-a",
      fraction: 0.1,
    });
    expect(recorder.checkpoint).toHaveBeenCalledWith(
      "preview-assigned",
      { wavBytes: 1_024 },
    );
    expect(recorder.finish).toHaveBeenCalledWith(
      "succeeded",
      "success",
      expect.objectContaining({ outputFrames: 48_000 }),
    );

    dependencies.previewTarget.error = {
      code: 3,
      message: "C:\\private\\preview.wav",
      secret: "DROP",
    };
    dependencies.previewTarget.dispatchEvent(new Event("error"));
    expect(recorder.recordIncident).toHaveBeenCalledWith(
      "audio-error",
      expect.not.objectContaining({ secret: expect.anything() }),
      expect.objectContaining({
        app: dependencies.app,
        environment: dependencies.environment,
      }),
    );
    expect(JSON.stringify(recorder.recordIncident.mock.calls)).not.toContain(
      "preview.wav",
    );
  });
});
