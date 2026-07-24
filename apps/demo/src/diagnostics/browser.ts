import type {
  ConvolveMetadata,
  ConvolveProgress,
} from "@takana-labs/convolve-wasm";

import type {
  DiagnosticCheckpointType,
  DiagnosticEnvironment,
  DiagnosticSessionStatus,
} from "./model";
import {
  copyEnvironment,
  copyInputs,
  copyOptions,
  field,
  finite,
  mapMediaError,
  nonNegative,
  numberField,
  positive,
  safeMetaText,
  stringField,
  type BrowserAttemptInput,
} from "./browser-mappers";
import {
  setHidden,
  setText,
  storageMessage,
  summaryMessage,
  type TextElement,
} from "./browser-ui";
import {
  DiagnosticRecorder,
  type DiagnosticSnapshot,
  type IncidentContext,
  type StartSessionInput,
} from "./recorder";
import {
  sanitizeCheckpointDetails,
  sanitizeEnvironmentText,
  sanitizePlatformText,
  sanitizeError,
} from "./sanitize";

const PACKAGE_EVENT_NAME = "convolve-wasm:diagnostic";
const CLEAR_CONFIRMATION =
  "Clear all crash diagnostics stored by convolve-wasm on this device?";
const DOWNLOAD_NAME = "convolve-wasm-diagnostics.json";

export type { BrowserAttemptInput } from "./browser-mappers";

export interface BrowserDiagnostics {
  startAttempt(input: BrowserAttemptInput): void;
  recordProgress(event: ConvolveProgress): void;
  previewAssigned(wavBytes: number): void;
  finishSuccess(metadata: ConvolveMetadata): void;
  finishFailure(error: unknown): void;
  download(): void;
  copy(): Promise<boolean>;
  clear(): void;
  showFailureAction(visible: boolean): void;
  handlePackageEvent(value: unknown): void;
  handleWindowError(value: unknown): void;
  handleUnhandledRejection(value: unknown): void;
  dispose(): void;
}

export interface BrowserDiagnosticRecorder {
  startSession(input: StartSessionInput): string | void;
  checkpoint(type: DiagnosticCheckpointType, details?: unknown): void;
  recordProgress(event: ConvolveProgress): void;
  finish(
    status: Exclude<
      DiagnosticSessionStatus,
      "active" | "unexpected-termination"
    >,
    type: DiagnosticCheckpointType,
    details?: unknown,
  ): void;
  recordIncident(
    type: DiagnosticCheckpointType,
    details: unknown,
    context?: IncidentContext,
  ): void;
  snapshot(): DiagnosticSnapshot;
  subscribe(listener: (snapshot: DiagnosticSnapshot) => void): () => void;
  exportJson(): string;
  clear(): void;
}


interface DownloadAnchor {
  href: string;
  download: string;
  click(): void;
  remove(): void;
}

export interface BrowserDiagnosticsDependencies {
  recorder: BrowserDiagnosticRecorder;
  windowTarget: EventTarget;
  documentTarget: EventTarget;
  previewTarget: EventTarget;
  app: { version: string; buildCommit: string };
  environment: DiagnosticEnvironment;
  clipboardWrite: ((text: string) => Promise<void>) | null;
  createJsonBlob(text: string): Blob;
  createObjectUrl(blob: Blob): string;
  revokeObjectUrl(url: string): void;
  createDownloadAnchor(): DownloadAnchor;
  attachDownloadAnchor(anchor: DownloadAnchor): void;
  confirmClear(message: string): boolean;
  defer(task: () => void): void;
  ui: {
    storage: TextElement | null;
    recovered: TextElement | null;
    summary: TextElement | null;
    download: TextElement | null;
    copy: TextElement | null;
    clear: TextElement | null;
    failureDownload: TextElement | null;
  };
}

export function createBrowserDiagnostics(
  providedDependencies?: BrowserDiagnosticsDependencies,
): BrowserDiagnostics {
  const dependencies = providedDependencies ?? defaultDependencies();
  const cleanup: Array<() => void> = [];
  let unsubscribe = () => {};
  let cachedExport: string | null = null;

  const callRecorder = (operation: () => void): void => {
    cachedExport = null;
    try {
      operation();
    } catch {
      // Diagnostics must never alter application behavior.
    }
  };

  const recordIncident = (
    type: DiagnosticCheckpointType,
    details: unknown,
  ): void => {
    callRecorder(() => {
      dependencies.recorder.recordIncident(type, details, {
        app: {
          version: safeMetaText(field(dependencies.app, "version")),
          buildCommit: safeMetaText(field(dependencies.app, "buildCommit")),
        },
        environment: copyEnvironment(dependencies.environment),
      });
    });
  };
  const render = (snapshot: DiagnosticSnapshot): void => {
    cachedExport = null;
    setText(
      dependencies.ui.storage,
      storageMessage(snapshot.storageState),
    );
    setHidden(
      dependencies.ui.recovered,
      snapshot.recoveredSessionId === null,
    );
    setText(dependencies.ui.summary, summaryMessage(snapshot));
  };

  const exportPayload = (): string | null => {
    if (cachedExport !== null) return cachedExport;
    try {
      const value = dependencies.recorder.exportJson();
      if (typeof value !== "string") return null;
      cachedExport = value;
      return cachedExport;
    } catch {
      return null;
    }
  };

  const download = (): void => {
    let anchor: DownloadAnchor | null = null;
    let objectUrl: string | null = null;
    try {
      const payload = exportPayload();
      if (payload === null) return;
      const blob = dependencies.createJsonBlob(payload);
      objectUrl = dependencies.createObjectUrl(blob);
      anchor = dependencies.createDownloadAnchor();
      anchor.href = objectUrl;
      anchor.download = DOWNLOAD_NAME;
      dependencies.attachDownloadAnchor(anchor);
      anchor.click();
    } catch {
      // Export controls remain optional and cannot affect processing.
    } finally {
      try {
        anchor?.remove();
      } catch {
        // Removal is best effort.
      }
      if (objectUrl !== null) {
        const url = objectUrl;
        try {
          dependencies.defer(() => {
            try {
              dependencies.revokeObjectUrl(url);
            } catch {
              // Blob URL cleanup is best effort.
            }
          });
        } catch {
          // A failed scheduler must not surface through diagnostics.
        }
      }
    }
  };

  const copy = async (): Promise<boolean> => {
    try {
      const payload = exportPayload();
      if (payload === null || dependencies.clipboardWrite === null) {
        return false;
      }
      await dependencies.clipboardWrite(payload);
      return true;
    } catch {
      return false;
    }
  };

  const clear = (): void => {
    try {
      if (!dependencies.confirmClear(CLEAR_CONFIRMATION)) return;
    } catch {
      return;
    }
    cachedExport = null;
    callRecorder(() => dependencies.recorder.clear());
  };

  const handlePackageEvent = (value: unknown): void => {
    cachedExport = null;
    try {
      const type = field(value, "type");
      switch (type) {
        case "decode-start":
        case "decode-success":
        case "decode-failure":
        case "options":
        case "memory-plan":
        case "worker-created":
        case "worker-error":
        case "worker-messageerror":
        case "wasm-init-start":
        case "wasm-init-success":
        case "wasm-init-failure":
        case "output-start":
        case "output-milestone":
        case "blob-complete":
          checkpointPackageEvent(type, value, dependencies.recorder);
          return;
        case "request-success":
        case "request-failure":
        case "worker-cancelled":
          return;
        default:
          return;
      }
    } catch {
      // Hostile or malformed package events are ignored.
    }
  };

  const handleWindowError = (value: unknown): void => {
    const nestedError = field(value, "error");
    const mapped = sanitizeError({
      name: field(nestedError, "name"),
      code: field(nestedError, "code"),
      message:
        stringField(value, "message") ??
        stringField(nestedError, "message") ??
        "",
      line: numberField(value, "lineno"),
      column: numberField(value, "colno"),
      details: field(nestedError, "details"),
    }, "window");
    recordIncident("error", mapped);
  };

  const handleUnhandledRejection = (value: unknown): void => {
    const reason = field(value, "reason");
    const mapped = sanitizeError(
      typeof reason === "string" ? { message: reason } : reason,
      "promise",
    );
    recordIncident("error", mapped);
  };

  const handleVisibility = (): void => {
    const state = field(dependencies.documentTarget, "visibilityState");
    recordIncident(
      "visibility",
      { state: state === "hidden" ? "hidden" : "visible" },
    );
  };

  const handlePageHide = (value: unknown): void => {
    const persisted = field(value, "persisted") === true;
    recordIncident("pagehide", { persisted });

    if (!persisted) {
      callRecorder(() => {
        dependencies.recorder.finish(
          "clean-shutdown",
          "clean-shutdown",
        );
      });
    }
  };

  const handleAudioError = (): void => {
    const mapped = mapMediaError(field(dependencies.previewTarget, "error"));
    recordIncident(
      "audio-error",
      { error: mapped },
    );
  };

  safeListen(
    dependencies.windowTarget,
    PACKAGE_EVENT_NAME,
    (event) => handlePackageEvent(field(event, "detail")),
    cleanup,
  );
  safeListen(
    dependencies.windowTarget,
    "error",
    handleWindowError,
    cleanup,
  );
  safeListen(
    dependencies.windowTarget,
    "unhandledrejection",
    handleUnhandledRejection,
    cleanup,
  );
  safeListen(
    dependencies.documentTarget,
    "visibilitychange",
    handleVisibility,
    cleanup,
  );
  safeListen(
    dependencies.windowTarget,
    "pagehide",
    handlePageHide,
    cleanup,
  );
  safeListen(
    dependencies.previewTarget,
    "error",
    handleAudioError,
    cleanup,
  );
  safeListen(dependencies.ui.download, "click", download, cleanup);
  safeListen(dependencies.ui.failureDownload, "click", download, cleanup);
  safeListen(dependencies.ui.copy, "click", () => {
    void copy();
  }, cleanup);
  safeListen(dependencies.ui.clear, "click", clear, cleanup);

  setHidden(dependencies.ui.copy, dependencies.clipboardWrite === null);
  setHidden(dependencies.ui.failureDownload, true);
  try {
    render(dependencies.recorder.snapshot());
  } catch {
    setText(
      dependencies.ui.storage,
      "Diagnostics are unavailable; audio processing is unaffected.",
    );
  }
  try {
    unsubscribe = dependencies.recorder.subscribe(render);
  } catch {
    // The initial snapshot still provides a useful best-effort display.
  }

  return {
    startAttempt(input) {
      callRecorder(() => {
        dependencies.recorder.startSession({
          app: {
            version: safeMetaText(dependencies.app.version),
            buildCommit: safeMetaText(dependencies.app.buildCommit),
          },
          environment: copyEnvironment(dependencies.environment),
          inputs: copyInputs(field(input, "inputs")),
          options: copyOptions(field(input, "options")),
        });
      });
    },
    recordProgress(event) {
      const stage = field(event, "stage");
      const fraction = finite(field(event, "fraction"));
      if (typeof stage !== "string" || fraction === null) return;
      callRecorder(() => {
        dependencies.recorder.recordProgress({
          stage: stage as ConvolveProgress["stage"],
          fraction,
        });
      });
    },
    previewAssigned(wavBytes) {
      const safeBytes = nonNegative(wavBytes);
      callRecorder(() => {
        dependencies.recorder.checkpoint(
          "preview-assigned",
          safeBytes === null ? {} : { wavBytes: safeBytes },
        );
      });
    },
    finishSuccess(metadata) {
      callRecorder(() => {
        dependencies.recorder.finish(
          "succeeded",
          "success",
          sanitizeCheckpointDetails("success", metadata),
        );
      });
    },
    finishFailure(error) {
      callRecorder(() => {
        dependencies.recorder.finish(
          "failed",
          "error",
          sanitizeError(error, "processing"),
        );
      });
    },
    download,
    copy,
    clear,
    showFailureAction(visible) {
      setHidden(dependencies.ui.failureDownload, visible !== true);
    },
    handlePackageEvent,
    handleWindowError,
    handleUnhandledRejection,
    dispose() {
      for (const remove of cleanup.splice(0)) {
        try {
          remove();
        } catch {
          // Listener cleanup is best effort.
        }
      }
      try {
        unsubscribe();
      } catch {
        // Recorder cleanup is best effort.
      }
      unsubscribe = () => {};
    },
  };
}

function checkpointPackageEvent(
  type: Exclude<
    string,
    "request-success" | "request-failure" | "worker-cancelled"
  >,
  value: unknown,
  recorder: BrowserDiagnosticRecorder,
): void {
  const checkpoint = type as DiagnosticCheckpointType;
  try {
    recorder.checkpoint(
      checkpoint,
      sanitizeCheckpointDetails(checkpoint, value),
    );
  } catch {
    // Package diagnostics are observational only.
  }
}

function safeListen(
  target: EventTarget | null,
  type: string,
  listener: (event: unknown) => void,
  cleanup: Array<() => void>,
): void {
  if (target === null) return;
  const eventListener: EventListener = (event) => {
    try {
      listener(event);
    } catch {
      // Event observation never changes event defaults or propagation.
    }
  };
  try {
    target.addEventListener(type, eventListener);
    cleanup.push(() => {
      try {
        target.removeEventListener(type, eventListener);
      } catch {
        // Listener removal is best effort.
      }
    });
  } catch {
    // Missing or throwing EventTarget implementations are ignored.
  }
}

function defaultDependencies(): BrowserDiagnosticsDependencies {
  const clipboardWrite = clipboardWriter();
  const environment = browserEnvironment(clipboardWrite !== null);
  const recorder = new DiagnosticRecorder({
    getStorage: () => window.localStorage,
    now: () => new Date(),
    monotonicNow: () => performance.now(),
    id: () => globalThis.crypto.randomUUID(),
    defer: (task) => {
      window.setTimeout(task, 0);
    },
  });

  return {
    recorder,
    windowTarget: window,
    documentTarget: document,
    previewTarget: requiredOrFallback("#preview"),
    app: {
      version: metaContent("convolve-version"),
      buildCommit: metaContent("convolve-build"),
    },
    environment,
    clipboardWrite,
    createJsonBlob: (text) =>
      new Blob([text], { type: "application/json;charset=utf-8" }),
    createObjectUrl: (blob) => URL.createObjectURL(blob),
    revokeObjectUrl: (url) => URL.revokeObjectURL(url),
    createDownloadAnchor: () => document.createElement("a"),
    attachDownloadAnchor: (anchor) => {
      document.body.append(anchor as HTMLAnchorElement);
    },
    confirmClear: (message) => window.confirm(message),
    defer: (task) => {
      window.setTimeout(task, 0);
    },
    ui: {
      storage: optionalElement("#diagnostics-storage"),
      recovered: optionalElement("#diagnostics-recovered"),
      summary: optionalElement("#diagnostics-summary"),
      download: optionalElement("#diagnostics-download"),
      copy: optionalElement("#diagnostics-copy"),
      clear: optionalElement("#diagnostics-clear"),
      failureDownload: optionalElement("#failure-diagnostics-download"),
    },
  };
}

function metaContent(name: string): string {
  try {
    const meta = document.querySelector<HTMLMetaElement>(
      `meta[name="${name}"]`,
    );
    return safeMetaText(meta?.content);
  } catch {
    return "";
  }
}

function optionalElement(selector: string): TextElement | null {
  try {
    return document.querySelector<HTMLElement>(selector);
  } catch {
    return null;
  }
}

function requiredOrFallback(selector: string): EventTarget {
  try {
    return document.querySelector<Element>(selector) ?? new EventTarget();
  } catch {
    return new EventTarget();
  }
}

function clipboardWriter(): ((text: string) => Promise<void>) | null {
  try {
    const clipboard = navigator.clipboard;
    const writer = clipboard?.writeText;
    if (typeof writer !== "function") return null;
    return (text) => Reflect.apply(writer, clipboard, [text]) as Promise<void>;
  } catch {
    return null;
  }
}

function browserEnvironment(clipboard: boolean): DiagnosticEnvironment {
  const navigatorValue = navigator as Navigator & {
    deviceMemory?: unknown;
    userAgentData?: { platform?: unknown };
  };
  const userAgentData = field(navigatorValue, "userAgentData");
  const modernPlatform = field(userAgentData, "platform");
  const legacyPlatform = field(navigatorValue, "platform");
  return {
    userAgent: sanitizeEnvironmentText(field(navigatorValue, "userAgent")),
    platform: sanitizePlatformText(
      typeof modernPlatform === "string" ? modernPlatform : legacyPlatform,
    ),
    deviceMemoryGiB: positive(field(navigatorValue, "deviceMemory")),
    hardwareConcurrency: positive(
      field(navigatorValue, "hardwareConcurrency"),
    ),
    capabilities: {
      webAssembly: globalCapability("WebAssembly"),
      worker: globalCapability("Worker"),
      offlineAudioContext:
        globalCapability("OfflineAudioContext") ||
        globalCapability("webkitOfflineAudioContext"),
      readableStream: globalCapability("ReadableStream"),
      responseBlob: responseBlobCapability(),
      randomUUID: randomUuidCapability(),
      localStorage: localStorageCapability(),
      clipboard,
    },
  };
}

function globalCapability(name: string): boolean {
  try {
    return typeof Reflect.get(globalThis, name) !== "undefined";
  } catch {
    return false;
  }
}

function responseBlobCapability(): boolean {
  try {
    return typeof Response === "function" &&
      typeof Response.prototype.blob === "function";
  } catch {
    return false;
  }
}

function randomUuidCapability(): boolean {
  try {
    return typeof globalThis.crypto?.randomUUID === "function";
  } catch {
    return false;
  }
}

function localStorageCapability(): boolean {
  try {
    return window.localStorage !== null;
  } catch {
    return false;
  }
}
